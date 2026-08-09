/**
 * Tiering.
 *
 * Tiers matter more than ranks on draft day. The question is never "is Player A
 * better than Player B" — it's "if I wait, will I still get someone from this
 * group?". So tier boundaries are placed at *gaps* in value, not at fixed
 * intervals.
 *
 * Method: 1-D Jenks-style natural breaks, seeded by gap size. We walk the
 * descending value list, and start a new tier when the drop to the next player
 * is large relative to the typical drop in this neighbourhood. A local (rolling)
 * baseline is used rather than a global one because the top of a position has
 * much bigger absolute gaps than the tail, and a global threshold would put the
 * entire back half of the board in one tier.
 */

export interface TierOptions {
  /** A gap this many times the local median gap starts a new tier. */
  sensitivity?: number;
  /** Rolling window used to measure the local typical gap. */
  window?: number;
  minTierSize?: number;
  maxTiers?: number;
}

export function assignTiers(valuesDesc: number[], opts: TierOptions = {}): number[] {
  const sensitivity = opts.sensitivity ?? 1.7;
  const window = opts.window ?? 12;
  const minTierSize = opts.minTierSize ?? 1;
  const maxTiers = opts.maxTiers ?? 24;

  const n = valuesDesc.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i += 1) gaps.push(Math.max(0, valuesDesc[i] - valuesDesc[i + 1]));

  const tiers = new Array<number>(n);
  let tier = 1;
  let sizeInTier = 0;

  for (let i = 0; i < n; i += 1) {
    tiers[i] = tier;
    sizeInTier += 1;

    if (i >= n - 1) break;

    const localGaps = gaps.slice(Math.max(0, i - window), Math.min(gaps.length, i + window));
    const baseline = median(localGaps.filter((g) => g > 0));
    const isBreak = baseline > 0 && gaps[i] >= baseline * sensitivity;

    if (isBreak && sizeInTier >= minTierSize && tier < maxTiers) {
      tier += 1;
      sizeInTier = 0;
    }
  }

  return tiers;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Players remaining in the current tier at a position. This is the number that
 * actually drives a draft decision: "4 left in this RB tier, 2 picks until my
 * turn" means wait; "1 left" means take him now.
 */
export interface TierRun {
  tier: number;
  remaining: number;
  /** Value drop to the next tier — what waiting actually costs. */
  cliff: number;
}

export function tierRun(
  available: { tier: number; value: number }[],
): TierRun | null {
  if (!available.length) return null;
  const sorted = [...available].sort((a, b) => b.value - a.value);
  const topTier = sorted[0].tier;
  const inTier = sorted.filter((p) => p.tier === topTier);
  const nextTier = sorted.find((p) => p.tier !== topTier);
  const cliff = nextTier ? inTier[inTier.length - 1].value - nextTier.value : 0;
  return { tier: topTier, remaining: inTier.length, cliff: Math.max(0, cliff) };
}
