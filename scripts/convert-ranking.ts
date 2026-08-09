import { args, log, main, resolveSeason } from './_cli';
import { convertRankingTiersToProjection } from '../src/lib/valuation/rank-to-projection';

/**
 * Convert an imported tiered ranking into real projection points so it
 * actually moves the board, instead of only affecting the fallback curve.
 *
 *   npx tsx scripts/convert-ranking.ts --source jeff-ratcliffe --avoid-tier 6
 */
main(async () => {
  const a = args();
  const source = typeof a.source === 'string' ? a.source : null;
  if (!source) throw new Error('Usage: --source <key> [--avoid-tier N] [--season YYYY]');

  const season = await resolveSeason(a.season);
  const avoidTier = typeof a['avoid-tier'] === 'string' ? Number(a['avoid-tier']) : undefined;

  log.title(`Converting "${source}" tiers into projections (${season})`);
  const result = await convertRankingTiersToProjection({ source, season, avoidTier });

  log.ok(`${result.projected} players converted to projection points`);
  if (result.avoided) log.plain(`  ${result.avoided} "do not draft" players logged as Evidence instead`);
  if (result.skippedNoTier) log.warn(`${result.skippedNoTier} rows had no tier or unknown position, skipped`);
  log.plain('\n  Run `npm run value` to rebuild the board with this.');
});
