import { prisma } from '../db';
import { readJson } from '../json';

/**
 * Movers: who is rising, who is falling, and why.
 *
 * Two independent "did his value move" signals, because they answer different
 * questions:
 *
 *   BOARD MOVERS   — diff the two most recent valuation runs for this league.
 *                    Reflects everything: new projections, new ADP, board
 *                    overrides, source re-weighting. This is "did MY board
 *                    change", and it always works once two runs exist.
 *
 *   SOURCE MOVERS   — diff the two most recent import batches for one
 *                     specific source (e.g. two FantasyPros CSV uploads a
 *                     week apart). This is "did THAT SOURCE'S opinion
 *                     change", which is the literal ask: re-importing a
 *                     ranking should surface who moved in it.
 *
 * Both are cheap because Ranking/AdpSnapshot/ValuationRun are append-only by
 * design — every prior state is already sitting in the table, not
 * reconstructed after the fact.
 *
 * The "why" is best-effort correlation, not proof: it surfaces events that
 * happened in the same window a player moved (depth-chart change, injury
 * change, a spike in Sleeper adds, a note you logged) without claiming any one
 * of them caused the move. Two things happening close together is a lead
 * worth reading, not a citation.
 */

export interface Mover {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  previousRank: number;
  currentRank: number;
  /** Positive = moved up (better). */
  rankDelta: number;
  reasons: string[];
}

export interface MoversResult {
  risers: Mover[];
  fallers: Mover[];
  comparedAt: { previous: Date; current: Date };
}

// ---------------------------------------------------------------------------
// Board movers — our own valuation history
// ---------------------------------------------------------------------------

/**
 * Below the relevance threshold, "rank" is really a tiebreak among players who
 * will never be drafted — deep bench tight ends shuffle by one or two spots on
 * every run for no reason worth reporting. Restricting to the range that
 * actually gets drafted (with room for a deep keeper league) turns the report
 * from noise into signal. `minDelta` additionally requires the move to be big
 * enough to matter on its own, unless something explains it.
 */
const RELEVANCE_RANK_CEILING = 250;

export async function boardMovers(args: {
  leagueId: string;
  season: string;
  scope?: string;
  limit?: number;
  minDelta?: number;
}): Promise<MoversResult | null> {
  const runs = await prisma.valuationRun.findMany({
    where: { leagueId: args.leagueId, season: args.season, scope: args.scope ?? 'DRAFT' },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  if (runs.length < 2) return null;

  const [current, previous] = runs;
  return diffValuationRuns(current, previous, args.limit ?? 15, args.minDelta ?? 3);
}

async function diffValuationRuns(
  current: { id: string; createdAt: Date },
  previous: { id: string; createdAt: Date },
  limit: number,
  minDelta: number,
): Promise<MoversResult> {
  const [currentRows, previousRows] = await Promise.all([
    prisma.playerValuation.findMany({
      where: { runId: current.id },
      select: { playerId: true, overallRank: true, position: true, player: { select: { fullName: true, teamId: true } } },
    }),
    prisma.playerValuation.findMany({
      where: { runId: previous.id },
      select: { playerId: true, overallRank: true },
    }),
  ]);

  const prevByPlayer = new Map(previousRows.map((r) => [r.playerId, r.overallRank]));

  const deltas: Mover[] = [];
  for (const row of currentRows) {
    if (row.overallRank > RELEVANCE_RANK_CEILING) continue;
    const prevRank = prevByPlayer.get(row.playerId);
    if (prevRank === undefined) continue; // new to the board — not a "mover"
    if (prevRank > RELEVANCE_RANK_CEILING && row.overallRank > RELEVANCE_RANK_CEILING) continue;
    const delta = prevRank - row.overallRank;
    if (Math.abs(delta) < minDelta) continue;
    deltas.push({
      playerId: row.playerId,
      name: row.player.fullName,
      position: row.position,
      team: row.player.teamId,
      previousRank: prevRank,
      currentRank: row.overallRank,
      rankDelta: delta,
      reasons: [],
    });
  }

  const risers = deltas.filter((d) => d.rankDelta > 0).sort((a, b) => b.rankDelta - a.rankDelta).slice(0, limit);
  const fallers = deltas.filter((d) => d.rankDelta < 0).sort((a, b) => a.rankDelta - b.rankDelta).slice(0, limit);

  await Promise.all(
    [...risers, ...fallers].map(async (m) => {
      m.reasons = await explainMovement(m.playerId, previous.createdAt);
    }),
  );

  return { risers, fallers, comparedAt: { previous: previous.createdAt, current: current.createdAt } };
}

// ---------------------------------------------------------------------------
// Source movers — two import batches of the same ranking/ADP source
// ---------------------------------------------------------------------------

export async function sourceRankingMovers(args: {
  source: string;
  season: string;
  scope?: string;
  limit?: number;
  minDelta?: number;
}): Promise<MoversResult | null> {
  const batches = await prisma.ranking.findMany({
    where: { source: args.source, season: args.season, scope: args.scope ?? 'DRAFT' },
    select: { capturedAt: true },
    distinct: ['capturedAt'],
    orderBy: { capturedAt: 'desc' },
    take: 2,
  });
  if (batches.length < 2) return null;

  const [current, previous] = batches;
  const [currentRows, previousRows] = await Promise.all([
    prisma.ranking.findMany({
      where: { source: args.source, season: args.season, capturedAt: current.capturedAt },
      select: { playerId: true, overallRank: true, player: { select: { fullName: true, position: true, teamId: true } } },
    }),
    prisma.ranking.findMany({
      where: { source: args.source, season: args.season, capturedAt: previous.capturedAt },
      select: { playerId: true, overallRank: true },
    }),
  ]);

  const prevByPlayer = new Map(previousRows.filter((r) => r.overallRank !== null).map((r) => [r.playerId, r.overallRank as number]));
  const limit = args.limit ?? 15;
  const minDelta = args.minDelta ?? 3;

  const deltas: Mover[] = [];
  for (const row of currentRows) {
    if (row.overallRank === null) continue;
    if (row.overallRank > RELEVANCE_RANK_CEILING) continue;
    const prevRank = prevByPlayer.get(row.playerId);
    if (prevRank === undefined) continue;
    if (prevRank > RELEVANCE_RANK_CEILING) continue;
    const delta = prevRank - row.overallRank;
    if (Math.abs(delta) < minDelta) continue;
    deltas.push({
      playerId: row.playerId,
      name: row.player.fullName,
      position: row.player.position,
      team: row.player.teamId,
      previousRank: prevRank,
      currentRank: row.overallRank,
      rankDelta: delta,
      reasons: [],
    });
  }

  const risers = deltas.filter((d) => d.rankDelta > 0).sort((a, b) => b.rankDelta - a.rankDelta).slice(0, limit);
  const fallers = deltas.filter((d) => d.rankDelta < 0).sort((a, b) => a.rankDelta - b.rankDelta).slice(0, limit);

  await Promise.all(
    [...risers, ...fallers].map(async (m) => {
      m.reasons = await explainMovement(m.playerId, previous.capturedAt);
    }),
  );

  return { risers, fallers, comparedAt: { previous: previous.capturedAt, current: current.capturedAt } };
}

// ---------------------------------------------------------------------------
// Why — correlated signals in the same window
// ---------------------------------------------------------------------------

export async function explainMovement(playerId: string, since: Date): Promise<string[]> {
  const reasons: string[] = [];

  const [depthChart, injuries, trends, evidence] = await Promise.all([
    prisma.depthChartEntry.findMany({
      where: { playerId, effectiveAt: { gte: since } },
      orderBy: { effectiveAt: 'asc' },
      take: 5,
    }),
    prisma.injuryReport.findMany({
      where: { playerId, reportedAt: { gte: since } },
      orderBy: { reportedAt: 'asc' },
      take: 5,
    }),
    prisma.marketTrend.findMany({
      where: { playerId, source: 'sleeper', capturedAt: { gte: since } },
      orderBy: { capturedAt: 'asc' },
    }),
    prisma.evidence.findMany({
      where: { playerId, observedAt: { gte: since } },
      orderBy: { observedAt: 'desc' },
      take: 3,
    }),
  ]);

  if (depthChart.length) {
    const first = depthChart[0];
    const last = depthChart[depthChart.length - 1];
    if (depthChart.length > 1 && first.rank !== last.rank) {
      reasons.push(
        `Depth chart moved from ${first.position}${first.rank} to ${last.position}${last.rank}.`,
      );
    } else {
      reasons.push(`Listed at ${last.position}${last.rank} on the depth chart.`);
    }
  }

  for (const inj of injuries) {
    reasons.push(
      inj.status
        ? `Injury status changed to ${inj.status}${inj.bodyPart ? ` (${inj.bodyPart})` : ''}.`
        : 'Cleared an injury designation.',
    );
  }

  if (trends.length) {
    const latest = trends[trends.length - 1];
    const earliest = trends[0];
    const addDelta = (latest.addCount ?? 0) - (earliest.addCount ?? 0);
    if (trends.length > 1 && addDelta > 500) {
      reasons.push(`Add rate spiked on Sleeper (+${addDelta.toLocaleString()} adds in the window).`);
    } else if (latest.addCount && latest.addCount > 2000) {
      reasons.push(`Being added heavily on Sleeper (${latest.addCount.toLocaleString()} adds).`);
    }
  }

  for (const e of evidence) {
    reasons.push(`Your note: "${e.headline}"${e.sourceName ? ` (${e.sourceName})` : ''}.`);
  }

  return reasons;
}

/** List sources that actually have 2+ ranking/ADP batches, so the UI only offers ones that will work. */
export async function sourcesWithHistory(season: string): Promise<{ source: string; batches: number }[]> {
  const rows = await prisma.ranking.groupBy({
    by: ['source'],
    where: { season },
    _count: { _all: true },
  });

  const out: { source: string; batches: number }[] = [];
  for (const r of rows) {
    const batches = await prisma.ranking.findMany({
      where: { source: r.source, season },
      select: { capturedAt: true },
      distinct: ['capturedAt'],
    });
    if (batches.length >= 2) out.push({ source: r.source, batches: batches.length });
  }
  return out;
}

/** Small helper so callers don't need to know about the paramsJson shape. */
export async function latestValuationParams(runId: string) {
  const run = await prisma.valuationRun.findUnique({ where: { id: runId } });
  return readJson<Record<string, unknown>>(run?.paramsJson, {});
}
