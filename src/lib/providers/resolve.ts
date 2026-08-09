import { prisma } from '../db';
import { normaliseName } from '../utils';
import type { PlayerRef, ResolvedPlayerRef } from './types';

/**
 * Resolves a provider's player reference to our canonical Sleeper player id.
 *
 * Order of attack:
 *   1. A previously recorded external id for that source — exact and free.
 *   2. Normalised name + position + team — high confidence.
 *   3. Normalised name + position — the common case for CSVs that omit team,
 *      or where the player just changed teams.
 *   4. Normalised name alone — accepted only when unambiguous.
 *
 * Successful name matches are written back to PlayerExternalId so the next
 * import for that source is a straight id lookup. Anything unresolved is
 * returned to the caller, which surfaces it in the import UI rather than
 * silently dropping the row — a silently missing RB1 on draft day is worse
 * than a visible warning.
 */

export interface ResolverOptions {
  source: string;
  /** Persist name-based matches as external ids for next time. */
  learn?: boolean;
  /** Minimum confidence to accept. Defaults to 0.6. */
  minConfidence?: number;
}

interface IndexedPlayer {
  id: string;
  position: string;
  teamId: string | null;
  key: string;
}

export class PlayerResolver {
  private byExternal = new Map<string, string>();
  private byNamePosTeam = new Map<string, string[]>();
  private byNamePos = new Map<string, string[]>();
  private byName = new Map<string, string[]>();
  private learned: { playerId: string; externalId: string; confidence: number }[] = [];

  private constructor(private readonly opts: ResolverOptions) {}

  static async create(opts: ResolverOptions): Promise<PlayerResolver> {
    const r = new PlayerResolver(opts);
    await r.load();
    return r;
  }

  private async load() {
    const [players, externals] = await Promise.all([
      prisma.player.findMany({ select: { id: true, fullName: true, position: true, teamId: true } }),
      prisma.playerExternalId.findMany({
        where: { source: this.opts.source },
        select: { externalId: true, playerId: true },
      }),
    ]);

    for (const e of externals) this.byExternal.set(e.externalId, e.playerId);

    const indexed: IndexedPlayer[] = players.map((p) => ({
      id: p.id,
      position: p.position,
      teamId: p.teamId,
      key: normaliseName(p.fullName),
    }));

    for (const p of indexed) {
      push(this.byName, p.key, p.id);
      push(this.byNamePos, `${p.key}|${p.position}`, p.id);
      if (p.teamId) push(this.byNamePosTeam, `${p.key}|${p.position}|${p.teamId}`, p.id);
    }
  }

  resolve(ref: PlayerRef): ResolvedPlayerRef | null {
    const min = this.opts.minConfidence ?? 0.6;

    if (ref.externalId) {
      const hit = this.byExternal.get(ref.externalId);
      if (hit) return { ...ref, playerId: hit, confidence: 1 };
    }

    const key = normaliseName(ref.name);
    if (!key) return null;
    const pos = normalisePos(ref.position);
    const team = ref.team ? ref.team.toUpperCase() : null;

    const attempts: [string[] | undefined, number][] = [
      [pos && team ? this.byNamePosTeam.get(`${key}|${pos}|${team}`) : undefined, 0.98],
      [pos ? this.byNamePos.get(`${key}|${pos}`) : undefined, 0.9],
      [this.byName.get(key), 0.75],
    ];

    for (const [candidates, confidence] of attempts) {
      // Only accept when the match is unambiguous. Two active players with the
      // same normalised name and position is rare but real (e.g. Michael
      // Thomas), and guessing is worse than reporting.
      if (candidates && candidates.length === 1 && confidence >= min) {
        const playerId = candidates[0];
        if (this.opts.learn && ref.externalId) {
          this.learned.push({ playerId, externalId: ref.externalId, confidence });
          this.byExternal.set(ref.externalId, playerId);
        }
        return { ...ref, playerId, confidence };
      }
    }

    return null;
  }

  /** Resolve a batch, returning both hits and the refs we could not place. */
  resolveMany(refs: PlayerRef[]): { resolved: ResolvedPlayerRef[]; unresolved: PlayerRef[] } {
    const resolved: ResolvedPlayerRef[] = [];
    const unresolved: PlayerRef[] = [];
    for (const ref of refs) {
      const hit = this.resolve(ref);
      if (hit) resolved.push(hit);
      else unresolved.push(ref);
    }
    return { resolved, unresolved };
  }

  /** Persist the name-based matches learned during this run. */
  async commitLearned(): Promise<number> {
    if (!this.learned.length) return 0;
    let written = 0;
    for (const l of this.learned) {
      try {
        await prisma.playerExternalId.upsert({
          where: { source_externalId: { source: this.opts.source, externalId: l.externalId } },
          create: { source: this.opts.source, externalId: l.externalId, playerId: l.playerId, confidence: l.confidence },
          update: { playerId: l.playerId, confidence: l.confidence },
        });
        written += 1;
      } catch {
        // A concurrent import already claimed this id — not fatal.
      }
    }
    this.learned = [];
    return written;
  }
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function normalisePos(pos: string | undefined | null): string | null {
  if (!pos) return null;
  const p = pos.toUpperCase().replace(/[0-9]/g, '').trim();
  if (p === 'DST' || p === 'D/ST' || p === 'DEFENSE') return 'DEF';
  if (p === 'PK') return 'K';
  return p || null;
}
