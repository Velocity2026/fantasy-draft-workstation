import { prisma } from './db';
import { writeJson } from './json';

/**
 * Data-source registry.
 *
 * The design goal: swapping FantasyPros for somewhere else, or adding one
 * writer whose opinion you rate, should be a row in a table — not a code
 * change. That works because nothing in the analysis engine hardcodes a source
 * name. Rankings, projections, ADP and evidence rows all carry a free-text
 * `source`, and the blend weights are looked up here at valuation time.
 *
 * Three things a source can do:
 *   1. Supply numbers (PROJECTIONS / RANKINGS / ADP) — blended by `weight`.
 *   2. Supply observations (NEWS / ANALYST) — become Evidence, with `trust` as
 *      the default confidence, which is what recommendation scoring reads.
 *   3. Both. A writer who publishes rankings *and* commentary is one source
 *      with a rankings weight and a trust score.
 */

export type SourceKind = 'PROJECTIONS' | 'RANKINGS' | 'ADP' | 'USAGE' | 'NEWS' | 'ANALYST' | 'MARKET';
export type SourceAdapter = 'CSV' | 'SLEEPER' | 'HTTP_JSON' | 'MANUAL';

export const SOURCE_KINDS: SourceKind[] = [
  'PROJECTIONS',
  'RANKINGS',
  'ADP',
  'USAGE',
  'NEWS',
  'ANALYST',
  'MARKET',
];

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  PROJECTIONS: 'Projections (points)',
  RANKINGS: 'Rankings (order)',
  ADP: 'ADP / draft market',
  USAGE: 'Usage & snap data',
  NEWS: 'News & reports',
  ANALYST: 'Individual analyst',
  MARKET: 'Roster % / add-drop',
};

export const SOURCE_ADAPTER_LABELS: Record<SourceAdapter, string> = {
  CSV: 'CSV / spreadsheet upload',
  SLEEPER: 'Sleeper API (built in)',
  HTTP_JSON: 'HTTP JSON endpoint',
  MANUAL: 'Typed in by hand',
};

/**
 * Seeded on first boot. These are starting points, not a fixed list — all of
 * them can be edited, disabled or deleted from the Sources page.
 */
const BUILT_IN_SOURCES = [
  {
    key: 'sleeper',
    label: 'Sleeper',
    kind: 'MARKET' as SourceKind,
    adapter: 'SLEEPER' as SourceAdapter,
    weight: 1,
    trust: 0.5,
    isBuiltIn: true,
    url: 'https://sleeper.com',
    notes: 'League, rosters, drafts and add/drop trends. Always on — this is the league of record.',
  },
  {
    key: 'league-history',
    label: 'This league’s draft history',
    kind: 'ADP' as SourceKind,
    adapter: 'SLEEPER' as SourceAdapter,
    weight: 1,
    trust: 0.8,
    isBuiltIn: true,
    notes:
      'ADP derived from how these ten managers have actually drafted in prior seasons. Usually a better prior than a generic public ADP for a 10-team keeper league.',
  },
  {
    key: 'baseline',
    label: 'Fallback rank curve',
    kind: 'PROJECTIONS' as SourceKind,
    adapter: 'MANUAL' as SourceAdapter,
    weight: 0.2,
    trust: 0.2,
    isBuiltIn: true,
    notes:
      'Internal shape-only curve used when a player has no imported projection. Low weight on purpose — it exists so the board is never empty, not because it is good.',
  },
  {
    key: 'fantasypros',
    label: 'FantasyPros',
    kind: 'RANKINGS' as SourceKind,
    adapter: 'CSV' as SourceAdapter,
    weight: 1,
    trust: 0.6,
    isBuiltIn: false,
    url: 'https://www.fantasypros.com',
    notes: 'Expert-consensus rankings. Export as CSV and import on the Sources page.',
  },
  {
    key: 'ftn',
    label: 'FTN Fantasy',
    kind: 'PROJECTIONS' as SourceKind,
    adapter: 'CSV' as SourceAdapter,
    weight: 1.2,
    trust: 0.7,
    isBuiltIn: false,
    url: 'https://ftnfantasy.com',
    notes: 'Projections. Weighted slightly above consensus by default — change this to taste.',
  },
];

export async function seedSources(): Promise<number> {
  let created = 0;
  for (const s of BUILT_IN_SOURCES) {
    const existing = await prisma.dataSource.findUnique({ where: { key: s.key } });
    if (existing) continue;
    await prisma.dataSource.create({ data: s });
    created += 1;
  }
  return created;
}

export async function listSources(kind?: SourceKind) {
  return prisma.dataSource.findMany({
    where: kind ? { kind } : undefined,
    orderBy: [{ enabled: 'desc' }, { kind: 'asc' }, { label: 'asc' }],
  });
}

export interface SourceInput {
  key: string;
  label: string;
  kind: SourceKind;
  adapter: SourceAdapter;
  enabled?: boolean;
  weight?: number;
  trust?: number;
  notes?: string | null;
  url?: string | null;
  config?: unknown;
}

export async function upsertSource(input: SourceInput) {
  const key = normaliseKey(input.key);
  const data = {
    label: input.label.trim(),
    kind: input.kind,
    adapter: input.adapter,
    enabled: input.enabled ?? true,
    weight: clampNonNegative(input.weight ?? 1),
    trust: clamp01(input.trust ?? 0.5),
    notes: input.notes?.trim() || null,
    url: input.url?.trim() || null,
    configJson: writeJson(input.config),
  };

  return prisma.dataSource.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });
}

/**
 * Deleting a source leaves its historical rows in place — they simply stop
 * contributing to the blend. That is deliberate: you should be able to look
 * back at what a source said even after dropping it.
 */
export async function deleteSource(key: string) {
  const source = await prisma.dataSource.findUnique({ where: { key } });
  if (!source) return null;
  if (source.isBuiltIn) {
    throw new Error(
      `"${source.label}" is a built-in source and cannot be deleted. Disable it or set its weight to 0 instead.`,
    );
  }
  return prisma.dataSource.delete({ where: { key } });
}

export async function setSourceEnabled(key: string, enabled: boolean) {
  return prisma.dataSource.update({ where: { key }, data: { enabled } });
}

export async function setSourceWeight(key: string, weight: number) {
  return prisma.dataSource.update({ where: { key }, data: { weight: clampNonNegative(weight) } });
}

/**
 * The weight map the valuation engine blends with. Disabled sources are
 * omitted entirely rather than zero-weighted, so a player whose only projection
 * came from a disabled source correctly falls back to the baseline curve rather
 * than ending up with a divide-by-zero.
 */
export async function getProjectionWeights(): Promise<Record<string, number>> {
  const sources = await prisma.dataSource.findMany({
    where: { enabled: true, kind: { in: ['PROJECTIONS', 'RANKINGS', 'ANALYST'] }, weight: { gt: 0 } },
    select: { key: true, weight: true },
  });

  const weights: Record<string, number> = {};
  for (const s of sources) weights[s.key] = s.weight;

  // A source that has data but no registry row still counts — otherwise an
  // import done before the row existed would silently vanish from the blend.
  if (!Object.keys(weights).length) weights['*'] = 1;
  return weights;
}

/** Default Evidence confidence for a source, used when none is supplied. */
export async function getSourceTrust(key: string): Promise<number> {
  const source = await prisma.dataSource.findUnique({ where: { key }, select: { trust: true } });
  return source?.trust ?? 0.5;
}

export async function getTrustMap(): Promise<Record<string, number>> {
  const sources = await prisma.dataSource.findMany({ select: { key: true, trust: true, enabled: true } });
  const map: Record<string, number> = {};
  for (const s of sources) map[s.key] = s.enabled ? s.trust : 0;
  return map;
}

export async function recordImport(key: string, recordCount: number) {
  await prisma.dataSource.updateMany({
    where: { key },
    data: { lastImportedAt: new Date(), lastRecordCount: recordCount },
  });
}

/**
 * How much data each source has actually contributed. Shown on the Sources page
 * so a source that looks configured but has never imported anything is obvious.
 */
export async function sourceUsageStats(): Promise<Record<string, { rankings: number; projections: number; adp: number; evidence: number }>> {
  const [rankings, projections, adp, evidence] = await Promise.all([
    prisma.ranking.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.projection.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.adpSnapshot.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.evidence.groupBy({ by: ['sourceName'], _count: { _all: true } }),
  ]);

  const out: Record<string, { rankings: number; projections: number; adp: number; evidence: number }> = {};
  const bump = (key: string | null, field: 'rankings' | 'projections' | 'adp' | 'evidence', n: number) => {
    if (!key) return;
    out[key] ??= { rankings: 0, projections: 0, adp: 0, evidence: 0 };
    out[key][field] += n;
  };

  for (const r of rankings) bump(r.source, 'rankings', r._count._all);
  for (const p of projections) bump(p.source, 'projections', p._count._all);
  for (const a of adp) bump(a.source, 'adp', a._count._all);
  for (const e of evidence) bump(e.sourceName, 'evidence', e._count._all);

  return out;
}

function normaliseKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export { normaliseKey as normaliseSourceKey };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}
