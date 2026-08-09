import { prisma } from '../db';
import { gaussian, snakePickNo } from '../utils';
import { SKILL_POSITIONS, type DraftStrategy, type SkillPosition } from '../enums';
import type { RosterShape } from '../config';
import type { ValuationRowWithPlayer } from '../valuation/engine';
import { computeNeeds, buildRosterState } from './advisor';
import { writeJson } from '../json';

/**
 * Monte Carlo mock draft.
 *
 * The output that matters is not "here is one mock draft" — it's the
 * distribution: **if I take a WR at 1.04, what are the odds my RB target is
 * still there at 2.07?** That question can only be answered by running the
 * draft many times with realistic opponent behaviour.
 *
 * Opponent model, per pick:
 *   1. Score every available player by ADP with gaussian noise. Noise sigma
 *      comes from observed ADP spread, widened for managers whose historical
 *      picks track ADP poorly (ManagerProfile.predictabilityR2).
 *   2. Bend that by roster need, using the same need model the advisor uses —
 *      opponents fill starting slots too.
 *   3. Take the best-scoring player.
 *
 * My own picks follow the configured strategy against real VORP, which is what
 * makes "compare Zero RB vs Robust RB from slot 4" a meaningful experiment.
 */

export interface SimPlayer {
  playerId: string;
  position: SkillPosition;
  vorp: number;
  adp: number;
  adpStdDev: number;
  name: string;
}

export interface SimulationParams {
  leagueId: string;
  season: string;
  board: ValuationRowWithPlayer[];
  shape: RosterShape;
  teams: number;
  rounds: number;
  myDraftSlot: number;
  strategy: DraftStrategy;
  iterations: number;
  /** Players already gone (keepers, or a draft in progress). */
  unavailable?: Set<string>;
  /** Overall pick numbers consumed by keepers and therefore skipped. */
  consumedPicks?: Set<number>;
  /** Per-manager predictability, keyed by draft slot. 1 = follows ADP exactly. */
  predictabilityBySlot?: Map<number, number>;
  /** Force these players to me when available, in priority order. */
  mustDraft?: string[];
  needWeight?: number;
}

export interface SimulationResult {
  iterations: number;
  /** P(available) for each player at each of my pick numbers. */
  availability: { playerId: string; pickNo: number; availabilityPct: number; avgPickTaken: number | null; timesTaken: number }[];
  /** One representative draft (the run closest to the median outcome). */
  representative: { pickNo: number; round: number; draftSlot: number; playerId: string; isMine: boolean }[];
  myOutcomes: {
    avgStartingPoints: number;
    p10StartingPoints: number;
    p90StartingPoints: number;
    positionCounts: Record<string, number>;
    mostCommonByRound: { round: number; playerId: string; name: string; pct: number }[];
  };
}

export function simulate(params: SimulationParams): SimulationResult {
  const teams = params.teams;
  const rounds = params.rounds;
  const totalPicks = teams * rounds;

  const pool: SimPlayer[] = params.board
    .filter((p) => !params.unavailable?.has(p.playerId))
    .filter((p) => (SKILL_POSITIONS as readonly string[]).includes(p.position))
    .map((p) => ({
      playerId: p.playerId,
      position: p.position as SkillPosition,
      vorp: p.vorp,
      // A player with no ADP is assumed to go around where we rank him.
      adp: p.adp ?? p.overallRank,
      adpStdDev: Math.max(4, (p.adp ?? p.overallRank) * 0.22),
      name: p.fullName,
    }));

  const myPickNos = new Set(
    Array.from({ length: rounds }, (_, i) => snakePickNo(i + 1, params.myDraftSlot, teams)).filter(
      (p) => !params.consumedPicks?.has(p),
    ),
  );

  // Accumulators
  const timesAvailable = new Map<string, Map<number, number>>();
  const takenPickSum = new Map<string, number>();
  const takenCount = new Map<string, number>();
  const myPicksByRound = new Map<number, Map<string, number>>();
  const startingPointsRuns: number[] = [];
  const positionCountTotals: Record<string, number> = {};
  let representative: SimulationResult['representative'] = [];
  let representativeScore = Number.NaN;

  for (let iter = 0; iter < params.iterations; iter += 1) {
    const available = new Map(pool.map((p) => [p.playerId, p]));
    const rosters = new Map<number, { playerId: string; position: string }[]>();
    for (let slot = 1; slot <= teams; slot += 1) rosters.set(slot, []);
    const thisRun: SimulationResult['representative'] = [];

    for (let pickNo = 1; pickNo <= totalPicks; pickNo += 1) {
      if (params.consumedPicks?.has(pickNo)) continue;

      const round = Math.floor((pickNo - 1) / teams) + 1;
      const slotInRound = ((pickNo - 1) % teams) + 1;
      const slot = round % 2 === 0 ? teams - slotInRound + 1 : slotInRound;
      const isMine = myPickNos.has(pickNo);

      // Record availability at my picks before anyone is removed this pick.
      if (isMine) {
        for (const playerId of available.keys()) {
          const byPick = timesAvailable.get(playerId) ?? new Map<number, number>();
          byPick.set(pickNo, (byPick.get(pickNo) ?? 0) + 1);
          timesAvailable.set(playerId, byPick);
        }
      }

      const roster = rosters.get(slot)!;
      const picked = isMine
        ? chooseMyPick(available, roster, params, round)
        : chooseOpponentPick(available, roster, params, slot, pickNo);

      if (!picked) continue;

      available.delete(picked.playerId);
      roster.push({ playerId: picked.playerId, position: picked.position });
      thisRun.push({ pickNo, round, draftSlot: slot, playerId: picked.playerId, isMine });

      takenPickSum.set(picked.playerId, (takenPickSum.get(picked.playerId) ?? 0) + pickNo);
      takenCount.set(picked.playerId, (takenCount.get(picked.playerId) ?? 0) + 1);

      if (isMine) {
        const byRound = myPicksByRound.get(round) ?? new Map<string, number>();
        byRound.set(picked.playerId, (byRound.get(picked.playerId) ?? 0) + 1);
        myPicksByRound.set(round, byRound);
      }
    }

    // Score my resulting roster by best-ball starting lineup points.
    const mine = thisRun.filter((p) => p.isMine);
    const myPlayers = mine
      .map((p) => pool.find((x) => x.playerId === p.playerId))
      .filter((p): p is SimPlayer => !!p);
    const starting = startingLineupValue(myPlayers, params.shape);
    startingPointsRuns.push(starting);

    for (const p of myPlayers) positionCountTotals[p.position] = (positionCountTotals[p.position] ?? 0) + 1;

    // Keep the run whose outcome is closest to the running mean as the
    // representative draft to display.
    if (Number.isNaN(representativeScore) || Math.abs(starting - mean(startingPointsRuns)) < representativeScore) {
      representativeScore = Math.abs(starting - mean(startingPointsRuns));
      representative = thisRun;
    }
  }

  // --- Aggregate ---------------------------------------------------------
  const availability: SimulationResult['availability'] = [];
  for (const [playerId, byPick] of timesAvailable) {
    for (const [pickNo, count] of byPick) {
      const pct = count / params.iterations;
      // Only keep meaningful rows — every player is 100% available at pick 1.
      if (pct < 0.02) continue;
      availability.push({
        playerId,
        pickNo,
        availabilityPct: pct,
        avgPickTaken: takenCount.get(playerId)
          ? takenPickSum.get(playerId)! / takenCount.get(playerId)!
          : null,
        timesTaken: takenCount.get(playerId) ?? 0,
      });
    }
  }

  const sortedPoints = [...startingPointsRuns].sort((a, b) => a - b);
  const nameById = new Map(pool.map((p) => [p.playerId, p.name]));

  const mostCommonByRound = [...myPicksByRound.entries()]
    .map(([round, byPlayer]) => {
      const [playerId, count] = [...byPlayer.entries()].sort((a, b) => b[1] - a[1])[0];
      return { round, playerId, name: nameById.get(playerId) ?? playerId, pct: count / params.iterations };
    })
    .sort((a, b) => a.round - b.round);

  const positionCounts: Record<string, number> = {};
  for (const [pos, total] of Object.entries(positionCountTotals)) {
    positionCounts[pos] = total / params.iterations;
  }

  return {
    iterations: params.iterations,
    availability,
    representative,
    myOutcomes: {
      avgStartingPoints: mean(startingPointsRuns),
      p10StartingPoints: percentile(sortedPoints, 0.1),
      p90StartingPoints: percentile(sortedPoints, 0.9),
      positionCounts,
      mostCommonByRound,
    },
  };
}

// ---------------------------------------------------------------------------
// Pick selection
// ---------------------------------------------------------------------------

function chooseOpponentPick(
  available: Map<string, SimPlayer>,
  roster: { playerId: string; position: string }[],
  params: SimulationParams,
  slot: number,
  pickNo: number,
): SimPlayer | null {
  const state = buildRosterState(
    roster.map((r) => ({ playerId: r.playerId, position: r.position })),
    null,
  );
  const picksRemaining = params.rounds - roster.length;
  const needs = computeNeeds(state, params.shape, 'BALANCED', picksRemaining);

  // Managers who historically track ADP closely get less noise.
  const predictability = params.predictabilityBySlot?.get(slot) ?? 0.5;
  const noiseScale = 1.6 - predictability; // 0.6 (very predictable) .. 1.6

  let best: SimPlayer | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const player of available.values()) {
    // Far-off players can't win this pick; skip the maths for speed.
    if (player.adp > pickNo + 60) continue;

    const noisyAdp = player.adp + gaussian(0, player.adpStdDev * noiseScale);
    // Lower ADP is better, so invert into a score.
    const adpScore = -noisyAdp;
    const need = needs[player.position] ?? 1;
    const score = adpScore * (2 - need * 0.45);

    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }

  return best ?? available.values().next().value ?? null;
}

function chooseMyPick(
  available: Map<string, SimPlayer>,
  roster: { playerId: string; position: string }[],
  params: SimulationParams,
  round: number,
): SimPlayer | null {
  // Honour explicit targets first, if still on the board.
  if (params.mustDraft?.length) {
    for (const wanted of params.mustDraft) {
      if (available.has(wanted) && !roster.some((r) => r.playerId === wanted)) {
        return available.get(wanted)!;
      }
    }
  }

  const state = buildRosterState(
    roster.map((r) => ({ playerId: r.playerId, position: r.position })),
    null,
  );
  const picksRemaining = params.rounds - roster.length;
  const needs = computeNeeds(state, params.shape, params.strategy, picksRemaining);
  const needWeight = params.needWeight ?? 0.35;

  let best: SimPlayer | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const player of available.values()) {
    const need = needs[player.position] ?? 1;
    // Slight noise so repeated iterations explore near-ties rather than always
    // producing the identical draft.
    const score = player.vorp * (1 + (need - 1) * needWeight) + gaussian(0, 2);
    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }

  void round;
  return best;
}

/**
 * Best-ball starting lineup value: fill each required slot with the best
 * remaining player, then flex. This is the fair way to compare two draft
 * strategies — total roster points rewards hoarding depth that never starts.
 */
function startingLineupValue(players: SimPlayer[], shape: RosterShape): number {
  const byPos = new Map<SkillPosition, SimPlayer[]>();
  for (const pos of SKILL_POSITIONS) {
    byPos.set(
      pos,
      players.filter((p) => p.position === pos).sort((a, b) => b.vorp - a.vorp),
    );
  }

  let total = 0;
  const used = new Set<string>();

  for (const pos of SKILL_POSITIONS) {
    const required = shape.starters[pos] ?? 0;
    const list = byPos.get(pos) ?? [];
    for (let i = 0; i < required && i < list.length; i += 1) {
      total += list[i].vorp;
      used.add(list[i].playerId);
    }
  }

  const flexPool = players
    .filter((p) => !used.has(p.playerId) && ['RB', 'WR', 'TE'].includes(p.position))
    .sort((a, b) => b.vorp - a.vorp);
  for (let i = 0; i < shape.flex && i < flexPool.length; i += 1) total += flexPool[i].vorp;

  return total;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * sortedAsc.length)));
  return sortedAsc[idx];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function runAndSaveMock(args: {
  leagueId: string;
  season: string;
  name: string;
  params: SimulationParams;
}) {
  const result = simulate(args.params);

  const mock = await prisma.mockDraft.create({
    data: {
      leagueId: args.leagueId,
      season: args.season,
      name: args.name,
      myDraftSlot: args.params.myDraftSlot,
      teams: args.params.teams,
      rounds: args.params.rounds,
      strategy: args.params.strategy,
      iterations: args.params.iterations,
      paramsJson: writeJson({
        needWeight: args.params.needWeight,
        mustDraft: args.params.mustDraft,
        unavailable: [...(args.params.unavailable ?? [])],
      }),
      summaryJson: writeJson(result.myOutcomes),
    },
  });

  const CHUNK = 500;
  for (let i = 0; i < result.availability.length; i += CHUNK) {
    await prisma.mockAvailability.createMany({
      data: result.availability.slice(i, i + CHUNK).map((a) => ({
        mockDraftId: mock.id,
        playerId: a.playerId,
        pickNo: a.pickNo,
        availabilityPct: a.availabilityPct,
        avgPickTaken: a.avgPickTaken,
        timesTaken: a.timesTaken,
      })),
    });
  }

  await prisma.mockPick.createMany({
    data: result.representative.map((p) => ({
      mockDraftId: mock.id,
      iteration: 0,
      pickNo: p.pickNo,
      round: p.round,
      draftSlot: p.draftSlot,
      playerId: p.playerId,
      isMine: p.isMine,
    })),
  });

  return { mockDraftId: mock.id, result };
}

/** Manager predictability by draft slot, for the opponent model. */
export async function predictabilityBySlot(
  leagueId: string,
  slotToRoster: Record<string, number>,
): Promise<Map<number, number>> {
  const rosters = await prisma.leagueRoster.findMany({ where: { leagueId }, select: { rosterId: true, memberId: true } });
  const profiles = await prisma.managerProfile.findMany({ where: { leagueId } });
  const byMember = new Map(profiles.map((p) => [p.memberId, p.predictabilityR2]));
  const rosterToMember = new Map(rosters.map((r) => [r.rosterId, r.memberId]));

  const out = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(slotToRoster)) {
    const memberId = rosterToMember.get(rosterId);
    const r2 = memberId ? byMember.get(memberId) : null;
    out.set(Number(slot), r2 ?? 0.5);
  }
  return out;
}
