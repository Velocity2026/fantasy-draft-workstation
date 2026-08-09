import { SKILL_POSITIONS, type SkillPosition, type DraftStrategy } from '../enums';
import type { RosterShape } from '../config';
import type { ValuationRowWithPlayer } from '../valuation/engine';
import { tierRun, type TierRun } from '../valuation/tiers';
import { snakePicksForSlot } from '../utils';

/**
 * Draft advisor — the thing you actually stare at while on the clock.
 *
 * The central idea is VONA (Value Over Next Available), not VORP. VORP tells
 * you how good a player is in the abstract. VONA tells you what taking him
 * *now* buys you over taking the best player at that position at your next
 * pick — which is the real decision, because you can't have everyone.
 *
 *     VONA(player) = player.vorp - E[best available VORP at that position
 *                                    when my next pick comes around]
 *
 * The expectation is computed from availability probabilities. Those come from
 * the mock simulator when one has been run, and otherwise from a closed-form
 * ADP model: P(still available at pick N) using a normal distribution around
 * each player's ADP.
 */

export interface RosterState {
  rosterId: number | null;
  /** Drafted players, in pick order. */
  players: { playerId: string; position: string }[];
  counts: Record<string, number>;
}

export interface AdvisorContext {
  board: ValuationRowWithPlayer[];
  drafted: Set<string>;
  shape: RosterShape;
  myRosterState: RosterState;
  /** Overall pick numbers still belonging to me, ascending. */
  myUpcomingPicks: number[];
  currentPickNo: number;
  strategy: DraftStrategy;
  /** 0..1 — how much roster need bends the ranking away from pure value. */
  needWeight: number;
  /** Manual board overrides, keyed by playerId. */
  overrides: Map<string, { userRank: number | null; status: string; isDoNotDraft: boolean }>;
  boardOverrideWeight: number;
}

export interface Suggestion {
  player: ValuationRowWithPlayer;
  /** Final sort key — this is what orders the recommendation list. */
  score: number;
  vona: number;
  needMultiplier: number;
  availabilityAtNextPick: number;
  classification: 'TARGET' | 'VALUE' | 'REACH' | 'AVOID' | 'HANDCUFF' | 'UPSIDE_SWING' | 'SAFE_FLOOR';
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Availability model
// ---------------------------------------------------------------------------

/**
 * P(player survives until pick `targetPick`) given his ADP.
 *
 * Modelled as 1 - Phi((targetPick - adp) / sigma): if the target pick is well
 * past his ADP he's almost certainly gone. Sigma comes from observed ADP spread
 * where we have it, and widens with ADP otherwise, because late-round picks are
 * far less predictable than early ones.
 */
export function availabilityAt(
  player: { adp: number | null; adpDelta: number | null; overallRank: number },
  targetPick: number,
): number {
  const adp = player.adp ?? player.overallRank;
  const sigma = Math.max(4, adp * 0.22);
  const z = (targetPick - adp) / sigma;
  return clamp01(1 - normalCdf(z));
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Expected best VORP available at `targetPick` for a position: sum over
 * candidates of P(this guy is the best one still there) * his VORP.
 */
export function expectedBestAvailable(
  candidates: ValuationRowWithPlayer[],
  targetPick: number,
): number {
  const sorted = [...candidates].sort((a, b) => b.vorp - a.vorp);
  let survivalOfAllBetter = 1;
  let expected = 0;

  for (const c of sorted) {
    const pAvailable = availabilityAt(c, targetPick);
    // He is the best available iff he survives AND everyone better did not.
    const pIsBest = pAvailable * survivalOfAllBetter;
    expected += pIsBest * c.vorp;
    survivalOfAllBetter *= 1 - pAvailable;
    if (survivalOfAllBetter < 0.001) break;
  }

  return expected;
}

// ---------------------------------------------------------------------------
// Roster need
// ---------------------------------------------------------------------------

/**
 * How badly each position is needed, as a multiplier on value.
 *
 * Starters are weighted heavily until filled, then need decays. A position with
 * every starting slot filled still carries some weight (bench/upside), never
 * zero — otherwise the advisor refuses to take an obviously superior player.
 */
export function computeNeeds(
  state: RosterState,
  shape: RosterShape,
  strategy: DraftStrategy,
  picksRemaining: number,
): Record<SkillPosition, number> {
  const needs = {} as Record<SkillPosition, number>;

  // Flex demand is attributed to the positions that can fill it.
  const flexEligible: SkillPosition[] = ['RB', 'WR', 'TE'];

  for (const pos of SKILL_POSITIONS) {
    const required = shape.starters[pos] ?? 0;
    const have = state.counts[pos] ?? 0;
    const shortfall = Math.max(0, required - have);

    let need = 1;
    if (shortfall > 0) {
      // Urgency rises as the draft runs out of room to fix it.
      const urgency = picksRemaining > 0 ? Math.min(1, (shortfall * 2) / picksRemaining) : 1;
      need = 1 + shortfall * 0.45 + urgency * 0.5;
    } else {
      // Starters filled — value depth, but at a discount that grows with each
      // extra body already rostered.
      const surplus = have - required;
      need = Math.max(0.55, 1 - surplus * 0.14);
    }

    // Unfilled flex slots keep RB/WR/TE relevant after their own slots are full.
    if (flexEligible.includes(pos)) {
      const flexCapable = flexEligible.reduce(
        (sum, p) => sum + Math.max(0, (state.counts[p] ?? 0) - (shape.starters[p] ?? 0)),
        0,
      );
      const flexShortfall = Math.max(0, shape.flex - flexCapable);
      if (flexShortfall > 0 && shortfall === 0) need += 0.2 * flexShortfall;
    }

    needs[pos] = need;
  }

  applyStrategy(needs, state, shape, strategy);
  return needs;
}

/**
 * Strategy bends the need curve rather than hard-blocking positions. A strategy
 * that refuses to take a falling elite player is a strategy that loses drafts,
 * so every adjustment here is a multiplier, never a veto.
 */
function applyStrategy(
  needs: Record<SkillPosition, number>,
  state: RosterState,
  shape: RosterShape,
  strategy: DraftStrategy,
) {
  const rbCount = state.counts.RB ?? 0;
  const totalPicks = state.players.length;

  switch (strategy) {
    case 'ZERO_RB':
      if (totalPicks < 5) {
        needs.RB *= 0.45;
        needs.WR *= 1.35;
        needs.TE *= 1.1;
      } else {
        needs.RB *= 1.3; // load up on backs once the early rounds are past
      }
      break;
    case 'HERO_RB':
      if (rbCount >= 1 && totalPicks < 6) needs.RB *= 0.5;
      if (rbCount === 0 && totalPicks < 2) needs.RB *= 1.4;
      if (totalPicks < 6) needs.WR *= 1.25;
      break;
    case 'ROBUST_RB':
      if (totalPicks < 5) {
        needs.RB *= 1.45;
        needs.WR *= 0.9;
      }
      break;
    case 'LATE_QB':
      if (totalPicks < 8 && (state.counts.QB ?? 0) === 0) needs.QB *= 0.35;
      break;
    case 'EARLY_TE':
      if ((state.counts.TE ?? 0) === 0 && totalPicks < 4) needs.TE *= 1.5;
      break;
    case 'BPA':
      for (const pos of SKILL_POSITIONS) needs[pos] = 1;
      break;
    case 'BALANCED':
    default:
      break;
  }

  // Hard cap: never recommend a 4th QB or 3rd TE in a 1-slot league.
  const cap: Partial<Record<SkillPosition, number>> = {
    QB: (shape.starters.QB ?? 1) + shape.superFlex + 1,
    TE: (shape.starters.TE ?? 1) + 1,
  };
  for (const [pos, max] of Object.entries(cap) as [SkillPosition, number][]) {
    if ((state.counts[pos] ?? 0) >= max) needs[pos] *= 0.15;
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export function buildSuggestions(ctx: AdvisorContext, limit = 40): Suggestion[] {
  const available = ctx.board.filter((p) => !ctx.drafted.has(p.playerId));
  const nextPick = ctx.myUpcomingPicks.find((p) => p > ctx.currentPickNo) ?? null;

  const picksRemaining = ctx.myUpcomingPicks.filter((p) => p >= ctx.currentPickNo).length;
  const needs = computeNeeds(ctx.myRosterState, ctx.shape, ctx.strategy, picksRemaining);

  // Expected best-available VORP per position at my next pick — the VONA baseline.
  const baselineAtNext = {} as Record<SkillPosition, number>;
  for (const pos of SKILL_POSITIONS) {
    const atPos = available.filter((p) => p.position === pos);
    baselineAtNext[pos] = nextPick === null ? 0 : expectedBestAvailable(atPos, nextPick);
  }

  const suggestions: Suggestion[] = available.map((player) => {
    const pos = player.position as SkillPosition;
    const vona = player.vorp - (baselineAtNext[pos] ?? 0);
    const needMultiplier = needs[pos] ?? 1;
    const availability = nextPick === null ? 0 : availabilityAt(player, nextPick);

    const override = ctx.overrides.get(player.playerId);
    const reasons: string[] = [];

    // Blend VORP and VONA: VONA alone over-rewards positions that are about to
    // empty out, VORP alone ignores the cost of waiting.
    let score = (player.vorp * 0.45 + Math.max(0, vona) * 0.55) * (1 + (needMultiplier - 1) * ctx.needWeight);

    if (override?.isDoNotDraft) {
      score = -1e6;
      reasons.push('Marked do-not-draft on your board.');
    } else if (override?.userRank != null) {
      // Pull the computed rank toward my manual rank. A manual rank is a strong
      // opinion and the app should respect it without discarding the maths.
      const impliedFromRank = Math.max(0, (available.length - override.userRank) / available.length);
      score = score * (1 - ctx.boardOverrideWeight) + score * impliedFromRank * ctx.boardOverrideWeight * 2;
      reasons.push(`Your board has him at #${override.userRank}.`);
    }

    if (override?.status === 'MUST_HAVE') {
      score *= 1.3;
      reasons.push('Flagged must-have.');
    } else if (override?.status === 'TARGET') {
      score *= 1.12;
      reasons.push('Flagged target.');
    } else if (override?.status === 'AVOID') {
      score *= 0.6;
      reasons.push('Flagged avoid.');
    }

    // --- Explanations -------------------------------------------------------
    if (player.adpDelta !== null && player.adpDelta > 8) {
      reasons.push(`Falling: market ADP ${player.adp?.toFixed(0)}, we rank him ${player.overallRank}.`);
    }
    if (nextPick !== null && availability < 0.25 && player.vorp > 0) {
      reasons.push(`Only ~${Math.round(availability * 100)}% likely to last until your pick at ${nextPick}.`);
    }
    if (vona > 15) {
      reasons.push(`Worth ${vona.toFixed(0)} VORP more than what you'd get at this position next time around.`);
    }
    if (needMultiplier > 1.3) {
      reasons.push(`You still need ${pos} starters.`);
    }
    if (player.isBaseline) {
      reasons.push('Projection is from the fallback curve — no imported projection for him.');
    }

    return {
      player,
      score,
      vona,
      needMultiplier,
      availabilityAtNextPick: availability,
      classification: classify(player, vona, availability, override?.status),
      reasons,
    };
  });

  return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}

function classify(
  player: ValuationRowWithPlayer,
  vona: number,
  availability: number,
  status: string | undefined,
): Suggestion['classification'] {
  if (status === 'AVOID' || status === 'DO_NOT_DRAFT') return 'AVOID';
  if (player.adpDelta !== null && player.adpDelta > 12) return 'VALUE';
  if (player.adpDelta !== null && player.adpDelta < -12) return 'REACH';
  if ((player.upsideScore ?? 0) > 0.55 && (player.riskScore ?? 0) > 0.3) return 'UPSIDE_SWING';
  if ((player.riskScore ?? 1) < 0.2 && (player.floorPoints ?? 0) > 0) return 'SAFE_FLOOR';
  if (vona > 20 || availability < 0.2) return 'TARGET';
  return 'TARGET';
}

// ---------------------------------------------------------------------------
// Run detection
// ---------------------------------------------------------------------------

export interface PositionRunAlert {
  position: SkillPosition;
  takenInLastN: number;
  windowSize: number;
  tierInfo: TierRun | null;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

/**
 * Detect a positional run in progress. Two managers taking RBs is noise; five
 * of the last eight picks being RBs means the position is emptying and the
 * cost of waiting just went up.
 */
export function detectRuns(args: {
  recentPicks: { position: string }[];
  available: ValuationRowWithPlayer[];
  windowSize?: number;
}): PositionRunAlert[] {
  const window = args.windowSize ?? 8;
  const recent = args.recentPicks.slice(-window);
  if (recent.length < 4) return [];

  const alerts: PositionRunAlert[] = [];

  for (const pos of SKILL_POSITIONS) {
    const taken = recent.filter((p) => p.position === pos).length;
    const rate = taken / recent.length;
    // Baseline expectation: roughly proportional to how many of each position
    // get drafted overall. Anything meaningfully above that is a run.
    const expected = pos === 'QB' ? 0.12 : pos === 'TE' ? 0.12 : 0.38;
    if (rate <= expected * 1.6 || taken < 3) continue;

    const atPos = args.available
      .filter((p) => p.position === pos)
      .map((p) => ({ tier: p.tier, value: p.vorp }));
    const run = tierRun(atPos);

    const severity: PositionRunAlert['severity'] =
      rate > expected * 2.4 ? 'HIGH' : rate > expected * 1.9 ? 'MEDIUM' : 'LOW';

    alerts.push({
      position: pos,
      takenInLastN: taken,
      windowSize: recent.length,
      tierInfo: run,
      severity,
      message: run
        ? `${taken} of the last ${recent.length} picks were ${pos}. ${run.remaining} left in the current tier${run.cliff > 8 ? `, then a ${run.cliff.toFixed(0)}-point cliff` : ''}.`
        : `${taken} of the last ${recent.length} picks were ${pos}.`,
    });
  }

  return alerts.sort((a, b) => b.takenInLastN - a.takenInLastN);
}

// ---------------------------------------------------------------------------
// Roster helpers
// ---------------------------------------------------------------------------

export function buildRosterState(
  picks: { playerId: string | null; position: string | null }[],
  rosterId: number | null,
): RosterState {
  const players = picks
    .filter((p): p is { playerId: string; position: string } => !!p.playerId && !!p.position)
    .map((p) => ({ playerId: p.playerId, position: p.position }));

  const counts: Record<string, number> = {};
  for (const p of players) counts[p.position] = (counts[p.position] ?? 0) + 1;

  return { rosterId, players, counts };
}

export function myPickNumbers(args: {
  draftSlot: number;
  teams: number;
  rounds: number;
  consumedByKeepers?: Set<number>;
}): number[] {
  const all = snakePicksForSlot(args.draftSlot, args.teams, args.rounds);
  if (!args.consumedByKeepers?.size) return all;
  return all.filter((p) => !args.consumedByKeepers!.has(p));
}
