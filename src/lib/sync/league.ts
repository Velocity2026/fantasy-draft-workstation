import { prisma } from '../db';
import { sleeper, type SleeperLeague } from '../providers/sleeper';
import { deriveScoringFormat, getConfig, setConfig } from '../config';
import { writeJson } from '../json';
import { withSyncRun, type SyncResult } from './runner';

/**
 * Import a Sleeper league: settings, managers, rosters and transactions.
 *
 * Rosters are written twice — once as current state (LeagueRoster, upserted)
 * and once as an append-only weekly snapshot (RosterSnapshot). The snapshot is
 * what makes "what did this roster look like when they made that waiver claim"
 * answerable in Phase 9+, and it costs almost nothing now.
 */
export async function syncLeague(leagueId: string, opts: { markPrimary?: boolean } = {}): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'league' }, async () => {
    const [league, users, rosters, state] = await Promise.all([
      sleeper.getLeague(leagueId),
      sleeper.getUsers(leagueId),
      sleeper.getRosters(leagueId),
      sleeper.getState().catch(() => null),
    ]);

    await upsertLeague(league, opts.markPrimary ?? false);

    // Managers
    const cfg = await getConfig();
    const myUsername = cfg.sleeperUsername?.toLowerCase() ?? null;
    const memberIdByUserId = new Map<string, string>();

    for (const u of users) {
      const isMe = myUsername
        ? u.username?.toLowerCase() === myUsername || u.display_name?.toLowerCase() === myUsername
        : false;
      const member = await prisma.leagueMember.upsert({
        where: { leagueId_sleeperUserId: { leagueId, sleeperUserId: u.user_id } },
        create: {
          leagueId,
          sleeperUserId: u.user_id,
          displayName: u.display_name || u.username || u.user_id,
          teamName: (u.metadata?.team_name as string | undefined) ?? null,
          avatar: u.avatar,
          isMe,
        },
        update: {
          displayName: u.display_name || u.username || u.user_id,
          teamName: (u.metadata?.team_name as string | undefined) ?? null,
          avatar: u.avatar,
          // Only ever *set* isMe from a username match; never unset a manual choice.
          ...(isMe ? { isMe: true } : {}),
        },
      });
      memberIdByUserId.set(u.user_id, member.id);
    }

    // Rosters — current state plus an append-only snapshot.
    const week = state?.week ?? 0;
    for (const r of rosters) {
      const memberId = r.owner_id ? (memberIdByUserId.get(r.owner_id) ?? null) : null;
      const playerIdsJson = writeJson(r.players ?? []) ?? '[]';

      await prisma.leagueRoster.upsert({
        where: { leagueId_rosterId: { leagueId, rosterId: r.roster_id } },
        create: {
          leagueId,
          rosterId: r.roster_id,
          memberId,
          playerIdsJson,
          startersJson: writeJson(r.starters ?? []),
          reserveJson: writeJson(r.reserve ?? []),
          taxiJson: writeJson(r.taxi ?? []),
          settingsJson: writeJson(r.settings ?? {}),
        },
        update: {
          memberId,
          playerIdsJson,
          startersJson: writeJson(r.starters ?? []),
          reserveJson: writeJson(r.reserve ?? []),
          taxiJson: writeJson(r.taxi ?? []),
          settingsJson: writeJson(r.settings ?? {}),
        },
      });

      await prisma.rosterSnapshot.create({
        data: {
          leagueId,
          rosterId: r.roster_id,
          season: league.season,
          week,
          playerIdsJson,
          startersJson: writeJson(r.starters ?? []),
          reserveJson: writeJson(r.reserve ?? []),
          settingsJson: writeJson(r.settings ?? {}),
        },
      });
    }

    // If we still don't know which roster is mine, leave it — the Settings page
    // asks explicitly. Guessing the wrong roster is worse than not guessing.
    if (opts.markPrimary) {
      await setConfig({ leagueId, season: league.season });
    }

    return {
      recordsIn: users.length + rosters.length,
      recordsWritten: users.length + rosters.length * 2,
      detail: { season: league.season, status: league.status, rosters: rosters.length },
    };
  });
}

async function upsertLeague(league: SleeperLeague, markPrimary: boolean) {
  const scoring = league.scoring_settings ?? {};
  const data = {
    name: league.name,
    season: league.season,
    sport: league.sport ?? 'nfl',
    status: league.status,
    totalRosters: league.total_rosters,
    scoringType: deriveScoringFormat(scoring),
    // Sleeper exposes keeper intent through settings.max_keepers.
    isKeeper: (league.settings?.max_keepers ?? 0) > 0 || (league.settings?.type ?? 0) === 2,
    avatar: league.avatar,
    previousLeagueId: league.previous_league_id,
    settingsJson: writeJson(league.settings ?? {}),
    scoringJson: writeJson(scoring),
    rosterPositionsJson: writeJson(league.roster_positions ?? []),
    metadataJson: writeJson(league.metadata ?? {}),
    syncedAt: new Date(),
  };

  if (markPrimary) {
    await prisma.league.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
  }

  await prisma.league.upsert({
    where: { id: league.league_id },
    create: { id: league.league_id, ...data, isPrimary: markPrimary },
    update: { ...data, ...(markPrimary ? { isPrimary: true } : {}) },
  });
}

/**
 * Transactions for a week range. Draft-phase this backfills prior seasons for
 * manager tendency modelling; in-season (Phase 9) the same function runs on a
 * schedule against the current week.
 */
export async function syncTransactions(
  leagueId: string,
  season: string,
  weeks: number[],
): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'transactions', season }, async () => {
    const members = await prisma.leagueMember.findMany({ where: { leagueId } });
    const memberByUserId = new Map(members.map((m) => [m.sleeperUserId, m.id]));

    let seen = 0;
    let written = 0;

    for (const week of weeks) {
      const txns = await sleeper.getTransactions(leagueId, week);
      seen += txns.length;

      for (const t of txns) {
        const data = {
          leagueId,
          type: t.type,
          status: t.status,
          season,
          week,
          leg: t.leg,
          creatorMemberId: t.creator ? (memberByUserId.get(t.creator) ?? null) : null,
          rosterIdsJson: writeJson(t.roster_ids ?? []),
          addsJson: writeJson(t.adds),
          dropsJson: writeJson(t.drops),
          draftPicksJson: writeJson(t.draft_picks ?? []),
          waiverBid: extractWaiverBid(t.settings),
          settingsJson: writeJson(t.settings ?? {}),
          createdAtMs: t.created ? BigInt(t.created) : null,
        };
        await prisma.leagueTransaction.upsert({
          where: { id: t.transaction_id },
          create: { id: t.transaction_id, ...data },
          update: data,
        });
        written += 1;
      }
    }

    return { recordsIn: seen, recordsWritten: written, detail: { weeks } };
  });
}

function extractWaiverBid(settings: Record<string, number> | null): number | null {
  if (!settings) return null;
  return settings.waiver_bid ?? null;
}

/**
 * Weekly matchups → LineupSnapshot. Not called during the draft phase; wired up
 * now so Phase 11 (start/sit hindsight) has data from week 1 rather than from
 * whenever the module gets written.
 */
export async function syncLineups(leagueId: string, season: string, week: number): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'lineups', season, week }, async () => {
    const matchups = await sleeper.getMatchups(leagueId, week);
    for (const m of matchups) {
      const starters = m.starters ?? [];
      const bench = (m.players ?? []).filter((p) => !starters.includes(p));
      await prisma.lineupSnapshot.create({
        data: {
          leagueId,
          rosterId: m.roster_id,
          season,
          week,
          matchupId: m.matchup_id,
          startersJson: writeJson(starters) ?? '[]',
          benchJson: writeJson(bench),
          playerPointsJson: writeJson(m.players_points ?? {}),
          totalPoints: m.points,
        },
      });
    }
    return { recordsIn: matchups.length, recordsWritten: matchups.length };
  });
}
