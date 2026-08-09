import { args, log, main, resolveSeason } from './_cli';
import { buildProductionProjections } from '../src/lib/valuation/project';

/**
 * Build projections from historical production.
 *
 *   npm run project
 */
main(async () => {
  const a = args();
  const season = await resolveSeason(a.season);

  log.title(`Building production projections for ${season}`);
  const r = await buildProductionProjections({ season });
  const d = r.detail as { fromProduction: number; fromDraftCapital: number; skippedNoBasis: number };

  log.ok(`${r.recordsWritten} projections written`);
  log.plain(`  from actual production : ${d.fromProduction}`);
  log.plain(`  rookies via draft capital: ${d.fromDraftCapital}`);
  log.plain(`  no basis, left off board : ${d.skippedNoBasis}`);
  log.plain('\n  Run `npm run value` to rebuild the board with these.');
});
