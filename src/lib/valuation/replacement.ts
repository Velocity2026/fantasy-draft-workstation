import type { RosterShape } from '../config';
import type { SkillPosition } from '../enums';
import { SKILL_POSITIONS } from '../enums';

/**
 * Replacement level — the single most important number in the whole valuation.
 *
 * VORP is "points above the guy you could have had instead". Get replacement
 * level wrong and every downstream number is wrong, so this is computed from
 * the league's *actual* roster settings rather than a rule of thumb.
 *
 * For a 10-team league starting 1QB/2RB/3WR/1TE/1FLEX, the naive answer is
 * "the 10th QB, 20th RB, 30th WR, 10th TE". That understates RB/WR scarcity
 * because the FLEX slot consumes another ten RB/WR/TE bodies, and it ignores
 * that managers carry backups. Three methods are offered:
 *
 *   STARTER_COUNT — pure starters. Simplest, understates flex-position scarcity.
 *   BLENDED       — starters + flex demand distributed by how often each
 *                   position actually fills flex, + a fraction of bench demand.
 *                   This is the default and the one that behaves best in a
 *                   shallow 10-team league.
 *   LAST_STARTER  — the worst player who would start in any lineup on a given
 *                   week. Aggressive; makes elite players look enormous.
 */

export type ReplacementMethod = 'STARTER_COUNT' | 'BLENDED' | 'LAST_STARTER';

/**
 * Share of FLEX slots filled by each position in a full-PPR league. RB and WR
 * dominate; TE only when a manager rosters an elite one.
 */
const FLEX_SHARE: Record<SkillPosition, number> = { QB: 0, RB: 0.42, WR: 0.5, TE: 0.08 };

/** Share of bench slots typically spent on each position. */
const BENCH_SHARE: Record<SkillPosition, number> = { QB: 0.12, RB: 0.4, WR: 0.38, TE: 0.1 };

/** How much bench demand counts toward replacement level under BLENDED. */
const BENCH_WEIGHT = 0.35;

export interface ReplacementLevels {
  /** Positional rank that defines replacement, e.g. { RB: 28.4, WR: 38.1 }. */
  rank: Record<SkillPosition, number>;
  /** Projected points at that rank. */
  points: Record<SkillPosition, number>;
  method: ReplacementMethod;
}

/** How many of each position the league demands before quality runs out. */
export function positionalDemand(
  shape: RosterShape,
  method: ReplacementMethod,
): Record<SkillPosition, number> {
  const demand = {} as Record<SkillPosition, number>;
  const teams = shape.teams;

  for (const pos of SKILL_POSITIONS) {
    const startersAtPos = shape.starters[pos] ?? 0;
    let count = startersAtPos * teams;

    if (method === 'STARTER_COUNT') {
      demand[pos] = count;
      continue;
    }

    // FLEX and SUPER_FLEX add real demand at the positions eligible for them.
    const flexSlots = shape.flex * teams;
    count += flexSlots * FLEX_SHARE[pos];
    if (shape.superFlex > 0) {
      // Superflex is overwhelmingly a second QB.
      const sfSlots = shape.superFlex * teams;
      count += pos === 'QB' ? sfSlots * 0.85 : sfSlots * 0.05;
    }

    if (method === 'BLENDED') {
      count += shape.benchSlots * teams * BENCH_SHARE[pos] * BENCH_WEIGHT;
    }

    demand[pos] = count;
  }

  if (method === 'LAST_STARTER') {
    // Pull back to the last player who would realistically start, which is a
    // touch below raw starter+flex demand.
    for (const pos of SKILL_POSITIONS) demand[pos] = Math.max(1, demand[pos] * 0.9);
  }

  return demand;
}

/**
 * Compute replacement points by looking up the demand-th best projected player
 * at each position from the actual projection pool. Interpolates between the
 * two neighbouring ranks so a fractional demand (28.4) doesn't quantise.
 */
export function computeReplacementLevels(args: {
  shape: RosterShape;
  method: ReplacementMethod;
  /** Projected points per position, each array sorted descending. */
  pointsByPosition: Record<SkillPosition, number[]>;
}): ReplacementLevels {
  const demand = positionalDemand(args.shape, args.method);
  const rank = {} as Record<SkillPosition, number>;
  const points = {} as Record<SkillPosition, number>;

  for (const pos of SKILL_POSITIONS) {
    const pool = args.pointsByPosition[pos] ?? [];
    const d = Math.max(1, demand[pos]);
    rank[pos] = d;
    points[pos] = interpolateAtRank(pool, d);
  }

  return { rank, points, method: args.method };
}

/** Value at a fractional rank in a descending-sorted array. */
export function interpolateAtRank(sortedDesc: number[], rank: number): number {
  if (!sortedDesc.length) return 0;
  const idx = rank - 1; // rank 1 == index 0
  if (idx <= 0) return sortedDesc[0];
  if (idx >= sortedDesc.length - 1) return sortedDesc[sortedDesc.length - 1];
  const lo = Math.floor(idx);
  const hi = lo + 1;
  const frac = idx - lo;
  return sortedDesc[lo] + (sortedDesc[hi] - sortedDesc[lo]) * frac;
}

/**
 * Scarcity index: how steeply value is falling at replacement level right now.
 * A high number means waiting at this position costs a lot — the signal behind
 * "positional run" warnings in the draft room.
 *
 * Measured as points lost per pick over the next `window` players at that
 * position, normalised against the steepest position so it reads 0..1.
 */
export function scarcityIndex(pool: number[], atRank: number, window = 8): number {
  const start = interpolateAtRank(pool, atRank);
  const end = interpolateAtRank(pool, atRank + window);
  return Math.max(0, (start - end) / window);
}

export function normaliseScarcity(raw: Record<SkillPosition, number>): Record<SkillPosition, number> {
  const max = Math.max(...Object.values(raw), 0.0001);
  const out = {} as Record<SkillPosition, number>;
  for (const pos of SKILL_POSITIONS) out[pos] = raw[pos] / max;
  return out;
}
