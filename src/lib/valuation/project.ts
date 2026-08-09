import { prisma } from '../db';
import { writeJson } from '../json';
import { mean } from '../utils';
import { SKILL_POSITIONS, type SkillPosition } from '../enums';
import { withSyncRun, type SyncResult } from '../sync/runner';

/**
 * Projections built from actual historical production.
 *
 * This replaces the rank-derived fallback curve as the primary source. The
 * curve mapped Sleeper's `search_rank` — an internal relevance index, not a
 * fantasy draft order — onto an invented decay. That is why a QB2 landed at
 * pick 23 and a 16.6 PPG running back sat behind a rookie tight end.
 *
 * Method, deliberately simple and inspectable:
 *
 *   1. PER-GAME RATE from the last three seasons, recency weighted. Rate, not
 *      total, so a player who missed half a season is not punished twice.
 *   2. EXPECTED GAMES from recent availability, regressed toward the league
 *      norm so one injury year does not permanently condemn a player.
 *   3. AGE CURVE by position — running backs fall off a cliff that receivers
 *      and quarterbacks do not.
 *   4. ROOKIES have no production, so they are priced off draft capital
 *      against what comparable draft slots have historically produced.
 *
 * Everything here is a transparent multiplication of stored numbers. When a
 * projection looks wrong the inputs can be read off directly, which matters
 * more than squeezing out the last few points of accuracy.
 */

const SOURCE = 'internal-production';

/** Recency weights for the last three seasons, newest first. */
const SEASON_WEIGHTS = [0.62, 0.26, 0.12];

/** Games a full season offers. */
const FULL_SEASON = 17;

/**
 * Availability is regressed toward this many games. A player with one 9-game
 * season should not be projected for 9 games forever.
 */
const AVAILABILITY_PRIOR_GAMES = 15.0;
const AVAILABILITY_PRIOR_WEIGHT = 0.9;

/** Peak age and decline rate per position. */
const AGE_CURVE: Record<SkillPosition, { peak: number; declinePerYear: number; risePerYear: number }> = {
  QB: { peak: 29, declinePerYear: 0.015, risePerYear: 0.03 },
  RB: { peak: 25, declinePerYear: 0.075, risePerYear: 0.05 },
  WR: { peak: 27, declinePerYear: 0.035, risePerYear: 0.06 },
  TE: { peak: 28, declinePerYear: 0.03, risePerYear: 0.07 },
};

function ageMultiplier(position: SkillPosition, age: number | null): number {
  if (age === null) return 1;
  const curve = AGE_CURVE[position];
  if (!curve) return 1;
  const delta = age - curve.peak;
  if (delta > 0) return Math.max(0.55, 1 - delta * curve.declinePerYear);
  // Below peak, players are still improving — but cap the bonus.
  return Math.min(1.25, 1 + Math.abs(delta) * curve.risePerYear * 0.5);
}

export interface ProjectionInput {
  playerId: string;
  position: SkillPosition;
  age: number | null;
  seasons: { season: string; games: number; ppg: number }[];
  draftCapitalScore: number | null;
  rookieSeason: number | null;
}

export interface ProjectionOutput {
  playerId: string;
  points: number;
  ppg: number;
  expectedGames: number;
  method: 'PRODUCTION' | 'ROOKIE_CAPITAL' | 'NONE';
  detail: Record<string, unknown>;
}

/**
 * How many seasons a player may be absent before his old production stops
 * counting as evidence about the coming one.
 *
 * Without this gate, "last three seasons on record" quietly means "last three
 * seasons he happened to play" — so a receiver whose most recent snap was in
 * 2021 still gets projected off it and lands mid-board five years later.
 * Two seasons keeps genuine one-year absences (injury, suspension) while
 * dropping players who are simply gone.
 */
const MAX_SEASONS_SINCE_LAST_PLAYED = 2;

export function projectPlayer(input: ProjectionInput, targetSeason: number): ProjectionOutput | null {
  const played = input.seasons
    .filter((s) => Number(s.season) < targetSeason && s.games > 0)
    .sort((a, b) => Number(b.season) - Number(a.season));

  const mostRecent = played[0] ? Number(played[0].season) : null;
  const isStale =
    mostRecent === null || targetSeason - mostRecent > MAX_SEASONS_SINCE_LAST_PLAYED;

  // Only seasons within the window inform the rate.
  const recent = isStale ? [] : played.slice(0, 3);

  // --- Rookies and players with no history ------------------------------
  if (!recent.length) {
    const isIncoming =
      input.rookieSeason !== null && input.rookieSeason >= targetSeason - 1;
    if (!isIncoming || input.draftCapitalScore === null) return null;

    // Price off draft capital. These constants are the historical rough shape
    // of rookie scoring by draft slot, not a fitted model — they exist so a
    // first-round rookie is not invisible, and they are superseded the moment
    // he plays a game.
    const capitalPpg: Record<SkillPosition, number> = { QB: 12, RB: 9.5, WR: 8.5, TE: 6.5 };
    const ppg = capitalPpg[input.position] * (0.45 + input.draftCapitalScore * 0.75);
    const expectedGames = 15;
    return {
      playerId: input.playerId,
      points: ppg * expectedGames,
      ppg,
      expectedGames,
      method: 'ROOKIE_CAPITAL',
      detail: { draftCapitalScore: input.draftCapitalScore },
    };
  }

  // --- Recency-weighted per-game rate ------------------------------------
  let weightSum = 0;
  let ppgSum = 0;
  recent.forEach((s, i) => {
    const w = SEASON_WEIGHTS[i] ?? 0.05;
    weightSum += w;
    ppgSum += s.ppg * w;
  });
  const baseRate = ppgSum / weightSum;

  // --- Expected games, regressed toward the prior -------------------------
  let gWeight = 0;
  let gSum = 0;
  recent.forEach((s, i) => {
    const w = SEASON_WEIGHTS[i] ?? 0.05;
    gWeight += w;
    gSum += Math.min(FULL_SEASON, s.games) * w;
  });
  const observedGames = gSum / gWeight;
  const expectedGames = Math.min(
    FULL_SEASON,
    (observedGames * gWeight + AVAILABILITY_PRIOR_GAMES * AVAILABILITY_PRIOR_WEIGHT) /
      (gWeight + AVAILABILITY_PRIOR_WEIGHT),
  );

  const ageMult = ageMultiplier(input.position, input.age);
  const ppg = baseRate * ageMult;

  return {
    playerId: input.playerId,
    points: ppg * expectedGames,
    ppg,
    expectedGames,
    method: 'PRODUCTION',
    detail: {
      baseRate: Number(baseRate.toFixed(2)),
      ageMultiplier: Number(ageMult.toFixed(3)),
      observedGames: Number(observedGames.toFixed(1)),
      seasonsUsed: recent.map((s) => `${s.season}:${s.games}g@${s.ppg.toFixed(1)}`),
    },
  };
}

/**
 * Build and persist projections for every player with usable history.
 *
 * Also the relevance gate: a player who has neither produced recently nor been
 * drafted recently gets no projection, which is what keeps retired players off
 * the board without relying on Sleeper's unreliable `active` flag.
 */
export async function buildProductionProjections(args: {
  season: string;
  format?: string;
}): Promise<SyncResult> {
  const targetSeason = Number(args.season);

  return withSyncRun({ provider: SOURCE, job: 'projections', season: args.season }, async () => {
    // Register as a real source so it participates in the blend and can be
    // re-weighted or disabled from the Sources page like anything else.
    await prisma.dataSource.upsert({
      where: { key: SOURCE },
      create: {
        key: SOURCE,
        label: 'Historical production model',
        kind: 'PROJECTIONS',
        adapter: 'MANUAL',
        weight: 1,
        trust: 0.6,
        isBuiltIn: true,
        notes:
          'Projections built from actual 2018-2025 weekly production: recency-weighted per-game rate, availability, age curve. Rookies priced off draft capital.',
      },
      update: {},
    });

    const players = await prisma.player.findMany({
      where: { position: { in: [...SKILL_POSITIONS] } },
      select: { id: true, position: true, age: true, profile: { select: { draftCapitalScore: true, rookieSeason: true } } },
    });

    // Pull every weekly row once and group in memory — far faster than a
    // per-player query across 46k rows.
    const weekly = await prisma.playerWeekStat.findMany({
      where: { seasonType: 'REG', fantasyPointsPpr: { not: null } },
      select: { playerId: true, season: true, fantasyPointsPpr: true },
    });

    const byPlayerSeason = new Map<string, Map<string, number[]>>();
    for (const row of weekly) {
      const seasons = byPlayerSeason.get(row.playerId) ?? new Map<string, number[]>();
      const list = seasons.get(row.season) ?? [];
      list.push(row.fantasyPointsPpr as number);
      seasons.set(row.season, list);
      byPlayerSeason.set(row.playerId, seasons);
    }

    // This source is a deterministic recomputation, not raw provider data, so
    // each run's output fully replaces the last rather than accumulating.
    // Without this, a player who correctly drops out of one run (e.g. the
    // staleness gate catching a retiree) keeps his last positive row forever —
    // the same "old batch lingers" failure mode fixed earlier for ADP.
    await prisma.projection.deleteMany({
      where: { source: SOURCE, season: args.season, scope: 'SEASON' },
    });

    const capturedAt = new Date();
    let written = 0;
    let rookies = 0;
    let skipped = 0;

    for (const p of players) {
      const seasonsMap = byPlayerSeason.get(p.id);
      const seasons = seasonsMap
        ? [...seasonsMap.entries()].map(([season, pts]) => ({
            season,
            games: pts.length,
            ppg: mean(pts),
          }))
        : [];

      const result = projectPlayer(
        {
          playerId: p.id,
          position: p.position as SkillPosition,
          age: p.age,
          seasons,
          draftCapitalScore: p.profile?.draftCapitalScore ?? null,
          rookieSeason: p.profile?.rookieSeason ?? null,
        },
        targetSeason,
      );

      if (!result) {
        skipped += 1;
        continue;
      }
      if (result.method === 'ROOKIE_CAPITAL') rookies += 1;

      await prisma.projection.create({
        data: {
          playerId: p.id,
          source: SOURCE,
          scope: 'SEASON',
          season: args.season,
          week: 0,
          format: args.format ?? 'PPR',
          fantasyPoints: result.points,
          // Spread widens for players with less history behind the estimate.
          floorPoints: result.points * (result.method === 'ROOKIE_CAPITAL' ? 0.5 : 0.75),
          ceilingPoints: result.points * (result.method === 'ROOKIE_CAPITAL' ? 1.9 : 1.35),
          gamesPlayed: result.expectedGames,
          statsJson: writeJson({ ppg: result.ppg, method: result.method, ...result.detail }),
          capturedAt,
        },
      });
      written += 1;
    }

    await prisma.dataSource.updateMany({
      where: { key: SOURCE },
      data: { lastImportedAt: capturedAt, lastRecordCount: written },
    });

    return {
      recordsIn: players.length,
      recordsWritten: written,
      detail: {
        fromProduction: written - rookies,
        fromDraftCapital: rookies,
        skippedNoBasis: skipped,
      },
    };
  });
}
