/**
 * Provider interfaces.
 *
 * The point of this file is that no module above it ever imports a vendor SDK
 * or knows a vendor's field names. Sleeper is the only *implemented* league
 * provider today; FantasyPros and FTN arrive through the CSV adapter because
 * neither exposes a free public API. When a key becomes available, a new class
 * implementing these interfaces drops in and nothing else changes.
 *
 * Every record carries `source` and `capturedAt` because the storage layer is
 * append-only — we want to be able to ask "what did FTN think in week 3" long
 * after week 3.
 */

import type { Position, RankingScope, ProjectionScope, ScoringFormat, SeasonType, EvidenceType, ImpactLevel } from '../enums';
import type { StatLine, PersonnelUsage, AlignmentUsage } from '../json';

// --- Identity resolution ---------------------------------------------------

/**
 * Providers speak their own ids. Everything is resolved to a Sleeper player id
 * through this before it touches the database.
 */
export interface PlayerRef {
  /** Provider's own id, if it has one. */
  externalId?: string;
  name: string;
  position?: Position | string;
  team?: string | null;
}

export interface ResolvedPlayerRef extends PlayerRef {
  playerId: string;
  /** <1 when matched by normalised name rather than a hard id. */
  confidence: number;
}

// --- Rankings / projections / market ---------------------------------------

export interface RankingRecord {
  player: PlayerRef;
  scope: RankingScope;
  season: string;
  week?: number | null;
  format: ScoringFormat;
  overallRank?: number | null;
  positionRank?: number | null;
  tier?: number | null;
  bestRank?: number | null;
  worstRank?: number | null;
  avgRank?: number | null;
  stdDev?: number | null;
  expertCount?: number | null;
}

export interface ProjectionRecord {
  player: PlayerRef;
  scope: ProjectionScope;
  season: string;
  week?: number | null;
  format: ScoringFormat;
  fantasyPoints?: number | null;
  floorPoints?: number | null;
  ceilingPoints?: number | null;
  gamesPlayed?: number | null;
  stats?: StatLine;
}

export interface AdpRecord {
  player: PlayerRef;
  season: string;
  format: ScoringFormat;
  teamCount?: number | null;
  adp: number;
  adpStdDev?: number | null;
  minPick?: number | null;
  maxPick?: number | null;
  timesDrafted?: number | null;
}

export interface MarketTrendRecord {
  player: PlayerRef;
  season: string;
  week?: number | null;
  rosteredPct?: number | null;
  startedPct?: number | null;
  addCount?: number | null;
  dropCount?: number | null;
  tradeCount?: number | null;
  lookbackHours?: number | null;
}

// --- In-season usage (Phase 9) ---------------------------------------------

/**
 * One player-week of usage. Deliberately mirrors PlayerWeekStat: a usage
 * provider's only job is to fill as many of these fields as it can and leave
 * the rest null. Partial coverage is expected and fine.
 */
export interface UsageRecord {
  player: PlayerRef;
  season: string;
  week: number;
  seasonType: SeasonType;
  team?: string | null;
  opponent?: string | null;
  homeAway?: 'HOME' | 'AWAY' | null;
  gameId?: string | null;

  snapsOffense?: number | null;
  teamSnapsOffense?: number | null;
  snapPct?: number | null;
  snapsSpecial?: number | null;

  routesRun?: number | null;
  teamDropbacks?: number | null;
  routeParticipation?: number | null;
  yprr?: number | null;

  targets?: number | null;
  targetShare?: number | null;
  firstReadTargets?: number | null;
  firstReadShare?: number | null;
  receptions?: number | null;
  recYards?: number | null;
  recTds?: number | null;
  airYards?: number | null;
  airYardsShare?: number | null;
  adot?: number | null;
  wopr?: number | null;

  carries?: number | null;
  rushYards?: number | null;
  rushTds?: number | null;
  rushShare?: number | null;

  thirdDownSnaps?: number | null;
  thirdDownRoutes?: number | null;
  thirdDownTargets?: number | null;
  twoMinuteSnaps?: number | null;
  twoMinuteRoutes?: number | null;
  twoMinuteTargets?: number | null;
  goalLineCarries?: number | null;
  goalLineTargets?: number | null;
  redZoneCarries?: number | null;
  redZoneTargets?: number | null;
  redZoneSnapPct?: number | null;

  passAttempts?: number | null;
  completions?: number | null;
  passYards?: number | null;
  passTds?: number | null;
  interceptions?: number | null;

  fantasyPointsPpr?: number | null;
  fantasyPointsHalf?: number | null;
  fantasyPointsStd?: number | null;
  expectedPointsPpr?: number | null;

  personnel?: PersonnelUsage;
  alignment?: AlignmentUsage;
  raw?: unknown;
}

export interface DepthChartRecord {
  player: PlayerRef;
  team: string;
  position: string;
  roleSlot?: string | null;
  rank: number;
  season: string;
  week?: number | null;
  effectiveAt: Date;
}

export interface InjuryRecord {
  player: PlayerRef;
  team?: string | null;
  season: string;
  week?: number | null;
  status?: string | null;
  designation?: string | null;
  bodyPart?: string | null;
  note?: string | null;
  expectedReturnWeek?: number | null;
  reportedAt: Date;
}

export interface PracticeRecord {
  player: PlayerRef;
  season: string;
  week: number;
  day: 'WED' | 'THU' | 'FRI' | 'SAT';
  participation: 'DNP' | 'LIMITED' | 'FULL';
  note?: string | null;
  reportedAt: Date;
}

export interface EvidenceRecord {
  subjectType: 'PLAYER' | 'TEAM' | 'LEAGUE' | 'MEMBER' | 'MATCHUP';
  player?: PlayerRef;
  team?: string | null;
  evidenceType: EvidenceType;
  season?: string | null;
  week?: number | null;
  headline: string;
  body?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  author?: string | null;
  confidence?: number;
  sentiment?: number;
  impact?: ImpactLevel;
  tags?: string[];
  payload?: unknown;
  observedAt: Date;
}

// --- The interfaces themselves ---------------------------------------------

export interface Provider {
  readonly name: string;
  /** False when the provider needs a key/file that isn't present yet. */
  isConfigured(): boolean;
}

export interface RankingsProvider extends Provider {
  fetchRankings(args: {
    season: string;
    scope: RankingScope;
    week?: number;
    format: ScoringFormat;
  }): Promise<RankingRecord[]>;
}

export interface ProjectionsProvider extends Provider {
  fetchProjections(args: {
    season: string;
    scope: ProjectionScope;
    week?: number;
    format: ScoringFormat;
  }): Promise<ProjectionRecord[]>;
}

export interface AdpProvider extends Provider {
  fetchAdp(args: { season: string; format: ScoringFormat; teamCount?: number }): Promise<AdpRecord[]>;
}

export interface MarketProvider extends Provider {
  fetchTrends(args: { season: string; week?: number; lookbackHours?: number }): Promise<MarketTrendRecord[]>;
}

/** Phase 9. No implementation ships in the draft release; the contract does. */
export interface UsageProvider extends Provider {
  fetchUsage(args: { season: string; week: number; seasonType?: SeasonType }): Promise<UsageRecord[]>;
}

export interface RoleProvider extends Provider {
  fetchDepthCharts(args: { season: string; week?: number }): Promise<DepthChartRecord[]>;
  fetchInjuries(args: { season: string; week?: number }): Promise<InjuryRecord[]>;
  fetchPractice?(args: { season: string; week: number }): Promise<PracticeRecord[]>;
}

export interface NewsProvider extends Provider {
  fetchEvidence(args: { season: string; since?: Date }): Promise<EvidenceRecord[]>;
}
