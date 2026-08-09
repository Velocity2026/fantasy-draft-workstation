/**
 * Typed access to the `*Json` String columns.
 *
 * SQLite via Prisma has no native JSON column, so structured payloads are
 * stored as text. These helpers keep the parsing in one place and make the
 * failure mode explicit: a malformed blob returns the fallback rather than
 * throwing in the middle of a draft.
 */

export function readJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** A full stat line as stored in Projection.statsJson. All fields optional. */
export interface StatLine {
  passAttempts?: number;
  completions?: number;
  passYards?: number;
  passTds?: number;
  interceptions?: number;
  carries?: number;
  rushYards?: number;
  rushTds?: number;
  targets?: number;
  receptions?: number;
  recYards?: number;
  recTds?: number;
  fumblesLost?: number;
  twoPointConversions?: number;
  games?: number;
}

/** Personnel-group usage share, e.g. { '11': 0.62, '12': 0.24 }. */
export type PersonnelUsage = Record<string, number>;

/** Alignment share for a receiver/TE/back. */
export interface AlignmentUsage {
  X?: number;
  Z?: number;
  slot?: number;
  bigSlot?: number;
  inline?: number;
  backfield?: number;
  wide?: number;
}

/** Sleeper transaction adds/drops: { playerId: rosterId }. */
export type PlayerRosterMap = Record<string, number>;
