import { prisma } from '../db';
import { sleeper } from '../providers/sleeper';
import { withSyncRun, type SyncResult } from './runner';
import type { ScoringFormat } from '../enums';

/**
 * Market data: Sleeper add/drop velocity, and an ADP derived from this
 * league's own draft history.
 *
 * Sleeper has no public ADP endpoint. Rather than scrape one, the app computes
 * "league ADP" from actual completed drafts in this league chain — which for a
 * 10-team keeper league is a *better* prior than a generic 12-team redraft ADP
 * anyway, because it encodes how these ten managers actually behave. Public ADP
 * can still be layered in through the CSV importer under a different `source`.
 */

const CAPTURE_ROUND_MS = 60 * 1000;

/** Round timestamps to the minute so a stuck refresh loop can't spam the table. */
function bucketedNow(): Date {
  return new Date(Math.floor(Date.now() / CAPTURE_ROUND_MS) * CAPTURE_ROUND_MS);
}

export async function syncTrending(season: string, lookbackHours = 24): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'market', season }, async () => {
    const [adds, drops] = await Promise.all([
      sleeper.getTrending('add', lookbackHours, 300),
      sleeper.getTrending('drop', lookbackHours, 300),
    ]);

    const byPlayer = new Map<string, { add?: number; drop?: number }>();
    for (const a of adds) byPlayer.set(a.player_id, { ...byPlayer.get(a.player_id), add: a.count });
    for (const d of drops) byPlayer.set(d.player_id, { ...byPlayer.get(d.player_id), drop: d.count });

    // Only keep rows for players we track, or the FK insert fails.
    const known = new Set(
      (
        await prisma.player.findMany({
          where: { id: { in: [...byPlayer.keys()] } },
          select: { id: true },
        })
      ).map((p) => p.id),
    );

    const capturedAt = bucketedNow();
    let written = 0;
    for (const [playerId, counts] of byPlayer) {
      if (!known.has(playerId)) continue;
      await prisma.marketTrend.upsert({
        where: {
          playerId_source_season_week_lookbackHours_capturedAt: {
            playerId,
            source: 'sleeper',
            season,
            week: 0, // rolling trend window, not tied to a specific week
            lookbackHours,
            capturedAt,
          },
        },
        create: {
          playerId,
          source: 'sleeper',
          season,
          lookbackHours,
          addCount: counts.add ?? 0,
          dropCount: counts.drop ?? 0,
          capturedAt,
        },
        update: { addCount: counts.add ?? 0, dropCount: counts.drop ?? 0 },
      });
      written += 1;
    }

    return { recordsIn: byPlayer.size, recordsWritten: written, detail: { lookbackHours } };
  });
}

/**
 * Derive ADP from completed drafts across this league's season chain.
 *
 * Recent seasons are weighted more heavily — a player's 2-year-old draft
 * position says much less about this year than last year's does. Players drafted
 * in fewer than `minSamples` drafts still get an ADP but with a wide standard
 * deviation, which the mock simulator uses to widen their noise.
 */
export async function deriveLeagueAdp(args: {
  leagueId: string;
  season: string;
  format?: ScoringFormat;
  minSamples?: number;
}): Promise<SyncResult> {
  const format = args.format ?? 'PPR';
  const minSamples = args.minSamples ?? 1;

  return withSyncRun({ provider: 'internal', job: 'adp', season: args.season }, async () => {
    const leagueIds = await leagueChain(args.leagueId);
    const drafts = await prisma.draft.findMany({
      where: { leagueId: { in: leagueIds }, status: 'complete' },
      include: { picks: { where: { playerId: { not: null } } } },
      orderBy: { season: 'desc' },
    });

    if (!drafts.length) {
      return { recordsIn: 0, recordsWritten: 0, detail: { reason: 'no completed drafts in league chain' } };
    }

    const currentSeason = Number(args.season);
    const samples = new Map<string, { picks: number[]; weights: number[]; teams: number }>();

    for (const draft of drafts) {
      const age = Math.max(0, currentSeason - Number(draft.season));
      // Half-life of one season: last year counts 1.0, two years ago 0.5, etc.
      const weight = Math.pow(0.5, age);
      const teams = draft.teams || 10;

      for (const pick of draft.picks) {
        if (!pick.playerId) continue;
        // Keepers are not market signal — they're roster inertia.
        if (pick.isKeeper) continue;
        const entry = samples.get(pick.playerId) ?? { picks: [], weights: [], teams };
        entry.picks.push(pick.pickNo);
        entry.weights.push(weight);
        samples.set(pick.playerId, entry);
      }
    }

    const capturedAt = bucketedNow();
    let written = 0;

    for (const [playerId, entry] of samples) {
      if (entry.picks.length < minSamples) continue;
      const totalWeight = entry.weights.reduce((a, b) => a + b, 0);
      if (totalWeight === 0) continue;

      const adp = entry.picks.reduce((sum, p, i) => sum + p * entry.weights[i], 0) / totalWeight;
      const variance =
        entry.picks.reduce((sum, p, i) => sum + entry.weights[i] * (p - adp) ** 2, 0) / totalWeight;
      // A single observation has no measured spread; assume a wide-ish default
      // so the simulator doesn't treat it as certain.
      const sd = entry.picks.length > 1 ? Math.sqrt(variance) : Math.max(6, adp * 0.25);

      await prisma.adpSnapshot.upsert({
        where: {
          playerId_source_season_format_teamCount_capturedAt: {
            playerId,
            source: 'league-history',
            season: args.season,
            format,
            teamCount: entry.teams,
            capturedAt,
          },
        },
        create: {
          playerId,
          source: 'league-history',
          season: args.season,
          format,
          teamCount: entry.teams,
          adp,
          adpStdDev: sd,
          minPick: Math.min(...entry.picks),
          maxPick: Math.max(...entry.picks),
          timesDrafted: entry.picks.length,
          capturedAt,
        },
        update: { adp, adpStdDev: sd, timesDrafted: entry.picks.length },
      });
      written += 1;
    }

    return {
      recordsIn: samples.size,
      recordsWritten: written,
      detail: { draftsUsed: drafts.length, seasons: drafts.map((d) => d.season) },
    };
  });
}

/** Walk `previousLeagueId` back through prior seasons. */
export async function leagueChain(leagueId: string, maxDepth = 12): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = leagueId;
  const seen = new Set<string>();

  for (let i = 0; i < maxDepth && current; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const league: { previousLeagueId: string | null } | null = await prisma.league.findUnique({
      where: { id: current },
      select: { previousLeagueId: true },
    });
    current = league?.previousLeagueId ?? null;
    if (current === '0' || current === '') current = null;
  }
  return chain;
}
