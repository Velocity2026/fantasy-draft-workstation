import { prisma } from '../db';
import { nflverse, num, int, text } from '../providers/nflverse';
import { normaliseName } from '../utils';
import { writeJson } from '../json';
import { withSyncRun, type SyncResult } from './runner';

/**
 * Weekly stats and snap-count backfill.
 *
 * This is the data that makes trajectory analysis possible: PlayerWeekStat is
 * append-only and keyed by week, so "did his points per game climb through the
 * season" and "did his snap share grow after week 8" become straightforward
 * queries rather than something that has to be reconstructed.
 *
 * Two joins are needed and they use different keys:
 *   - weekly stats key on `player_id`, which is nflverse's gsis id. We resolve
 *     it through the PlayerExternalId rows written by the profile sync.
 *   - snap counts key on `pfr_player_id`, resolved through PlayerProfile.pfrId.
 *
 * Anything that fails to resolve is counted and reported rather than dropped
 * silently — a systematically missing position would otherwise look like a
 * player who simply never plays.
 */

interface Resolvers {
  byGsis: Map<string, string>;
  byPfr: Map<string, string>;
  byName: Map<string, string[]>;
}

async function buildResolvers(): Promise<Resolvers> {
  const [externals, profiles, players] = await Promise.all([
    prisma.playerExternalId.findMany({
      where: { source: 'nflverse' },
      select: { externalId: true, playerId: true },
    }),
    prisma.playerProfile.findMany({
      where: { pfrId: { not: null } },
      select: { pfrId: true, playerId: true },
    }),
    prisma.player.findMany({
      where: { position: { in: ['QB', 'RB', 'WR', 'TE'] } },
      select: { id: true, fullName: true, position: true },
    }),
  ]);

  const byGsis = new Map(externals.map((e) => [e.externalId, e.playerId]));
  const byPfr = new Map(profiles.map((p) => [p.pfrId as string, p.playerId]));

  const byName = new Map<string, string[]>();
  for (const p of players) {
    const key = `${normaliseName(p.fullName)}|${p.position}`;
    const list = byName.get(key) ?? [];
    list.push(p.id);
    byName.set(key, list);
  }

  return { byGsis, byPfr, byName };
}

function resolveByName(r: Resolvers, name: string, position: string | null): string | null {
  const key = `${normaliseName(name)}|${(position ?? '').toUpperCase()}`;
  const hits = r.byName.get(key);
  // Ambiguous names are skipped rather than guessed.
  return hits && hits.length === 1 ? hits[0] : null;
}

const SEASON_TYPE: Record<string, string> = { REG: 'REG', POST: 'POST', PRE: 'PRE' };

/**
 * Ingest one season of weekly stats plus its snap counts.
 *
 * Snap counts are merged into the same PlayerWeekStat row rather than stored
 * separately — snap share only means anything next to the usage it produced.
 */
export async function syncSeasonWeekly(season: number): Promise<SyncResult> {
  return withSyncRun({ provider: 'nflverse', job: 'weekly', season: String(season) }, async () => {
    const resolvers = await buildResolvers();

    const [weekly, snaps] = await Promise.all([
      nflverse.weekly(season),
      // Snap counts start in 2012 but occasionally lag for a current season.
      nflverse.snapCounts(season).catch(() => []),
    ]);

    // --- Index snaps by (playerId, week) ---------------------------------
    const snapByKey = new Map<string, { offense: number | null; pct: number | null; st: number | null }>();
    let snapUnresolved = 0;

    for (const s of snaps) {
      const pfr = text(s.pfr_player_id);
      let playerId = pfr ? (resolvers.byPfr.get(pfr) ?? null) : null;
      if (!playerId) playerId = resolveByName(resolvers, s.player ?? '', s.position ?? null);
      if (!playerId) {
        snapUnresolved += 1;
        continue;
      }
      const week = int(s.week);
      if (week === null) continue;
      // nflverse gives offense_pct as a 0..1 fraction.
      snapByKey.set(`${playerId}|${week}`, {
        offense: int(s.offense_snaps),
        pct: num(s.offense_pct),
        st: int(s.st_snaps),
      });
    }

    // --- Write weekly rows -------------------------------------------------
    let written = 0;
    let unresolved = 0;
    const unresolvedNames = new Set<string>();

    // Chunked so a full season is not one enormous SQLite transaction.
    const CHUNK = 300;
    for (let i = 0; i < weekly.length; i += CHUNK) {
      const chunk = weekly.slice(i, i + CHUNK);

      for (const row of chunk) {
        const position = (text(row.position) ?? '').toUpperCase();
        if (!['QB', 'RB', 'WR', 'TE'].includes(position)) continue;

        const gsis = text(row.player_id);
        let playerId = gsis ? (resolvers.byGsis.get(gsis) ?? null) : null;
        if (!playerId) {
          playerId = resolveByName(resolvers, row.player_display_name ?? '', position);
        }
        if (!playerId) {
          unresolved += 1;
          if (unresolvedNames.size < 40 && row.player_display_name) {
            unresolvedNames.add(row.player_display_name);
          }
          continue;
        }

        const week = int(row.week);
        if (week === null) continue;

        const seasonType = SEASON_TYPE[(text(row.season_type) ?? 'REG').toUpperCase()] ?? 'REG';
        const snap = snapByKey.get(`${playerId}|${week}`);

        const data = {
          teamId: text(row.team),
          opponentId: text(row.opponent_team),
          snapsOffense: snap?.offense ?? null,
          snapPct: snap?.pct ?? null,
          snapsSpecial: snap?.st ?? null,

          targets: int(row.targets),
          targetShare: num(row.target_share),
          receptions: int(row.receptions),
          recYards: num(row.receiving_yards),
          recTds: int(row.receiving_tds),
          airYards: num(row.receiving_air_yards),
          airYardsShare: num(row.air_yards_share),
          wopr: num(row.wopr),
          yac: num(row.receiving_yards_after_catch),

          carries: int(row.carries),
          rushYards: num(row.rushing_yards),
          rushTds: int(row.rushing_tds),

          passAttempts: int(row.attempts),
          completions: int(row.completions),
          passYards: num(row.passing_yards),
          passTds: int(row.passing_tds),
          interceptions: int(row.passing_interceptions),
          sacksTaken: int(row.sacks_suffered),

          fantasyPointsPpr: num(row.fantasy_points_ppr),
          fantasyPointsStd: num(row.fantasy_points),
          // Half-PPR is derivable and cheap to store, and start/sit later wants it.
          fantasyPointsHalf:
            num(row.fantasy_points) !== null && int(row.receptions) !== null
              ? (num(row.fantasy_points) as number) + (int(row.receptions) as number) * 0.5
              : null,

          rawJson: writeJson({ racr: num(row.racr), pacr: num(row.pacr) }),
          capturedAt: new Date(),
        };

        await prisma.playerWeekStat.upsert({
          where: {
            playerId_season_week_seasonType_source: {
              playerId,
              season: String(season),
              week,
              seasonType,
              source: 'nflverse',
            },
          },
          create: {
            playerId,
            season: String(season),
            week,
            seasonType,
            source: 'nflverse',
            ...data,
          },
          update: data,
        });
        written += 1;
      }
    }

    return {
      recordsIn: weekly.length,
      recordsWritten: written,
      partial: unresolved > 0,
      detail: {
        snapRowsRead: snaps.length,
        snapUnresolved,
        unresolved,
        unresolvedSample: [...unresolvedNames].slice(0, 20),
      },
    };
  });
}

/** Backfill a range of seasons, newest first so useful data lands soonest. */
export async function backfillWeekly(from: number, to: number): Promise<
  { season: number; written: number; unresolved: number; error?: string }[]
> {
  const results: { season: number; written: number; unresolved: number; error?: string }[] = [];

  for (let season = to; season >= from; season -= 1) {
    try {
      const r = await syncSeasonWeekly(season);
      const d = r.detail as { unresolved?: number };
      results.push({ season, written: r.recordsWritten, unresolved: d?.unresolved ?? 0 });
    } catch (error) {
      // One bad season should not abort an eight-season backfill.
      results.push({
        season,
        written: 0,
        unresolved: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
