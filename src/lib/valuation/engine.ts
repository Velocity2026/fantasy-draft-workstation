import { prisma } from '../db';
import { getConfig, deriveRosterShape, type RosterShape } from '../config';
import { readJson, writeJson } from '../json';
import { SKILL_POSITIONS, type ScoringFormat, type SkillPosition, type ValuationScope } from '../enums';
import { baselinePoints, baselineRange } from './baseline';
import {
  computeReplacementLevels,
  normaliseScarcity,
  scarcityIndex,
  type ReplacementMethod,
} from './replacement';
import { assignTiers } from './tiers';
import { getProjectionWeights } from '../sources';
import { withSyncRun, type SyncResult } from '../sync/runner';

/**
 * The valuation engine.
 *
 * Pipeline, in order:
 *   1. Assemble a projection for every player, preferring real imported
 *      projections and falling back to the rank-derived baseline curve.
 *   2. Compute replacement level per position from the league's real roster
 *      settings.
 *   3. VORP = projection - replacement.
 *   4. Tier by natural breaks in VORP within each position.
 *   5. Attach ADP and the delta against our own ranking — the value signal.
 *   6. Auction values by distributing the league's total budget across
 *      positive-VORP players.
 *
 * Every run is persisted as a ValuationRun so a draft-day number can be traced
 * to the inputs that produced it, and so changing a setting doesn't silently
 * rewrite history.
 */

export interface ValuationParams {
  leagueId: string;
  season: string;
  scope?: ValuationScope;
  week?: number;
  label?: string;
  /** Blend weights by projection source. Missing sources are ignored. */
  projectionWeights?: Record<string, number>;
  replacementMethod?: ReplacementMethod;
  /** Penalty applied to VORP per unit of risk (0 = ignore risk). */
  riskAversion?: number;
  makeActive?: boolean;
}

interface PlayerInput {
  playerId: string;
  fullName: string;
  position: SkillPosition;
  teamId: string | null;
  age: number | null;
  yearsExp: number | null;
  injuryStatus: string | null;
  points: number | null;
  floor: number | null;
  ceiling: number | null;
  isBaseline: boolean;
  sources: string[];
  adp: number | null;
  adpStdDev: number | null;
  consensusRank: number | null;
  positionRankFromSource: number | null;
}

export async function runValuation(params: ValuationParams): Promise<SyncResult & { runId: string }> {
  const cfg = await getConfig();
  const scope = params.scope ?? 'DRAFT';
  const replacementMethod = params.replacementMethod ?? (cfg.replacementMethod as ReplacementMethod);
  const riskAversion = params.riskAversion ?? cfg.riskAversion;
  // Blend weights come from the DataSource registry, so adding, removing or
  // re-weighting a provider on the Sources page changes the next valuation with
  // no code change. An explicit override in `params` still wins.
  const weights = params.projectionWeights ?? (await getProjectionWeights());

  const result = await withSyncRun(
    { provider: 'internal', job: 'valuation', season: params.season, week: params.week },
    async () => {
      const league = await prisma.league.findUniqueOrThrow({ where: { id: params.leagueId } });
      const rosterPositions = readJson<string[]>(league.rosterPositionsJson, []);
      const shape = deriveRosterShape(rosterPositions, league.totalRosters);
      const format = (league.scoringType ?? 'PPR') as ScoringFormat;

      // If no real projections exist yet, the rank curve is all we have and
      // an approximate board beats an empty one. Once any real projection
      // source has data, the curve is switched off entirely.
      const realProjectionCount = await prisma.projection.count({
        where: { season: params.season, scope: 'SEASON', source: { not: 'baseline' } },
      });
      const allowBaselineFallback = realProjectionCount === 0;

      const inputs = await assembleInputs({
        season: params.season,
        scope,
        week: params.week,
        format,
        weights,
        teamCount: league.totalRosters,
        allowBaselineFallback,
      });

      // --- Replacement level -------------------------------------------------
      const pointsByPosition = {} as Record<SkillPosition, number[]>;
      for (const pos of SKILL_POSITIONS) {
        pointsByPosition[pos] = inputs
          .filter((p) => p.position === pos && p.points !== null)
          .map((p) => p.points as number)
          .sort((a, b) => b - a);
      }

      const replacement = computeReplacementLevels({ shape, method: replacementMethod, pointsByPosition });

      const rawScarcity = {} as Record<SkillPosition, number>;
      for (const pos of SKILL_POSITIONS) {
        rawScarcity[pos] = scarcityIndex(pointsByPosition[pos], replacement.rank[pos]);
      }
      const scarcity = normaliseScarcity(rawScarcity);

      // --- VORP --------------------------------------------------------------
      interface Scored extends PlayerInput {
        projPoints: number;
        vorp: number;
        riskScore: number;
        upsideScore: number;
      }

      const scored: Scored[] = inputs
        .filter((p) => p.points !== null)
        .map((p) => {
          const projPoints = p.points as number;
          const risk = riskScoreFor(p);
          const rawVorp = projPoints - replacement.points[p.position];
          return {
            ...p,
            projPoints,
            // Risk shrinks VORP toward zero rather than subtracting a flat
            // amount, so it can't flip a stud into a negative-value player.
            vorp: rawVorp * (1 - riskAversion * risk),
            riskScore: risk,
            upsideScore: upsideScoreFor(p),
          };
        });

      // --- Tiers (within position, by VORP) ----------------------------------
      const tierByPlayer = new Map<string, number>();
      for (const pos of SKILL_POSITIONS) {
        const atPos = scored.filter((p) => p.position === pos).sort((a, b) => b.vorp - a.vorp);
        const tiers = assignTiers(atPos.map((p) => p.vorp));
        atPos.forEach((p, i) => tierByPlayer.set(p.playerId, tiers[i]));
      }

      // --- Ranks -------------------------------------------------------------
      const overallSorted = [...scored].sort((a, b) => b.vorp - a.vorp);
      const overallRankByPlayer = new Map(overallSorted.map((p, i) => [p.playerId, i + 1]));

      const positionRankByPlayer = new Map<string, number>();
      for (const pos of SKILL_POSITIONS) {
        scored
          .filter((p) => p.position === pos)
          .sort((a, b) => b.vorp - a.vorp)
          .forEach((p, i) => positionRankByPlayer.set(p.playerId, i + 1));
      }

      // --- Auction values ----------------------------------------------------
      const auctionByPlayer = computeAuctionValues(
        overallSorted.map((p) => ({ playerId: p.playerId, vorp: p.vorp })),
        { teams: shape.teams, budgetPerTeam: 200, rosterSize: shape.totalRosterSize },
      );

      // --- Persist -----------------------------------------------------------
      const run = await prisma.valuationRun.create({
        data: {
          leagueId: params.leagueId,
          season: params.season,
          scope,
          week: params.week,
          label: params.label ?? `${scope} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          paramsJson: writeJson({
            replacementMethod,
            riskAversion,
            format,
            projectionWeights: weights,
            replacementRank: replacement.rank,
            replacementPoints: replacement.points,
            scarcity,
            rosterShape: shape,
          }),
          playerCount: scored.length,
        },
      });

      const CHUNK = 200;
      for (let i = 0; i < overallSorted.length; i += CHUNK) {
        await prisma.playerValuation.createMany({
          data: overallSorted.slice(i, i + CHUNK).map((p) => {
            const overallRank = overallRankByPlayer.get(p.playerId)!;
            return {
              runId: run.id,
              playerId: p.playerId,
              position: p.position,
              projPoints: p.projPoints,
              floorPoints: p.floor,
              ceilingPoints: p.ceiling,
              replacementPoints: replacement.points[p.position],
              vorp: p.vorp,
              auctionValue: auctionByPlayer.get(p.playerId) ?? null,
              tier: tierByPlayer.get(p.playerId) ?? 1,
              positionRank: positionRankByPlayer.get(p.playerId) ?? 999,
              overallRank,
              scarcityIndex: scarcity[p.position],
              riskScore: p.riskScore,
              upsideScore: p.upsideScore,
              adp: p.adp,
              // Negative = market takes him later than we rank him = value.
              adpDelta: p.adp !== null ? overallRank - p.adp : null,
              detailJson: writeJson({
                isBaseline: p.isBaseline,
                sources: p.sources,
                adpStdDev: p.adpStdDev,
              }),
            };
          }),
        });
      }

      if (params.makeActive !== false) {
        await prisma.valuationRun.updateMany({
          where: { leagueId: params.leagueId, season: params.season, scope, isActive: true },
          data: { isActive: false },
        });
        await prisma.valuationRun.update({ where: { id: run.id }, data: { isActive: true } });
      }

      return {
        recordsIn: inputs.length,
        recordsWritten: scored.length,
        detail: {
          runId: run.id,
          replacement: replacement.points,
          baselineCount: scored.filter((p) => p.isBaseline).length,
        },
      };
    },
  );

  const detail = result.detail as { runId: string };
  return { ...result, runId: detail.runId };
}

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

async function assembleInputs(args: {
  season: string;
  scope: ValuationScope;
  week?: number;
  format: ScoringFormat;
  weights: Record<string, number>;
  teamCount: number;
  allowBaselineFallback: boolean;
}): Promise<PlayerInput[]> {
  const players = await prisma.player.findMany({
    where: { position: { in: [...SKILL_POSITIONS] }, active: true },
    select: {
      id: true,
      fullName: true,
      position: true,
      teamId: true,
      age: true,
      yearsExp: true,
      injuryStatus: true,
      searchRank: true,
    },
  });

  const projectionScope = args.scope === 'WEEKLY' ? 'WEEKLY' : args.scope === 'ROS' ? 'ROS' : 'SEASON';

  // Projections are read as the latest *batch* per source, not the latest row
  // per player — the same fix applied to ADP after the same bug appeared
  // there. A source's tables are append-only, so a player correctly absent
  // from the newest run of a source still has an older row sitting in the
  // table; latest-per-player would resurrect him with stale, and possibly
  // now-wrong, points (this is exactly how Antonio Brown stayed on the board
  // after the staleness gate should have dropped him).
  const projectionBatches = await prisma.projection.groupBy({
    by: ['source'],
    where: { season: args.season, scope: projectionScope, week: args.week ?? 0 },
    _max: { capturedAt: true },
  });

  const projections = projectionBatches.length
    ? await prisma.projection.findMany({
        where: {
          season: args.season,
          scope: projectionScope,
          week: args.week ?? 0,
          OR: projectionBatches
            .filter((b) => b._max.capturedAt)
            .map((b) => ({ source: b.source, capturedAt: b._max.capturedAt as Date })),
        },
        select: {
          playerId: true,
          source: true,
          fantasyPoints: true,
          floorPoints: true,
          ceilingPoints: true,
          capturedAt: true,
        },
      })
    : [];

  const latestProjection = new Map<string, Map<string, (typeof projections)[number]>>();
  for (const p of projections) {
    const bySource = latestProjection.get(p.playerId) ?? new Map();
    if (!bySource.has(p.source)) bySource.set(p.source, p);
    latestProjection.set(p.playerId, bySource);
  }

  // Latest consensus ranking — used to derive baseline points when a player has
  // no projection at all.
  const rankings = await prisma.ranking.findMany({
    where: { season: args.season, scope: args.scope === 'ROS' ? 'ROS' : 'DRAFT' },
    orderBy: { capturedAt: 'desc' },
    select: { playerId: true, overallRank: true, positionRank: true, capturedAt: true },
  });
  const latestRanking = new Map<string, (typeof rankings)[number]>();
  for (const r of rankings) if (!latestRanking.has(r.playerId)) latestRanking.set(r.playerId, r);

  // ADP is read as the most recent *batch* per source, not the most recent row
  // per player.
  //
  // These tables are append-only, so a player who appeared in an earlier
  // derivation but is correctly absent from the newest one still has an old
  // row sitting there. Latest-per-player would resurrect him — which is
  // precisely how a long-retired tight end ends up ranked TE2. Taking the
  // newest batch means a player dropping out of a source actually drops out.
  const adpBatches = await prisma.adpSnapshot.groupBy({
    by: ['source'],
    where: { season: args.season },
    _max: { capturedAt: true },
  });

  const adps = adpBatches.length
    ? await prisma.adpSnapshot.findMany({
        where: {
          season: args.season,
          OR: adpBatches
            .filter((b) => b._max.capturedAt)
            .map((b) => ({ source: b.source, capturedAt: b._max.capturedAt as Date })),
        },
        select: { playerId: true, adp: true, adpStdDev: true, teamCount: true, source: true },
      })
    : [];
  const latestAdp = new Map<string, (typeof adps)[number]>();
  for (const a of adps) {
    const existing = latestAdp.get(a.playerId);
    if (!existing) {
      latestAdp.set(a.playerId, a);
      continue;
    }
    const existingMatches = existing.teamCount === args.teamCount;
    const candidateMatches = a.teamCount === args.teamCount;
    if (candidateMatches && !existingMatches) latestAdp.set(a.playerId, a);
  }

  // Positional ordering used for the baseline fallback.
  //
  // Signals are ranked by preference, but a single signal is used for the whole
  // position rather than mixing them per player — ADP (a pick number) and
  // Sleeper's search rank (a global relevance index) are different scales, and
  // interleaving them produces nonsense orderings.
  //
  // Sleeper's search rank is the default because it is the only signal that
  // covers every player. In a keeper league the best players are kept every
  // season and therefore never appear in derived ADP at all; ordering by ADP
  // alone silently drops them off the board.
  const fallbackOrder = new Map<SkillPosition, string[]>();
  for (const pos of SKILL_POSITIONS) {
    const atPos = players.filter((p) => p.position === pos);

    const signal = (p: (typeof players)[number]): number => {
      const ranking = latestRanking.get(p.id);
      // An imported positional ranking is the best signal when it exists.
      if (ranking?.positionRank != null) return ranking.positionRank;
      if (ranking?.overallRank != null) return ranking.overallRank;
      if (p.searchRank != null) return p.searchRank;
      // No signal at all — sort last, but keep him on the board.
      return Number.POSITIVE_INFINITY;
    };

    const ordered = atPos
      .map((p) => ({ id: p.id, key: signal(p) }))
      .sort((a, b) => a.key - b.key)
      .map((p) => p.id);
    fallbackOrder.set(pos, ordered);
  }

  return players.map((player) => {
    const position = player.position as SkillPosition;
    const bySource = latestProjection.get(player.id);
    const ranking = latestRanking.get(player.id);
    const adp = latestAdp.get(player.id);

    let points: number | null = null;
    let floor: number | null = null;
    let ceiling: number | null = null;
    let isBaseline = false;
    const sources: string[] = [];

    if (bySource && bySource.size) {
      // Weighted blend across whichever sources actually have data.
      let weightSum = 0;
      let pointSum = 0;
      let floorSum = 0;
      let floorWeight = 0;
      let ceilSum = 0;
      let ceilWeight = 0;

      for (const [source, row] of bySource) {
        if (row.fantasyPoints === null) continue;
        const weight = args.weights[source] ?? args.weights['*'] ?? 1;
        if (weight <= 0) continue;
        sources.push(source);
        weightSum += weight;
        pointSum += row.fantasyPoints * weight;
        if (row.floorPoints !== null) {
          floorSum += row.floorPoints * weight;
          floorWeight += weight;
        }
        if (row.ceilingPoints !== null) {
          ceilSum += row.ceilingPoints * weight;
          ceilWeight += weight;
        }
      }

      if (weightSum > 0) {
        points = pointSum / weightSum;
        floor = floorWeight > 0 ? floorSum / floorWeight : null;
        ceiling = ceilWeight > 0 ? ceilSum / ceilWeight : null;
      }
    }

    if (points === null && args.allowBaselineFallback) {
      // No projection from any source. The rank-derived curve is only used
      // when the database holds no real projections at all — on a fresh
      // install, so the board is not empty.
      //
      // Once real projections exist, a player without one is deliberately left
      // OFF the board rather than given a curve value. That gate is what keeps
      // retired players out: Sleeper's `active` flag stays true for them and
      // its `search_rank` still ranks them, so filtering on either put ~76% of
      // the board on players with no snaps in the last two seasons.
      const order = fallbackOrder.get(position) ?? [];
      const idx = order.indexOf(player.id);
      if (idx >= 0) {
        points = baselinePoints(position, idx + 1, args.format);
        isBaseline = true;
        sources.push('baseline');
      }
    }

    if (points !== null && (floor === null || ceiling === null)) {
      const range = baselineRange(points, position);
      floor = floor ?? range.floor;
      ceiling = ceiling ?? range.ceiling;
    }

    return {
      playerId: player.id,
      fullName: player.fullName,
      position,
      teamId: player.teamId,
      age: player.age,
      yearsExp: player.yearsExp,
      injuryStatus: player.injuryStatus,
      points,
      floor,
      ceiling,
      isBaseline,
      sources,
      adp: adp?.adp ?? null,
      adpStdDev: adp?.adpStdDev ?? null,
      consensusRank: ranking?.overallRank ?? null,
      positionRankFromSource: ranking?.positionRank ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Risk / upside
// ---------------------------------------------------------------------------

/** 0 = no known concern, 1 = maximum concern. */
function riskScoreFor(p: PlayerInput): number {
  let risk = 0;

  const injury = (p.injuryStatus ?? '').toLowerCase();
  if (injury.includes('out') || injury.includes('ir') || injury.includes('pup')) risk += 0.55;
  else if (injury.includes('doubtful')) risk += 0.4;
  else if (injury.includes('questionable')) risk += 0.2;
  else if (injury) risk += 0.12;

  // Age curve: RBs fall off a cliff, WR/TE decline later, QBs barely.
  if (p.age !== null) {
    if (p.position === 'RB' && p.age >= 28) risk += Math.min(0.3, (p.age - 27) * 0.1);
    if ((p.position === 'WR' || p.position === 'TE') && p.age >= 30) risk += Math.min(0.25, (p.age - 29) * 0.08);
    if (p.position === 'QB' && p.age >= 37) risk += 0.1;
  }

  // Wide ADP spread means the market itself disagrees about him.
  if (p.adpStdDev !== null && p.adp !== null && p.adp > 0) {
    risk += Math.min(0.2, (p.adpStdDev / Math.max(p.adp, 12)) * 0.35);
  }

  // A baseline-derived projection is less trustworthy than a real one.
  if (p.isBaseline) risk += 0.08;

  return Math.min(1, risk);
}

/** 0..1 — how much league-winning ceiling this profile carries. */
function upsideScoreFor(p: PlayerInput): number {
  let upside = 0;

  // Young players with room to grow into a bigger role.
  if (p.yearsExp !== null && p.yearsExp <= 2) upside += 0.3;
  if (p.age !== null && p.age <= 24) upside += 0.2;

  // Market disagreement cuts both ways — it's risk, but it's also where the
  // league-winners hide.
  if (p.adpStdDev !== null && p.adp !== null && p.adp > 0) {
    upside += Math.min(0.25, (p.adpStdDev / Math.max(p.adp, 12)) * 0.4);
  }

  if (p.floor !== null && p.ceiling !== null && p.points) {
    upside += Math.min(0.25, ((p.ceiling - p.points) / Math.max(p.points, 1)) * 0.6);
  }

  return Math.min(1, upside);
}

// ---------------------------------------------------------------------------
// Auction values
// ---------------------------------------------------------------------------

/**
 * Distribute the league's total auction budget across players with positive
 * VORP, in proportion to that VORP. Everyone else is a $1 roster filler.
 * Even in a snake league this is a useful second lens: it converts "how much
 * better" into money, which is easier to reason about than raw VORP.
 */
export function computeAuctionValues(
  players: { playerId: string; vorp: number }[],
  opts: { teams: number; budgetPerTeam: number; rosterSize: number },
): Map<string, number> {
  const draftable = opts.teams * opts.rosterSize;
  const pool = players.slice(0, draftable);
  const positive = pool.filter((p) => p.vorp > 0);

  const totalBudget = opts.teams * opts.budgetPerTeam;
  // Every drafted player costs at least $1, so only the surplus is allocatable.
  const allocatable = totalBudget - draftable;
  const totalVorp = positive.reduce((s, p) => s + p.vorp, 0);

  const out = new Map<string, number>();
  for (const p of pool) {
    if (totalVorp <= 0 || p.vorp <= 0) {
      out.set(p.playerId, 1);
      continue;
    }
    out.set(p.playerId, Math.max(1, Math.round(1 + (p.vorp / totalVorp) * allocatable)));
  }
  return out;
}

/** The run the UI should read from, or null if no valuation has been run yet. */
export async function getActiveRun(leagueId: string, season: string, scope: ValuationScope = 'DRAFT') {
  return prisma.valuationRun.findFirst({
    where: { leagueId, season, scope, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

export interface ValuationRowWithPlayer {
  playerId: string;
  fullName: string;
  position: string;
  teamId: string | null;
  injuryStatus: string | null;
  age: number | null;
  projPoints: number;
  floorPoints: number | null;
  ceilingPoints: number | null;
  vorp: number;
  tier: number;
  positionRank: number;
  overallRank: number;
  auctionValue: number | null;
  adp: number | null;
  adpDelta: number | null;
  riskScore: number | null;
  upsideScore: number | null;
  scarcityIndex: number | null;
  isBaseline: boolean;
}

/** Load a full valuation board, joined to player identity, ordered by VORP. */
export async function loadBoard(runId: string): Promise<ValuationRowWithPlayer[]> {
  const rows = await prisma.playerValuation.findMany({
    where: { runId },
    orderBy: { overallRank: 'asc' },
    include: {
      player: {
        select: { fullName: true, teamId: true, injuryStatus: true, age: true },
      },
    },
  });

  return rows.map((r) => ({
    playerId: r.playerId,
    fullName: r.player.fullName,
    position: r.position,
    teamId: r.player.teamId,
    injuryStatus: r.player.injuryStatus,
    age: r.player.age,
    projPoints: r.projPoints,
    floorPoints: r.floorPoints,
    ceilingPoints: r.ceilingPoints,
    vorp: r.vorp,
    tier: r.tier,
    positionRank: r.positionRank,
    overallRank: r.overallRank,
    auctionValue: r.auctionValue,
    adp: r.adp,
    adpDelta: r.adpDelta,
    riskScore: r.riskScore,
    upsideScore: r.upsideScore,
    scarcityIndex: r.scarcityIndex,
    isBaseline: readJson<{ isBaseline?: boolean }>(r.detailJson, {}).isBaseline ?? false,
  }));
}

export type { RosterShape };
