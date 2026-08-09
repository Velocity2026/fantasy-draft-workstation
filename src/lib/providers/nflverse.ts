/**
 * nflverse provider.
 *
 * nflverse publishes the open NFL data community's datasets as plain CSV
 * attached to GitHub releases — free, no key, no rate limit worth worrying
 * about. It is the backbone of the historical warehouse: weekly stats, snap
 * counts, combine results and NFL draft capital.
 *
 * IDENTITY IS THE HARD PART, and the approach here is the result of measuring
 * rather than assuming:
 *
 *   - nflverse keys on `gsis_id`. Sleeper *has* a gsis_id field, so that looks
 *     like the obvious bridge — but it is only populated for about 22% of the
 *     current top 100 (Bijan Robinson, Ja'Marr Chase and Jahmyr Gibbs all lack
 *     it). Coverage is worst exactly where it matters most.
 *   - Birth date is ~100% populated on both sides.
 *
 * So the join is **normalised name + birth date**, which resolved 99% of the
 * top 100 and 97.7% of the top 300 when measured against the real data. Name +
 * position is the fallback for the remainder (mostly current-year rookies).
 */

import { parse } from 'csv-parse/sync';
import { normaliseName } from '../utils';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

export interface NflverseFetchOptions {
  /** Fail fast rather than hanging a sync job on a slow release asset. */
  timeoutMs?: number;
}

export class NflverseError extends Error {
  constructor(
    message: string,
    readonly url?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NflverseError';
  }
}

async function fetchCsv<T extends Record<string, unknown>>(
  pathname: string,
  opts: NflverseFetchOptions = {},
): Promise<T[]> {
  const url = `${BASE}/${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (res.status === 404) {
      throw new NflverseError(
        `nflverse has no dataset at "${pathname}". The release layout may have changed.`,
        url,
        404,
      );
    }
    if (!res.ok) throw new NflverseError(`nflverse returned ${res.status}`, url, res.status);

    const text = await res.text();
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
      cast: false,
    }) as T[];
  } catch (error) {
    if (error instanceof NflverseError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NflverseError(`Timed out fetching ${pathname}`, url);
    }
    throw new NflverseError(`Failed to fetch ${pathname}: ${String(error)}`, url);
  } finally {
    clearTimeout(timer);
  }
}

// --- Row shapes (only the columns we actually consume) ---------------------

export interface NflversePlayerRow extends Record<string, string> {
  gsis_id: string;
  display_name: string;
  position: string;
  position_group: string;
  birth_date: string;
  height: string;
  weight: string;
  college_name: string;
  college_conference: string;
  rookie_season: string;
  draft_year: string;
  draft_round: string;
  draft_pick: string;
  draft_team: string;
  pfr_id: string;
  espn_id: string;
  status: string;
}

export interface NflverseCombineRow extends Record<string, string> {
  season: string;
  draft_year: string;
  draft_team: string;
  draft_round: string;
  draft_ovr: string;
  pfr_id: string;
  player_name: string;
  pos: string;
  school: string;
  ht: string;
  wt: string;
  forty: string;
  bench: string;
  vertical: string;
  broad_jump: string;
  cone: string;
  shuttle: string;
}

/** Weekly player stats. Column names vary by nflverse release generation. */
export interface NflverseWeeklyRow extends Record<string, string> {
  player_id: string;
  player_display_name: string;
  position: string;
  recent_team: string;
  season: string;
  week: string;
  season_type: string;
}

export interface NflverseSnapRow extends Record<string, string> {
  pfr_player_id: string;
  player: string;
  position: string;
  team: string;
  season: string;
  week: string;
  offense_snaps: string;
  offense_pct: string;
}

// --- Client ----------------------------------------------------------------

export const nflverse = {
  /** Master player table — the identity spine and draft-capital source. */
  players(opts?: NflverseFetchOptions) {
    return fetchCsv<NflversePlayerRow>('players/players.csv', opts);
  },

  /** Combine results, keyed by pfr_id (not gsis_id). */
  combine(opts?: NflverseFetchOptions) {
    return fetchCsv<NflverseCombineRow>('combine/combine.csv', opts);
  },

  /**
   * Weekly player stats for a season.
   *
   * Asset naming changed across nflverse generations, so several names are
   * tried. Order matters and is easy to get wrong: `stats_player_reg_*` is the
   * season-AGGREGATE file — same columns, no `week` — so putting it first
   * silently yields rows that are all discarded downstream. Each candidate is
   * therefore validated for a `week` column before being accepted.
   */
  async weekly(season: number, opts?: NflverseFetchOptions): Promise<NflverseWeeklyRow[]> {
    const candidates = [
      `player_stats/stats_player_week_${season}.csv`,
      `player_stats/player_stats_${season}.csv`,
    ];
    let lastError: unknown;

    for (const path of candidates) {
      try {
        const rows = await fetchCsv<NflverseWeeklyRow>(path, opts);
        if (!rows.length) continue;
        if (!('week' in rows[0])) {
          lastError = new NflverseError(
            `${path} has no 'week' column — that is the season-aggregate file, not weekly.`,
          );
          continue;
        }
        return rows;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new NflverseError(`No weekly stats found for ${season}`);
  },

  snapCounts(season: number, opts?: NflverseFetchOptions) {
    return fetchCsv<NflverseSnapRow>(`snap_counts/snap_counts_${season}.csv`, opts);
  },
};

// --- Parsing helpers -------------------------------------------------------

export function num(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === 'NA' || trimmed === 'NULL') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function int(value: string | undefined | null): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

export function text(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === 'NA') return null;
  return trimmed;
}

/** Normalised YYYY-MM-DD, or null. Both sides sometimes carry a time part. */
export function birthKey(value: string | undefined | null): string | null {
  const t = text(value);
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

/** Join key: normalised name + birth date. The measured-best bridge. */
export function identityKey(name: string, birthDate: string | null | undefined): string | null {
  const b = birthKey(birthDate);
  if (!b) return null;
  const n = normaliseName(name);
  if (!n) return null;
  return `${n}|${b}`;
}

/** Weaker fallback key for players missing a birth date on either side. */
export function nameposKey(name: string, position: string | null | undefined): string | null {
  const n = normaliseName(name);
  if (!n) return null;
  return `${n}|${(position ?? '').toUpperCase()}`;
}

// --- Derived metrics -------------------------------------------------------

/**
 * Draft capital as 0..1.
 *
 * Value falls away steeply — the gap between pick 5 and pick 25 matters far
 * more than the gap between 150 and 170 — so this decays exponentially rather
 * than linearly. Undrafted scores 0 rather than null: being undrafted is
 * information, not missing data.
 */
export function draftCapitalScore(overallPick: number | null): number {
  if (overallPick === null || overallPick <= 0) return 0;
  return Math.exp(-(overallPick - 1) / 60);
}

/**
 * Speed score: weight-adjusted 40 time. The standard way to compare a 220 lb
 * back running 4.50 against a 195 lb back running 4.45.
 */
export function speedScore(weightLb: number | null, forty: number | null): number | null {
  if (!weightLb || !forty || forty <= 0) return null;
  return (weightLb * 200) / Math.pow(forty, 4);
}

/**
 * Composite athletic score, 0..1, from whichever measurements exist.
 *
 * Each metric is scored against a rough positional expectation band rather
 * than a population percentile — we do not have the full combine distribution
 * loaded per position, and inventing precision we don't have would be worse
 * than an honest approximation. `athleticSampleSize` travels with this value so
 * a score backed by one 40 time is never mistaken for a full workout.
 */
export function athleticScore(input: {
  position: string;
  forty: number | null;
  vertical: number | null;
  broadJump: number | null;
  threeCone: number | null;
  shuttle: number | null;
  weightLb: number | null;
}): { score: number | null; sampleSize: number } {
  const parts: number[] = [];

  // Bands are (good, poor) — scores clamp to 0..1 between them.
  const band = (value: number | null, good: number, poor: number): number | null => {
    if (value === null) return null;
    const raw = (poor - value) / (poor - good);
    return Math.max(0, Math.min(1, raw));
  };

  const isBig = input.position === 'TE';
  const fortyGood = isBig ? 4.55 : 4.38;
  const fortyPoor = isBig ? 4.95 : 4.75;

  const scores = [
    band(input.forty, fortyGood, fortyPoor),
    band(input.vertical, 40, 28),
    band(input.broadJump, 128, 108),
    band(input.threeCone, 6.75, 7.45),
    band(input.shuttle, 4.15, 4.55),
  ];

  for (const s of scores) if (s !== null) parts.push(s);

  // A single measurement is noise, not a profile.
  if (parts.length < 2) return { score: null, sampleSize: parts.length };

  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  return { score: mean, sampleSize: parts.length };
}
