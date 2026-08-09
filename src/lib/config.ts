import { prisma } from './db';
import { readJson, writeJson } from './json';
import type { ScoringFormat } from './enums';

/**
 * App configuration lives in the AppSetting table, seeded from .env on first
 * boot. Keeping it in the DB means the settings page can change the league,
 * my roster or valuation defaults without editing files or restarting — which
 * matters when something needs fixing ten minutes before a draft.
 */

export interface AppConfig {
  leagueId: string | null;
  sleeperUsername: string | null;
  season: string;
  /** Sleeper draft id the live room follows. Set when a draft is selected. */
  activeDraftId: string | null;
  myDraftSlot: number | null;
  draftPollMs: number;
  /** Projection sources and their blend weights, e.g. { ftn: 0.6, fantasypros: 0.4 }. */
  projectionWeights: Record<string, number>;
  /** Fraction of a starter-tier baseline used for replacement level. */
  replacementMethod: 'STARTER_COUNT' | 'BLENDED' | 'LAST_STARTER';
  /** Weight applied to roster need vs raw VORP in draft recommendations. 0..1 */
  needWeight: number;
  /** Weight applied to my manual board rank vs computed rank. 0..1 */
  boardOverrideWeight: number;
  riskAversion: number;
}

const DEFAULTS: AppConfig = {
  leagueId: null,
  sleeperUsername: null,
  season: new Date().getFullYear().toString(),
  activeDraftId: null,
  myDraftSlot: null,
  draftPollMs: 2500,
  projectionWeights: { internal: 1 },
  replacementMethod: 'BLENDED',
  needWeight: 0.35,
  boardOverrideWeight: 0.5,
  riskAversion: 0.2,
};

const CONFIG_KEY = 'app.config';

export async function getConfig(): Promise<AppConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: CONFIG_KEY } });
  const stored = readJson<Partial<AppConfig>>(row?.valueJson, {});

  // .env acts as the seed/fallback; the DB row always wins once written.
  const envSeed: Partial<AppConfig> = {
    leagueId: process.env.SLEEPER_LEAGUE_ID || undefined,
    sleeperUsername: process.env.SLEEPER_USERNAME || undefined,
    season: process.env.SEASON || undefined,
    draftPollMs: process.env.DRAFT_POLL_MS ? Number(process.env.DRAFT_POLL_MS) : undefined,
  };
  const cleanedEnv = Object.fromEntries(
    Object.entries(envSeed).filter(([, v]) => v !== undefined && v !== ''),
  );

  return { ...DEFAULTS, ...cleanedEnv, ...stored } as AppConfig;
}

export async function setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await prisma.appSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, valueJson: writeJson(next) ?? '{}' },
    update: { valueJson: writeJson(next) ?? '{}' },
  });
  return next;
}

/** Throws with an actionable message rather than a null-deref deep in a page. */
export async function requireLeagueId(): Promise<string> {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    throw new Error(
      'No Sleeper league configured. Set SLEEPER_LEAGUE_ID in .env or save one on the Settings page.',
    );
  }
  return cfg.leagueId;
}

// ---------------------------------------------------------------------------
// League-shape derivation
// ---------------------------------------------------------------------------

export interface RosterShape {
  teams: number;
  /** Starting slots by position, FLEX counted separately. */
  starters: Record<string, number>;
  flex: number;
  superFlex: number;
  benchSlots: number;
  totalRosterSize: number;
  rounds: number;
}

/**
 * Turn Sleeper's `roster_positions` array into the numbers the valuation engine
 * needs. Everything downstream (replacement level, scarcity, roster need) is
 * derived from the real league settings rather than hardcoded, so if the
 * commissioner changes a slot the numbers follow.
 */
export function deriveRosterShape(rosterPositions: string[], teams: number): RosterShape {
  const starters: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0;
  let superFlex = 0;
  let bench = 0;

  for (const slot of rosterPositions) {
    switch (slot) {
      case 'QB':
      case 'RB':
      case 'WR':
      case 'TE':
      case 'K':
        starters[slot] += 1;
        break;
      case 'DEF':
      case 'DST':
        starters.DEF += 1;
        break;
      case 'FLEX':
      case 'REC_FLEX':
      case 'WRRB_FLEX':
        flex += 1;
        break;
      case 'SUPER_FLEX':
        superFlex += 1;
        break;
      case 'BN':
        bench += 1;
        break;
      case 'IR':
      case 'TAXI':
        // Not draftable capacity.
        break;
      default:
        bench += 1;
    }
  }

  const totalRosterSize = rosterPositions.filter((p) => p !== 'IR' && p !== 'TAXI').length;
  return {
    teams,
    starters,
    flex,
    superFlex,
    benchSlots: bench,
    totalRosterSize,
    rounds: totalRosterSize,
  };
}

/** Read the scoring format off Sleeper's scoring_settings. */
export function deriveScoringFormat(scoring: Record<string, number> | null): ScoringFormat {
  const rec = scoring?.rec ?? 0;
  const passTd = scoring?.pass_td ?? 4;
  if (rec >= 1) return 'PPR';
  if (rec >= 0.4) return 'HALF';
  void passTd;
  return 'STD';
}
