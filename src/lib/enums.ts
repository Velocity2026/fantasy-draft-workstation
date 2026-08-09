/**
 * SQLite has no enum type, so every "enum" column in schema.prisma is a String
 * validated here. Keeping them as const objects + union types means we get
 * exhaustiveness checking in TypeScript and a single place to change when a new
 * module is added, without a database migration.
 */
import { z } from 'zod';

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
export type Position = (typeof POSITIONS)[number];
export const zPosition = z.enum(POSITIONS);

/** Positions we actually value and draft with intent. K/DEF are last-round noise. */
export const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
export type SkillPosition = (typeof SKILL_POSITIONS)[number];

export const SCORING_FORMATS = ['PPR', 'HALF', 'STD', 'SUPERFLEX'] as const;
export type ScoringFormat = (typeof SCORING_FORMATS)[number];
export const zScoringFormat = z.enum(SCORING_FORMATS);

export const RANKING_SCOPES = ['DRAFT', 'WEEKLY', 'ROS', 'DYNASTY', 'KEEPER'] as const;
export type RankingScope = (typeof RANKING_SCOPES)[number];

export const PROJECTION_SCOPES = ['SEASON', 'WEEKLY', 'ROS'] as const;
export type ProjectionScope = (typeof PROJECTION_SCOPES)[number];

export const VALUATION_SCOPES = ['DRAFT', 'KEEPER', 'ROS', 'WEEKLY'] as const;
export type ValuationScope = (typeof VALUATION_SCOPES)[number];

export const SEASON_TYPES = ['PRE', 'REG', 'POST'] as const;
export type SeasonType = (typeof SEASON_TYPES)[number];

// --- Evidence --------------------------------------------------------------

export const SUBJECT_TYPES = ['PLAYER', 'TEAM', 'LEAGUE', 'MEMBER', 'MATCHUP', 'TRADE_PACKAGE', 'LINEUP', 'ROSTER'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const EVIDENCE_TYPES = [
  'CAMP_REPORT',
  'BEAT_REPORT',
  'COACH_QUOTE',
  'USAGE_TREND',
  'DEPTH_CHART_MOVE',
  'INJURY',
  'TRANSACTION',
  'PRESEASON_USAGE',
  'MARKET_MOVE',
  'PROJECTION_DELTA',
  'SCHEME_CHANGE',
  'MANUAL_NOTE',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export const zEvidenceType = z.enum(EVIDENCE_TYPES);

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  CAMP_REPORT: 'Camp report',
  BEAT_REPORT: 'Beat report',
  COACH_QUOTE: 'Coach comment',
  USAGE_TREND: 'Usage trend',
  DEPTH_CHART_MOVE: 'Depth chart move',
  INJURY: 'Injury',
  TRANSACTION: 'Transaction',
  PRESEASON_USAGE: 'Preseason usage',
  MARKET_MOVE: 'Market move',
  PROJECTION_DELTA: 'Projection change',
  SCHEME_CHANGE: 'Scheme / staff change',
  MANUAL_NOTE: 'My note',
};

export const IMPACT_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

// --- Recommendations -------------------------------------------------------

export const MODULES = [
  'DRAFT',
  'KEEPER',
  'WAIVER',
  'BREAKOUT',
  'START_SIT',
  'TRADE',
  'ROS',
  'INJURY_REPLACEMENT',
  'LEAGUE_MONITOR',
] as const;
export type Module = (typeof MODULES)[number];

/** Draft-module classifications (implemented now). */
export const DRAFT_CLASSIFICATIONS = [
  'TARGET',
  'VALUE',
  'REACH',
  'AVOID',
  'HANDCUFF',
  'UPSIDE_SWING',
  'SAFE_FLOOR',
] as const;
export type DraftClassification = (typeof DRAFT_CLASSIFICATIONS)[number];

/**
 * Waiver-module classifications (Phase 10). Defined now so the Recommendation
 * table's `classification` values are stable from day one and any early rows
 * written by the draft-era code remain valid.
 */
export const WAIVER_CLASSIFICATIONS = [
  'IMMEDIATE_STARTER',
  'EARLY_BREAKOUT',
  'INJURY_AWAY_STASH',
  'ROLE_GROWTH_STASH',
  'SHORT_TERM_REPLACEMENT',
  'HIGH_UPSIDE_BENCH',
  'LOW_PRIORITY_SPEC',
  'AVOID_DESPITE_PRODUCTION',
] as const;
export type WaiverClassification = (typeof WAIVER_CLASSIFICATIONS)[number];

export const WAIVER_CLASSIFICATION_LABELS: Record<WaiverClassification, string> = {
  IMMEDIATE_STARTER: 'Immediate starter',
  EARLY_BREAKOUT: 'Early breakout target',
  INJURY_AWAY_STASH: 'Injury-away stash',
  ROLE_GROWTH_STASH: 'Role-growth stash',
  SHORT_TERM_REPLACEMENT: 'Short-term replacement',
  HIGH_UPSIDE_BENCH: 'High-upside bench add',
  LOW_PRIORITY_SPEC: 'Low-priority speculative add',
  AVOID_DESPITE_PRODUCTION: 'Avoid despite recent production',
};

// --- Board -----------------------------------------------------------------

export const BOARD_STATUSES = ['MUST_HAVE', 'TARGET', 'LIKE', 'NEUTRAL', 'AVOID', 'DO_NOT_DRAFT'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const zBoardStatus = z.enum(BOARD_STATUSES);

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  MUST_HAVE: 'Must have',
  TARGET: 'Target',
  LIKE: 'Like',
  NEUTRAL: 'Neutral',
  AVOID: 'Avoid',
  DO_NOT_DRAFT: 'Do not draft',
};

// --- Draft strategies ------------------------------------------------------

export const DRAFT_STRATEGIES = [
  'BALANCED',
  'ZERO_RB',
  'HERO_RB',
  'ROBUST_RB',
  'LATE_QB',
  'EARLY_TE',
  'BPA',
] as const;
export type DraftStrategy = (typeof DRAFT_STRATEGIES)[number];

export const DRAFT_STRATEGY_LABELS: Record<DraftStrategy, string> = {
  BALANCED: 'Balanced (value + need)',
  ZERO_RB: 'Zero RB',
  HERO_RB: 'Hero RB',
  ROBUST_RB: 'Robust RB',
  LATE_QB: 'Late QB',
  EARLY_TE: 'Early elite TE',
  BPA: 'Strict best player available',
};

// --- Functional roles (start/sit + matchup analysis, Phase 11) -------------

export const WR_ROLES = ['X', 'Z', 'SLOT', 'BIG_SLOT', 'MOVEMENT', 'VERTICAL'] as const;
export type WrRole = (typeof WR_ROLES)[number];

export const RB_ROLES = ['EARLY_DOWN', 'PASSING_DOWN', 'GOAL_LINE', 'THREE_DOWN', 'COMMITTEE'] as const;
export type RbRole = (typeof RB_ROLES)[number];

export const TE_ROLES = ['INLINE', 'FLEX_TE', 'BIG_SLOT_TE', 'BLOCKER'] as const;
export type TeRole = (typeof TE_ROLES)[number];

// --- Display helpers -------------------------------------------------------

export const POSITION_COLOR: Record<string, string> = {
  QB: 'text-pos-qb',
  RB: 'text-pos-rb',
  WR: 'text-pos-wr',
  TE: 'text-pos-te',
  K: 'text-pos-k',
  DEF: 'text-pos-dst',
};

export const POSITION_BG: Record<string, string> = {
  QB: 'bg-pos-qb/15 text-pos-qb border-pos-qb/30',
  RB: 'bg-pos-rb/15 text-pos-rb border-pos-rb/30',
  WR: 'bg-pos-wr/15 text-pos-wr border-pos-wr/30',
  TE: 'bg-pos-te/15 text-pos-te border-pos-te/30',
  K: 'bg-pos-k/15 text-pos-k border-pos-k/30',
  DEF: 'bg-pos-dst/15 text-pos-dst border-pos-dst/30',
};

export function isSkillPosition(pos: string): pos is SkillPosition {
  return (SKILL_POSITIONS as readonly string[]).includes(pos);
}
