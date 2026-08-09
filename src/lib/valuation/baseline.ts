import type { ScoringFormat, SkillPosition } from '../enums';

/**
 * Baseline projections from positional rank.
 *
 * THIS IS A FALLBACK, NOT A PROJECTION SOURCE. Its only job is to make the app
 * useful on first boot, before any FTN/FantasyPros export has been imported.
 * The moment real projections exist for a player, the engine prefers them and
 * this curve is unused for that player (see engine.ts `blendProjections`).
 *
 * The model is a two-parameter decay fitted to the *shape* of recent full-PPR
 * finishes — a steep drop through the top of each position flattening into a
 * long replacement-level tail:
 *
 *     points(rank) = floor + (peak - floor) * exp(-(rank - 1) / decay)
 *
 * The shape is what matters for draft decisions: VORP, tiers and scarcity all
 * depend on the *gaps* between ranks, not the absolute totals. Treat the
 * absolute numbers as indicative only, and import real projections before
 * relying on them. `isBaseline` is carried through to the UI so a number that
 * came from here is always labelled as such.
 */

interface Curve {
  peak: number;
  floor: number;
  decay: number;
}

/** Full-PPR, 17-game season. */
const PPR_CURVES: Record<SkillPosition, Curve> = {
  QB: { peak: 390, floor: 175, decay: 11 },
  RB: { peak: 330, floor: 55, decay: 13 },
  WR: { peak: 320, floor: 55, decay: 18 },
  TE: { peak: 260, floor: 45, decay: 7 },
};

/**
 * Receptions are the only meaningful format lever. Approximate per-position
 * reception volume so HALF/STD shift pass-catchers down relative to backs
 * without needing a second set of curves.
 */
const RECEPTIONS_BY_POSITION: Record<SkillPosition, number> = {
  QB: 0,
  RB: 40,
  WR: 70,
  TE: 55,
};

export function baselinePoints(
  position: SkillPosition,
  positionRank: number,
  format: ScoringFormat = 'PPR',
): number {
  const curve = PPR_CURVES[position];
  if (!curve || positionRank < 1) return 0;

  const pprPoints = curve.floor + (curve.peak - curve.floor) * Math.exp(-(positionRank - 1) / curve.decay);

  if (format === 'PPR' || format === 'SUPERFLEX') return pprPoints;

  // Scale expected receptions down with rank the same way points decay, then
  // remove the reception points this format doesn't award.
  const recAtRank =
    RECEPTIONS_BY_POSITION[position] * Math.exp(-(positionRank - 1) / (curve.decay * 2));
  const removedPerRec = format === 'HALF' ? 0.5 : 1;
  return Math.max(0, pprPoints - recAtRank * removedPerRec);
}

/**
 * Convert an overall ADP into a positional rank estimate, so a player who only
 * has ADP (no projection, no positional ranking) still lands somewhere sane on
 * the board instead of at zero.
 */
export function positionRankFromAdp(
  adp: number,
  position: SkillPosition,
  allAdpForPosition: number[],
): number {
  const sorted = [...allAdpForPosition].sort((a, b) => a - b);
  const idx = sorted.findIndex((a) => a >= adp);
  return (idx === -1 ? sorted.length : idx) + 1;
}

/** Rough boom/bust band around a projection, widening down the board. */
export function baselineRange(points: number, position: SkillPosition): { floor: number; ceiling: number } {
  // TEs and RBs are more volatile week to week; QBs least.
  const volatility: Record<SkillPosition, number> = { QB: 0.18, RB: 0.32, WR: 0.3, TE: 0.34 };
  const v = volatility[position];
  return { floor: points * (1 - v), ceiling: points * (1 + v) };
}
