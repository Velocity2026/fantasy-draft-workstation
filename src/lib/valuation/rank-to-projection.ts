import { prisma } from '../db';
import { writeJson } from '../json';
import { baselinePoints } from './baseline';
import { SKILL_POSITIONS, type ScoringFormat, type SkillPosition } from '../enums';

/**
 * Convert a tiered/ordinal ranking source into real Projection rows.
 *
 * Without this, an imported ranking only ever reaches the fallback rank-curve
 * path — which only fires for players with no other projection. For an
 * established player who already has a production-based projection, an
 * analyst's ranking would silently do nothing: it would never move his VORP,
 * never move his tier, never move his position on the board. For a source you
 * specifically want to carry weight (an analyst you rate above the stats-only
 * model), that defeats the point of importing him.
 *
 * Method: flatten the source's tiers into one continuous per-position order
 * (tier ascending, then the analyst's own within-tier order), then run that
 * rank through the same positional decay curve used for the baseline fallback
 * to get an implied points value. This intentionally does not try to preserve
 * exact tier gaps — once blended, natural-break tiering re-derives its own
 * breaks from the combined curve, and a genuine value cliff the analyst saw
 * should still show up as a gap in the blended VORP.
 *
 * Rows at or beyond `avoidTier` (an explicit "do not draft" grouping, not just
 * a low tier) are deliberately NOT converted to points — inventing a negative
 * points value to represent "avoid despite box-score production" would be
 * fabricating a number to express a qualitative warning. Those become Evidence
 * instead, visible on the Research page, so the reasoning is preserved rather
 * than laundered into a fake number.
 */
export async function convertRankingTiersToProjection(args: {
  source: string;
  season: string;
  format?: ScoringFormat;
  /** Tier number (inclusive) and above treated as "avoid", not a value tier. */
  avoidTier?: number;
}): Promise<{ projected: number; avoided: number; skippedNoTier: number }> {
  const format = args.format ?? 'PPR';

  const rows = await prisma.ranking.findMany({
    where: { source: args.source, season: args.season, scope: 'DRAFT' },
    select: { playerId: true, tier: true, positionRank: true, capturedAt: true },
    orderBy: { capturedAt: 'desc' },
  });

  // Only the latest batch — same append-only discipline as everywhere else.
  const latestCapturedAt = rows[0]?.capturedAt;
  const latest = latestCapturedAt ? rows.filter((r) => r.capturedAt.getTime() === latestCapturedAt.getTime()) : [];

  const players = await prisma.player.findMany({
    where: { id: { in: latest.map((r) => r.playerId) } },
    select: { id: true, position: true },
  });
  const positionById = new Map(players.map((p) => [p.id, p.position as SkillPosition]));

  let skippedNoTier = 0;
  const byPosition = new Map<SkillPosition, { playerId: string; tier: number; withinTier: number }[]>();

  for (const r of latest) {
    const position = positionById.get(r.playerId);
    if (!position || !SKILL_POSITIONS.includes(position) || r.tier === null) {
      skippedNoTier += 1;
      continue;
    }
    const list = byPosition.get(position) ?? [];
    list.push({ playerId: r.playerId, tier: r.tier, withinTier: r.positionRank ?? 999 });
    byPosition.set(position, list);
  }

  // This is a deterministic recomputation from the Ranking rows, so a re-run
  // for the SAME season replaces the last rather than accumulating stale
  // copies -- the same discipline applied to the internal-production model
  // and to ADP after both hit the "old batch lingers and gets read as latest"
  // bug. Both deletes are season-scoped on purpose: Craig will re-run this
  // against next year's guide under season 2027, and 2026's rows must stay
  // untouched as history rather than being silently deleted out from under
  // him. Evidence deletion is additionally scoped to rows THIS function
  // generated (isUserEntered: false, matching headline) so a re-run never
  // touches anything typed in by hand under the same source name.
  await prisma.projection.deleteMany({ where: { source: args.source, season: args.season, scope: 'SEASON' } });
  await prisma.evidence.deleteMany({
    where: {
      sourceName: args.source,
      season: args.season,
      isUserEntered: false,
      headline: `${args.source}: do not draft`,
    },
  });

  const capturedAt = new Date();
  let projected = 0;
  let avoided = 0;
  const avoidTier = args.avoidTier ?? Number.POSITIVE_INFINITY;

  for (const [position, list] of byPosition) {
    const ordered = [...list].sort((a, b) => (a.tier - b.tier) || (a.withinTier - b.withinTier));

    let continuousRank = 0;
    for (const entry of ordered) {
      if (entry.tier >= avoidTier) {
        await prisma.evidence.create({
          data: {
            subjectType: 'PLAYER',
            subjectId: entry.playerId,
            playerId: entry.playerId,
            evidenceType: 'MANUAL_NOTE',
            season: args.season,
            headline: `${args.source}: do not draft`,
            body: 'Listed in the "do not draft" group — the analyst is flagging a specific risk (unsustainable role, TD-rate mirage, incoming competition), not just ranking him low.',
            sourceName: args.source,
            confidence: await sourceTrust(args.source),
            sentiment: -1,
            impact: 'HIGH',
            isUserEntered: false,
            observedAt: capturedAt,
          },
        });
        avoided += 1;
        continue;
      }

      continuousRank += 1;
      const points = baselinePoints(position, continuousRank, format);

      await prisma.projection.create({
        data: {
          playerId: entry.playerId,
          source: args.source,
          scope: 'SEASON',
          season: args.season,
          week: 0,
          format,
          fantasyPoints: points,
          statsJson: writeJson({
            derivedFrom: 'rank-to-projection',
            tier: entry.tier,
            withinTierOrder: entry.withinTier,
            continuousPositionRank: continuousRank,
          }),
          capturedAt,
        },
      });
      projected += 1;
    }
  }

  return { projected, avoided, skippedNoTier };
}

async function sourceTrust(source: string): Promise<number> {
  const row = await prisma.dataSource.findUnique({ where: { key: source }, select: { trust: true } });
  return row?.trust ?? 0.5;
}
