/**
 * Sleeper API client.
 *
 * Sleeper's read API is public, unauthenticated and rate-limited to roughly
 * 1000 calls/minute — comfortably above what live-draft polling needs. There is
 * no official SDK, so this is a thin typed fetch wrapper.
 *
 * The one call that needs care is `/players/nfl`: it is a ~5 MB document of
 * every NFL player. It is cached on disk and refreshed at most once a day.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.sleeper.app/v1';
const CACHE_DIR = path.join(process.cwd(), '.cache');
const PLAYERS_CACHE = path.join(CACHE_DIR, 'sleeper-players.json');
const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000;

export class SleeperError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'SleeperError';
  }
}

async function get<T>(pathname: string, init?: RequestInit): Promise<T> {
  const url = `${BASE}${pathname}`;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
  } catch (cause) {
    throw new SleeperError(`Network error calling Sleeper: ${String(cause)}`, undefined, url);
  }
  if (res.status === 404) {
    throw new SleeperError(`Sleeper returned 404 — check the id in the URL`, 404, url);
  }
  if (!res.ok) {
    throw new SleeperError(`Sleeper returned ${res.status}`, res.status, url);
  }
  return (await res.json()) as T;
}

/** Sleeper returns `null` (not 404) for some empty collections. */
async function getOrEmpty<T>(pathname: string): Promise<T[]> {
  const data = await get<T[] | null>(pathname);
  return data ?? [];
}

// --- Response shapes -------------------------------------------------------

export interface SleeperState {
  week: number;
  season_type: string;
  season: string;
  previous_season: string;
  display_week: number;
  leg: number;
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  metadata?: { team_name?: string; [k: string]: unknown } | null;
  is_owner?: boolean;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  sport: string;
  status: string;
  total_rosters: number;
  avatar: string | null;
  previous_league_id: string | null;
  draft_id: string | null;
  roster_positions: string[];
  settings: Record<string, number>;
  scoring_settings: Record<string, number>;
  metadata: Record<string, unknown> | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  co_owners: string[] | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  keepers: string[] | null;
  settings: Record<string, number>;
  metadata: Record<string, unknown> | null;
}

export interface SleeperDraft {
  draft_id: string;
  league_id: string;
  season: string;
  type: string;
  status: string;
  sport: string;
  start_time: number | null;
  settings: Record<string, number>;
  slot_to_roster_id: Record<string, number> | null;
  draft_order: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
}

export interface SleeperDraftPick {
  draft_id: string;
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  picked_by: string | null;
  player_id: string | null;
  is_keeper: boolean | null;
  metadata: Record<string, string> | null;
}

export interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  leg: number;
  created: number;
  creator: string | null;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: unknown[];
  waiver_budget: unknown[];
  settings: Record<string, number> | null;
}

export interface SleeperMatchup {
  matchup_id: number | null;
  roster_id: number;
  starters: string[] | null;
  players: string[] | null;
  points: number | null;
  players_points: Record<string, number> | null;
  starters_points: number[] | null;
}

export interface SleeperPlayer {
  player_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  position: string | null;
  fantasy_positions: string[] | null;
  team: string | null;
  age: number | null;
  birth_date: string | null;
  height: string | null;
  weight: string | null;
  college: string | null;
  years_exp: number | null;
  number: number | null;
  status: string | null;
  active: boolean | null;
  injury_status: string | null;
  injury_body_part: string | null;
  injury_notes: string | null;
  depth_chart_position: string | null;
  depth_chart_order: number | null;
  search_full_name: string | null;
  [k: string]: unknown;
}

export interface SleeperTrendingPlayer {
  player_id: string;
  count: number;
}

// --- Client ----------------------------------------------------------------

export const sleeper = {
  /** Current NFL week/season. The source of truth for "what week is it". */
  getState(): Promise<SleeperState> {
    return get<SleeperState>('/state/nfl');
  },

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return get<SleeperLeague>(`/league/${leagueId}`);
  },

  getUsers(leagueId: string): Promise<SleeperUser[]> {
    return getOrEmpty<SleeperUser>(`/league/${leagueId}/users`);
  },

  getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return getOrEmpty<SleeperRoster>(`/league/${leagueId}/rosters`);
  },

  getDrafts(leagueId: string): Promise<SleeperDraft[]> {
    return getOrEmpty<SleeperDraft>(`/league/${leagueId}/drafts`);
  },

  getDraft(draftId: string): Promise<SleeperDraft> {
    return get<SleeperDraft>(`/draft/${draftId}`);
  },

  getDraftPicks(draftId: string): Promise<SleeperDraftPick[]> {
    return getOrEmpty<SleeperDraftPick>(`/draft/${draftId}/picks`);
  },

  getTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
    return getOrEmpty<SleeperTransaction>(`/league/${leagueId}/transactions/${week}`);
  },

  getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
    return getOrEmpty<SleeperMatchup>(`/league/${leagueId}/matchups/${week}`);
  },

  getUserByName(username: string): Promise<SleeperUser> {
    return get<SleeperUser>(`/user/${encodeURIComponent(username)}`);
  },

  /**
   * Every league a user belongs to in a season. Lets setup start from a public
   * username instead of asking for a league id copied out of a URL — and no
   * credentials are involved, since Sleeper's read API is unauthenticated.
   */
  getUserLeagues(userId: string, season: string, sport = 'nfl'): Promise<SleeperLeague[]> {
    return getOrEmpty<SleeperLeague>(`/user/${userId}/leagues/${sport}/${season}`);
  },

  /**
   * Trending adds/drops across all of Sleeper. This is the closest thing to a
   * free market-percentage feed and it powers both late-draft buzz and (in
   * Phase 10) the "is the market onto him yet" signal.
   */
  getTrending(type: 'add' | 'drop', lookbackHours = 24, limit = 200): Promise<SleeperTrendingPlayer[]> {
    return getOrEmpty<SleeperTrendingPlayer>(
      `/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
    );
  },

  /**
   * The full player dictionary (~5 MB). Cached on disk; Sleeper explicitly asks
   * callers not to hit this more than once a day.
   */
  async getAllPlayers(opts: { force?: boolean } = {}): Promise<Record<string, SleeperPlayer>> {
    if (!opts.force) {
      try {
        const stat = await fs.stat(PLAYERS_CACHE);
        if (Date.now() - stat.mtimeMs < PLAYERS_TTL_MS) {
          const cached = await fs.readFile(PLAYERS_CACHE, 'utf8');
          return JSON.parse(cached) as Record<string, SleeperPlayer>;
        }
      } catch {
        // No usable cache — fall through and fetch.
      }
    }

    const players = await get<Record<string, SleeperPlayer>>('/players/nfl');
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(PLAYERS_CACHE, JSON.stringify(players), 'utf8');
    return players;
  },
};

// --- Helpers ---------------------------------------------------------------

/** Sleeper heights are sometimes `"72"` and sometimes `"6'0\""`. */
export function parseHeightInches(height: string | null): number | null {
  if (!height) return null;
  const plain = Number(height);
  if (Number.isFinite(plain) && plain > 0) return plain;
  const m = height.match(/(\d+)'\s*(\d+)/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);
  return null;
}

/**
 * Sleeper uses `DEF` for team defences and gives them a player_id equal to the
 * team abbreviation. Normalise the handful of position aliases we care about.
 */
export function normalisePosition(pos: string | null, fantasyPositions: string[] | null): string | null {
  const p = pos ?? fantasyPositions?.[0] ?? null;
  if (!p) return null;
  if (p === 'DST' || p === 'D/ST') return 'DEF';
  return p;
}
