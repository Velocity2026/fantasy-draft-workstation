import { prisma } from '../db';
import { sleeper } from '../providers/sleeper';
import { syncLeague } from './league';
import { syncDrafts } from './draft';
import { leagueChain } from './market';
import { syncDraftPicks } from './draft';
import { withSyncRun, type SyncResult } from './runner';
import { writeJson } from '../json';
import { mean } from '../utils';

/**
 * Walk this league's season chain and import every prior season's league,
 * managers and draft. This is what turns "10 random managers" into a model of
 * how these specific ten people draft.
 */
export async function syncHistory(leagueId: string): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'history' }, async () => {
    // Ensure the current league exists so the chain walk has a starting row.
    const exists = await prisma.league.findUnique({ where: { id: leagueId } });
    if (!exists) await syncLeague(leagueId, { markPrimary: true });

    const visited: string[] = [];
    let current: string | null = leagueId;
    let drafts = 0;

    for (let depth = 0; depth < 12 && current; depth += 1) {
      if (visited.includes(current)) break;
      visited.push(current);

      if (current !== leagueId) {
        await syncLeague(current);
      }
      await syncDrafts(current);

      const leagueDrafts = await prisma.draft.findMany({ where: { leagueId: current } });
      for (const d of leagueDrafts) {
        await syncDraftPicks(d.id);
        drafts += 1;
      }

      const row: { previousLeagueId: string | null } | null = await prisma.league.findUnique({
        where: { id: current },
        select: { previousLeagueId: true },
      });
      current = row?.previousLeagueId || null;
      if (current === '0') current = null;
    }

    return {
      recordsIn: visited.length,
      recordsWritten: drafts,
      detail: { seasonsImported: visited.length, draftsImported: drafts, leagueIds: visited },
    };
  });
}

/**
 * Build a behavioural profile for each manager from their draft history.
 *
 * The useful outputs for draft day are:
 *   - avgReachVsAdp : do they take players before or after market price?
 *   - qbTendency / teTendency : when do they address the thin positions?
 *   - rbShareEarly / wrShareEarly : what do their first four picks look like?
 *   - predictabilityR2 : how much to trust an ADP-based prediction of them.
 *
 * The in-season columns (waiver aggression, FAAB burn, trade frequency) are
 * left null here and filled by the Phase 9+ transaction sync — same table, no
 * migration.
 */
export async function computeManagerProfiles(leagueId: string, season?: string): Promise<SyncResult> {
  return withSyncRun({ provider: 'internal', job: 'manager-profiles', season }, async () => {
    const leagueIds = await leagueChain(leagueId);
    const members = await prisma.leagueMember.findMany({ where: { leagueId } });

    // Managers persist across seasons under the same Sleeper user id, but each
    // season's league has its own LeagueMember row. Group by sleeperUserId so a
    // manager's history follows them.
    const allMembers = await prisma.leagueMember.findMany({ where: { leagueId: { in: leagueIds } } });
    const memberIdsByUser = new Map<string, string[]>();
    for (const m of allMembers) {
      const list = memberIdsByUser.get(m.sleeperUserId) ?? [];
      list.push(m.id);
      memberIdsByUser.set(m.sleeperUserId, list);
    }

    const drafts = await prisma.draft.findMany({
      where: { leagueId: { in: leagueIds }, status: 'complete' },
      select: { id: true, season: true, teams: true },
    });
    const draftIds = drafts.map((d) => d.id);
    const draftById = new Map(drafts.map((d) => [d.id, d]));

    if (!draftIds.length) {
      return { recordsIn: members.length, recordsWritten: 0, detail: { reason: 'no completed drafts' } };
    }

    const picks = await prisma.draftPick.findMany({
      where: { draftId: { in: draftIds }, playerId: { not: null }, isKeeper: false },
      select: { draftId: true, memberId: true, pickNo: true, round: true, playerId: true },
    });

    // ADP within each historical draft = the pick number itself across seasons.
    // For reach-vs-ADP we compare a pick to the *consensus* of where that player
    // went in that same season across the chain; with one league that reduces to
    // comparing against our derived ADP snapshot.
    const adpRows = await prisma.adpSnapshot.findMany({
      where: { source: 'league-history' },
      orderBy: { capturedAt: 'desc' },
    });
    const adpByPlayer = new Map<string, number>();
    for (const r of adpRows) if (!adpByPlayer.has(r.playerId)) adpByPlayer.set(r.playerId, r.adp);

    const playerPositions = new Map(
      (
        await prisma.player.findMany({
          where: { id: { in: [...new Set(picks.map((p) => p.playerId!))] } },
          select: { id: true, position: true, teamId: true },
        })
      ).map((p) => [p.id, p]),
    );

    let written = 0;

    for (const member of members) {
      const memberIds = new Set(memberIdsByUser.get(member.sleeperUserId) ?? [member.id]);
      const mine = picks.filter((p) => p.memberId && memberIds.has(p.memberId));
      if (!mine.length) continue;

      const reaches: number[] = [];
      const qbRounds: number[] = [];
      const teRounds: number[] = [];
      let earlyRb = 0;
      let earlyWr = 0;
      let earlyTotal = 0;
      const teamCounts = new Map<string, number>();

      for (const pick of mine) {
        const player = playerPositions.get(pick.playerId!);
        if (!player) continue;
        const adp = adpByPlayer.get(pick.playerId!);
        // Negative = took him later than market (value); positive = reached.
        if (adp !== undefined) reaches.push(adp - pick.pickNo);

        if (player.position === 'QB') qbRounds.push(pick.round);
        if (player.position === 'TE') teRounds.push(pick.round);

        const teams = draftById.get(pick.draftId)?.teams || 10;
        const isEarly = pick.pickNo <= teams * 4;
        if (isEarly) {
          earlyTotal += 1;
          if (player.position === 'RB') earlyRb += 1;
          if (player.position === 'WR') earlyWr += 1;
        }
        if (player.teamId) teamCounts.set(player.teamId, (teamCounts.get(player.teamId) ?? 0) + 1);
      }

      const avgQbRound = qbRounds.length ? mean(qbRounds) : null;
      const avgTeRound = teRounds.length ? mean(teRounds) : null;
      const topTeamCount = Math.max(0, ...teamCounts.values());

      const data = {
        avgReachVsAdp: reaches.length ? mean(reaches) : null,
        qbTendency: bucketRound(avgQbRound, [4, 8, 12]),
        teTendency: bucketRound(avgTeRound, [4, 8, 12]),
        rbShareEarly: earlyTotal ? earlyRb / earlyTotal : null,
        wrShareEarly: earlyTotal ? earlyWr / earlyTotal : null,
        homerScore: mine.length ? topTeamCount / mine.length : null,
        predictabilityR2: computePredictability(mine, adpByPlayer),
        sampleSize: mine.length,
        detailJson: writeJson({
          avgQbRound,
          avgTeRound,
          draftsSampled: new Set(mine.map((p) => p.draftId)).size,
          favouriteNflTeam: [...teamCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        }),
        computedAt: new Date(),
      };

      await prisma.managerProfile.upsert({
        where: { leagueId_memberId_season: { leagueId, memberId: member.id, season: season ?? '' } },
        create: { leagueId, memberId: member.id, season: season ?? '', ...data },
        update: data,
      });
      written += 1;
    }

    return { recordsIn: members.length, recordsWritten: written };
  });
}

function bucketRound(avgRound: number | null, cuts: [number, number, number]): string | null {
  if (avgRound === null) return null;
  if (avgRound <= cuts[0]) return 'early';
  if (avgRound <= cuts[1]) return 'mid';
  if (avgRound <= cuts[2]) return 'late';
  return 'stream';
}

/**
 * How closely this manager's picks track ADP. 1 = perfectly predictable from
 * ADP, 0 = no better than guessing. Used to decide how much to trust the mock
 * simulator's prediction of what they'll do at their next pick.
 */
function computePredictability(
  picks: { pickNo: number; playerId: string | null }[],
  adpByPlayer: Map<string, number>,
): number | null {
  const pairs = picks
    .map((p) => ({ actual: p.pickNo, adp: p.playerId ? adpByPlayer.get(p.playerId) : undefined }))
    .filter((p): p is { actual: number; adp: number } => p.adp !== undefined);

  if (pairs.length < 5) return null;

  const actuals = pairs.map((p) => p.actual);
  const meanActual = mean(actuals);
  const ssTot = actuals.reduce((s, a) => s + (a - meanActual) ** 2, 0);
  const ssRes = pairs.reduce((s, p) => s + (p.actual - p.adp) ** 2, 0);
  if (ssTot === 0) return null;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

/**
 * Import keeper declarations that Sleeper already knows about. Sleeper marks
 * keeper picks on the draft itself, so a completed draft tells us who was kept
 * and at what cost. Manual entry on the Keepers page covers everything else.
 */
export async function importKeepersFromDraft(draftId: string): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'keepers' }, async () => {
    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    const picks = await prisma.draftPick.findMany({
      where: { draftId, isKeeper: true, playerId: { not: null } },
    });

    let written = 0;
    for (const pick of picks) {
      if (!pick.playerId) continue;
      const data = {
        memberId: pick.memberId,
        rosterId: pick.rosterId,
        costRound: pick.round,
        costPickNo: pick.pickNo,
        source: 'sleeper',
        isConfirmed: true,
      };
      await prisma.keeperDeclaration.upsert({
        where: {
          leagueId_season_playerId: {
            leagueId: draft.leagueId,
            season: draft.season,
            playerId: pick.playerId,
          },
        },
        create: { leagueId: draft.leagueId, season: draft.season, playerId: pick.playerId, ...data },
        update: data,
      });
      written += 1;
    }

    return { recordsIn: picks.length, recordsWritten: written };
  });
}

/** Convenience wrapper used by scripts/sync-all.ts. */
export async function fullSync(leagueId: string) {
  const state = await sleeper.getState().catch(() => null);
  const season = state?.season ?? new Date().getFullYear().toString();
  await syncLeague(leagueId, { markPrimary: true });
  await syncHistory(leagueId);
  await import('./market').then((m) => m.deriveLeagueAdp({ leagueId, season }));
  await computeManagerProfiles(leagueId);
  await import('./market').then((m) => m.syncTrending(season));
  return { season };
}
