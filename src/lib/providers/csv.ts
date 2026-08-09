/**
 * CSV adapter for FantasyPros / FTN / any spreadsheet export.
 *
 * Neither FantasyPros nor FTN offers a free public API, and both allow you to
 * export what you're paying for as CSV. Rather than pretend otherwise, this
 * adapter treats "drop a CSV in and it's ingested" as the supported path. It
 * implements the same provider interfaces an API client would, so swapping in a
 * real client later is a one-file change.
 *
 * Header matching is fuzzy on purpose: FantasyPros alone ships at least four
 * different header spellings for the same column across its export pages.
 */

import { parse } from 'csv-parse/sync';
import type {
  AdpProvider,
  AdpRecord,
  ProjectionRecord,
  ProjectionsProvider,
  RankingRecord,
  RankingsProvider,
  PlayerRef,
} from './types';
import type { ProjectionScope, RankingScope, ScoringFormat } from '../enums';
import type { StatLine } from '../json';

type Row = Record<string, string>;

/** Candidate header names per logical field, first match wins. */
const FIELD_ALIASES: Record<string, string[]> = {
  name: ['player', 'player name', 'name', 'playername', 'full name'],
  team: ['team', 'tm', 'nfl team'],
  position: ['pos', 'position'],
  externalId: ['id', 'player id', 'playerid', 'fantasypros id', 'ftn id', 'sleeper id'],
  overallRank: ['rk', 'rank', 'overall rank', 'ovr rank', 'rank overall'],
  positionRank: ['pos rank', 'position rank', 'posrank'],
  tier: ['tier'],
  bestRank: ['best', 'best rank'],
  worstRank: ['worst', 'worst rank'],
  avgRank: ['avg', 'avg rank', 'average rank'],
  stdDev: ['std dev', 'stdev', 'std.dev', 'std deviation'],
  adp: ['adp', 'avg pick', 'average draft position'],
  minPick: ['min pick', 'best pick', 'min'],
  maxPick: ['max pick', 'worst pick', 'max'],
  timesDrafted: ['times drafted', 'n', 'count'],
  fantasyPoints: ['fpts', 'fantasy points', 'points', 'proj pts', 'projected points', 'fpts/g total'],
  floorPoints: ['floor', 'floor pts', 'low'],
  ceilingPoints: ['ceiling', 'ceil', 'ceiling pts', 'high'],
  games: ['g', 'games', 'gp'],
  passAttempts: ['att', 'pass att', 'passing att', 'pa'],
  completions: ['cmp', 'comp', 'completions'],
  passYards: ['pass yds', 'passing yds', 'py', 'pass yards'],
  passTds: ['pass td', 'passing td', 'ptd', 'pass tds'],
  interceptions: ['int', 'ints', 'interceptions'],
  carries: ['rush att', 'rushing att', 'carries', 'ra'],
  rushYards: ['rush yds', 'rushing yds', 'ry', 'rush yards'],
  rushTds: ['rush td', 'rushing td', 'rtd', 'rush tds'],
  targets: ['tgt', 'targets', 'tar'],
  receptions: ['rec', 'receptions', 'catches'],
  recYards: ['rec yds', 'receiving yds', 'recy', 'rec yards'],
  recTds: ['rec td', 'receiving td', 'rectd', 'rec tds'],
  fumblesLost: ['fl', 'fum lost', 'fumbles lost'],
};

function buildHeaderMap(headers: string[]): Record<string, string> {
  const lower = headers.map((h) => ({ raw: h, key: h.toLowerCase().trim() }));
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const hit = lower.find((h) => aliases.includes(h.key));
    if (hit) map[field] = hit.raw;
  }
  return map;
}

function num(row: Row, map: Record<string, string>, field: string): number | null {
  const header = map[field];
  if (!header) return null;
  const raw = row[header];
  if (raw === undefined || raw === null || raw === '') return null;
  // FantasyPros writes "1,234" and sometimes "12.3%" or "-".
  const cleaned = raw.replace(/[,%$]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function str(row: Row, map: Record<string, string>, field: string): string | null {
  const header = map[field];
  if (!header) return null;
  const raw = row[header];
  return raw?.trim() || null;
}

/**
 * FantasyPros often writes "Ja'Marr Chase CIN" or "Bijan Robinson (ATL)" in a
 * single Player column. Pull the team out when there is no separate column.
 */
function splitNameAndTeam(value: string): { name: string; team: string | null } {
  const paren = value.match(/^(.*?)\s*\(([A-Z]{2,4})\)\s*$/);
  if (paren) return { name: paren[1].trim(), team: paren[2] };
  const trailing = value.match(/^(.*?)\s+([A-Z]{2,4})$/);
  if (trailing && trailing[2] !== 'II' && trailing[2] !== 'III' && trailing[2] !== 'IV') {
    return { name: trailing[1].trim(), team: trailing[2] };
  }
  return { name: value.trim(), team: null };
}

function toPlayerRef(row: Row, map: Record<string, string>): PlayerRef | null {
  const rawName = str(row, map, 'name');
  if (!rawName) return null;
  const explicitTeam = str(row, map, 'team');
  const { name, team } = explicitTeam ? { name: rawName, team: explicitTeam } : splitNameAndTeam(rawName);
  const rawPos = str(row, map, 'position');
  return {
    name,
    team,
    position: rawPos ? rawPos.replace(/[0-9]/g, '').toUpperCase() : undefined,
    externalId: str(row, map, 'externalId') ?? undefined,
  };
}

export interface CsvParseResult<T> {
  records: T[];
  /** Rows we could not turn into a record, with the reason. For the import UI. */
  skipped: { row: number; reason: string }[];
  headersDetected: string[];
}

function readRows(csv: string): { rows: Row[]; headers: string[] } {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Row[];
  return { rows, headers: rows.length ? Object.keys(rows[0]) : [] };
}

export function parseRankingsCsv(
  csv: string,
  args: { season: string; scope: RankingScope; week?: number | null; format: ScoringFormat },
): CsvParseResult<RankingRecord> {
  const { rows, headers } = readRows(csv);
  const map = buildHeaderMap(headers);
  const records: RankingRecord[] = [];
  const skipped: { row: number; reason: string }[] = [];

  rows.forEach((row, i) => {
    const player = toPlayerRef(row, map);
    if (!player) {
      skipped.push({ row: i + 2, reason: 'No recognisable player-name column' });
      return;
    }
    records.push({
      player,
      scope: args.scope,
      season: args.season,
      week: args.week ?? null,
      format: args.format,
      overallRank: num(row, map, 'overallRank'),
      positionRank: num(row, map, 'positionRank'),
      tier: num(row, map, 'tier'),
      bestRank: num(row, map, 'bestRank'),
      worstRank: num(row, map, 'worstRank'),
      avgRank: num(row, map, 'avgRank'),
      stdDev: num(row, map, 'stdDev'),
    });
  });

  return { records, skipped, headersDetected: Object.keys(map) };
}

export function parseProjectionsCsv(
  csv: string,
  args: { season: string; scope: ProjectionScope; week?: number | null; format: ScoringFormat },
): CsvParseResult<ProjectionRecord> {
  const { rows, headers } = readRows(csv);
  const map = buildHeaderMap(headers);
  const records: ProjectionRecord[] = [];
  const skipped: { row: number; reason: string }[] = [];

  rows.forEach((row, i) => {
    const player = toPlayerRef(row, map);
    if (!player) {
      skipped.push({ row: i + 2, reason: 'No recognisable player-name column' });
      return;
    }
    const stats: StatLine = {
      passAttempts: num(row, map, 'passAttempts') ?? undefined,
      completions: num(row, map, 'completions') ?? undefined,
      passYards: num(row, map, 'passYards') ?? undefined,
      passTds: num(row, map, 'passTds') ?? undefined,
      interceptions: num(row, map, 'interceptions') ?? undefined,
      carries: num(row, map, 'carries') ?? undefined,
      rushYards: num(row, map, 'rushYards') ?? undefined,
      rushTds: num(row, map, 'rushTds') ?? undefined,
      targets: num(row, map, 'targets') ?? undefined,
      receptions: num(row, map, 'receptions') ?? undefined,
      recYards: num(row, map, 'recYards') ?? undefined,
      recTds: num(row, map, 'recTds') ?? undefined,
      fumblesLost: num(row, map, 'fumblesLost') ?? undefined,
      games: num(row, map, 'games') ?? undefined,
    };

    // If the export has no points column, derive it from the stat line using
    // this league's scoring rather than dropping the row.
    const explicitPoints = num(row, map, 'fantasyPoints');
    const fantasyPoints = explicitPoints ?? scoreStatLine(stats, args.format);

    if (fantasyPoints === null) {
      skipped.push({ row: i + 2, reason: 'No points column and not enough stats to derive points' });
      return;
    }

    records.push({
      player,
      scope: args.scope,
      season: args.season,
      week: args.week ?? null,
      format: args.format,
      fantasyPoints,
      floorPoints: num(row, map, 'floorPoints'),
      ceilingPoints: num(row, map, 'ceilingPoints'),
      gamesPlayed: num(row, map, 'games'),
      stats,
    });
  });

  return { records, skipped, headersDetected: Object.keys(map) };
}

export function parseAdpCsv(
  csv: string,
  args: { season: string; format: ScoringFormat; teamCount?: number | null },
): CsvParseResult<AdpRecord> {
  const { rows, headers } = readRows(csv);
  const map = buildHeaderMap(headers);
  const records: AdpRecord[] = [];
  const skipped: { row: number; reason: string }[] = [];

  rows.forEach((row, i) => {
    const player = toPlayerRef(row, map);
    if (!player) {
      skipped.push({ row: i + 2, reason: 'No recognisable player-name column' });
      return;
    }
    // Fall back to overall rank when the export has no explicit ADP column.
    const adp = num(row, map, 'adp') ?? num(row, map, 'avgRank') ?? num(row, map, 'overallRank');
    if (adp === null) {
      skipped.push({ row: i + 2, reason: 'No ADP, average-rank or overall-rank column' });
      return;
    }
    records.push({
      player,
      season: args.season,
      format: args.format,
      teamCount: args.teamCount ?? null,
      adp,
      adpStdDev: num(row, map, 'stdDev'),
      minPick: num(row, map, 'minPick'),
      maxPick: num(row, map, 'maxPick'),
      timesDrafted: num(row, map, 'timesDrafted'),
    });
  });

  return { records, skipped, headersDetected: Object.keys(map) };
}

/**
 * Standard scoring applied to a projected stat line. Only used when an export
 * omits a points column; anything with real points uses the provider's number.
 * PPR-family reception values match this league (full PPR).
 */
export function scoreStatLine(stats: StatLine, format: ScoringFormat): number | null {
  const hasAny =
    stats.passYards !== undefined ||
    stats.rushYards !== undefined ||
    stats.recYards !== undefined ||
    stats.receptions !== undefined;
  if (!hasAny) return null;

  const recPoint = format === 'STD' ? 0 : format === 'HALF' ? 0.5 : 1;
  return (
    (stats.passYards ?? 0) * 0.04 +
    (stats.passTds ?? 0) * 4 +
    (stats.interceptions ?? 0) * -1 +
    (stats.rushYards ?? 0) * 0.1 +
    (stats.rushTds ?? 0) * 6 +
    (stats.recYards ?? 0) * 0.1 +
    (stats.recTds ?? 0) * 6 +
    (stats.receptions ?? 0) * recPoint +
    (stats.fumblesLost ?? 0) * -2
  );
}

// --- Provider wrappers -----------------------------------------------------
// These let a CSV drop be consumed through the same interface an API client
// would implement, so callers do not branch on "is this a file or an API".

export class CsvRankingsProvider implements RankingsProvider {
  constructor(
    readonly name: string,
    private readonly csv: string,
  ) {}
  isConfigured() {
    return this.csv.trim().length > 0;
  }
  async fetchRankings(args: { season: string; scope: RankingScope; week?: number; format: ScoringFormat }) {
    return parseRankingsCsv(this.csv, args).records;
  }
}

export class CsvProjectionsProvider implements ProjectionsProvider {
  constructor(
    readonly name: string,
    private readonly csv: string,
  ) {}
  isConfigured() {
    return this.csv.trim().length > 0;
  }
  async fetchProjections(args: { season: string; scope: ProjectionScope; week?: number; format: ScoringFormat }) {
    return parseProjectionsCsv(this.csv, args).records;
  }
}

export class CsvAdpProvider implements AdpProvider {
  constructor(
    readonly name: string,
    private readonly csv: string,
  ) {}
  isConfigured() {
    return this.csv.trim().length > 0;
  }
  async fetchAdp(args: { season: string; format: ScoringFormat; teamCount?: number }) {
    return parseAdpCsv(this.csv, args).records;
  }
}
