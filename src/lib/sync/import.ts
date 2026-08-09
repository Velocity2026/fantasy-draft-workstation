import { prisma } from '../db';
import { PlayerResolver } from '../providers/resolve';
import { parseAdpCsv, parseProjectionsCsv, parseRankingsCsv } from '../providers/csv';
import { recordImport, upsertSource, type SourceKind } from '../sources';
import { writeJson } from '../json';
import { withSyncRun, type SyncResult } from './runner';
import type { ProjectionScope, RankingScope, ScoringFormat } from '../enums';

/**
 * Generic CSV ingest, parameterised by source.
 *
 * The same three functions serve FantasyPros, FTN, a writer's personal rankings
 * spreadsheet, or anything else — the source key is just a string. This is what
 * makes swapping providers a data operation rather than a code change.
 *
 * Unresolved rows are returned, never silently dropped. A missing player on
 * draft day is a real cost, so the import UI shows exactly which names failed
 * to match and why.
 */

export interface ImportOutcome extends SyncResult {
  resolved: number;
  unresolved: { name: string; team?: string | null; position?: string | null }[];
  skipped: { row: number; reason: string }[];
  headersDetected: string[];
}

async function ensureSource(key: string, kind: SourceKind, label?: string) {
  const existing = await prisma.dataSource.findUnique({ where: { key } });
  if (existing) return existing;
  // Importing under a brand-new key auto-registers it, so you can drop a file
  // first and tune the weight afterwards.
  return upsertSource({ key, label: label ?? key, kind, adapter: 'CSV', weight: 1, trust: 0.5 });
}

export async function importRankingsCsv(args: {
  csv: string;
  source: string;
  label?: string;
  season: string;
  scope: RankingScope;
  week?: number;
  format: ScoringFormat;
}): Promise<ImportOutcome> {
  await ensureSource(args.source, 'RANKINGS', args.label);

  const result = await withSyncRun(
    { provider: args.source, job: 'rankings', season: args.season, week: args.week },
    async () => {
      const parsed = parseRankingsCsv(args.csv, {
        season: args.season,
        scope: args.scope,
        week: args.week ?? 0,
        format: args.format,
      });

      const resolver = await PlayerResolver.create({ source: args.source, learn: true });
      const { resolved, unresolved } = resolver.resolveMany(parsed.records.map((r) => r.player));
      const idByIndex = new Map<number, string>();
      parsed.records.forEach((rec, i) => {
        const hit = resolved.find((r) => r.name === rec.player.name && r.team === rec.player.team);
        if (hit) idByIndex.set(i, hit.playerId);
      });

      const capturedAt = new Date();
      let written = 0;

      for (const [i, rec] of parsed.records.entries()) {
        const playerId = idByIndex.get(i);
        if (!playerId) continue;
        await prisma.ranking.create({
          data: {
            playerId,
            source: args.source,
            scope: args.scope,
            season: args.season,
            week: args.week ?? 0,
            format: args.format,
            overallRank: rec.overallRank,
            positionRank: rec.positionRank,
            tier: rec.tier ? Math.round(rec.tier) : null,
            bestRank: rec.bestRank,
            worstRank: rec.worstRank,
            avgRank: rec.avgRank,
            stdDev: rec.stdDev,
            capturedAt,
          },
        });
        written += 1;
      }

      await resolver.commitLearned();
      await recordImport(args.source, written);

      return {
        recordsIn: parsed.records.length,
        recordsWritten: written,
        partial: unresolved.length > 0 || parsed.skipped.length > 0,
        detail: {
          unresolved: unresolved.map((u) => ({ name: u.name, team: u.team, position: u.position })),
          skipped: parsed.skipped,
          headersDetected: parsed.headersDetected,
          resolved: written,
        },
      };
    },
  );

  return toOutcome(result);
}

export async function importProjectionsCsv(args: {
  csv: string;
  source: string;
  label?: string;
  season: string;
  scope: ProjectionScope;
  week?: number;
  format: ScoringFormat;
}): Promise<ImportOutcome> {
  await ensureSource(args.source, 'PROJECTIONS', args.label);

  const result = await withSyncRun(
    { provider: args.source, job: 'projections', season: args.season, week: args.week },
    async () => {
      const parsed = parseProjectionsCsv(args.csv, {
        season: args.season,
        scope: args.scope,
        week: args.week ?? 0,
        format: args.format,
      });

      const resolver = await PlayerResolver.create({ source: args.source, learn: true });
      const capturedAt = new Date();
      const unresolved: { name: string; team?: string | null; position?: string | null }[] = [];
      let written = 0;

      for (const rec of parsed.records) {
        const hit = resolver.resolve(rec.player);
        if (!hit) {
          unresolved.push({ name: rec.player.name, team: rec.player.team, position: rec.player.position });
          continue;
        }
        await prisma.projection.create({
          data: {
            playerId: hit.playerId,
            source: args.source,
            scope: args.scope,
            season: args.season,
            week: args.week ?? 0,
            format: args.format,
            fantasyPoints: rec.fantasyPoints,
            floorPoints: rec.floorPoints,
            ceilingPoints: rec.ceilingPoints,
            gamesPlayed: rec.gamesPlayed,
            statsJson: writeJson(rec.stats),
            capturedAt,
          },
        });
        written += 1;
      }

      await resolver.commitLearned();
      await recordImport(args.source, written);

      return {
        recordsIn: parsed.records.length,
        recordsWritten: written,
        partial: unresolved.length > 0 || parsed.skipped.length > 0,
        detail: {
          unresolved,
          skipped: parsed.skipped,
          headersDetected: parsed.headersDetected,
          resolved: written,
        },
      };
    },
  );

  return toOutcome(result);
}

export async function importAdpCsv(args: {
  csv: string;
  source: string;
  label?: string;
  season: string;
  format: ScoringFormat;
  teamCount?: number;
}): Promise<ImportOutcome> {
  await ensureSource(args.source, 'ADP', args.label);

  const result = await withSyncRun({ provider: args.source, job: 'adp', season: args.season }, async () => {
    const parsed = parseAdpCsv(args.csv, {
      season: args.season,
      format: args.format,
      teamCount: args.teamCount ?? 0,
    });

    const resolver = await PlayerResolver.create({ source: args.source, learn: true });
    const capturedAt = new Date();
    const unresolved: { name: string; team?: string | null; position?: string | null }[] = [];
    let written = 0;

    for (const rec of parsed.records) {
      const hit = resolver.resolve(rec.player);
      if (!hit) {
        unresolved.push({ name: rec.player.name, team: rec.player.team, position: rec.player.position });
        continue;
      }
      await prisma.adpSnapshot.create({
        data: {
          playerId: hit.playerId,
          source: args.source,
          season: args.season,
          format: args.format,
          teamCount: args.teamCount ?? 0,
          adp: rec.adp,
          adpStdDev: rec.adpStdDev,
          minPick: rec.minPick,
          maxPick: rec.maxPick,
          timesDrafted: rec.timesDrafted,
          capturedAt,
        },
      });
      written += 1;
    }

    await resolver.commitLearned();
    await recordImport(args.source, written);

    return {
      recordsIn: parsed.records.length,
      recordsWritten: written,
      partial: unresolved.length > 0,
      detail: { unresolved, skipped: parsed.skipped, headersDetected: parsed.headersDetected, resolved: written },
    };
  });

  return toOutcome(result);
}

function toOutcome(result: SyncResult): ImportOutcome {
  const detail = (result.detail ?? {}) as {
    unresolved?: { name: string; team?: string | null; position?: string | null }[];
    skipped?: { row: number; reason: string }[];
    headersDetected?: string[];
    resolved?: number;
  };
  return {
    ...result,
    resolved: detail.resolved ?? result.recordsWritten,
    unresolved: detail.unresolved ?? [],
    skipped: detail.skipped ?? [],
    headersDetected: detail.headersDetected ?? [],
  };
}
