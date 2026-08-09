import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { boardMovers, sourceRankingMovers, sourcesWithHistory, type MoversResult } from '../src/lib/analysis/movers';

/**
 * Who's rising, who's falling, and why.
 *
 *   npx tsx scripts/movers.ts                    # board movers (your own valuation history)
 *   npx tsx scripts/movers.ts --source fantasypros # movers within one source's own ranking history
 */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);
  const season = await resolveSeason(a.season);

  if (typeof a.source === 'string') {
    log.title(`Movers within "${a.source}" rankings`);
    const result = await sourceRankingMovers({ source: a.source, season });
    if (!result) {
      const available = await sourcesWithHistory(season);
      log.warn(`"${a.source}" has fewer than two ranking imports for ${season} — nothing to diff yet.`);
      if (available.length) {
        log.plain(`  Sources with enough history: ${available.map((s) => `${s.source} (${s.batches})`).join(', ')}`);
      } else {
        log.plain('  No source has 2+ ranking imports yet. Re-import the same source later to build history.');
      }
      return;
    }
    printMovers(result);
    return;
  }

  log.title('Board movers');
  log.plain('  Comparing the two most recent valuation runs for this league.\n');
  const result = await boardMovers({ leagueId, season });
  if (!result) {
    log.warn('Need at least two valuation runs to compare. Run `npm run value` again later and re-run this.');
    return;
  }
  printMovers(result);
});

function printMovers(result: MoversResult) {
  const hours = (result.comparedAt.current.getTime() - result.comparedAt.previous.getTime()) / 3600000;
  log.plain(`  Comparing snapshots ${hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`} apart.\n`);

  const print = (title: string, movers: MoversResult['risers']) => {
    log.plain(`  ${title}`);
    if (!movers.length) {
      log.plain('    none');
      return;
    }
    for (const m of movers) {
      const arrow = m.rankDelta > 0 ? '▲' : '▼';
      log.plain(
        `    ${arrow} ${String(Math.abs(m.rankDelta)).padStart(3)}  ${m.name.padEnd(24)} ${m.position.padEnd(4)} ` +
          `${(m.team ?? 'FA').padEnd(4)} ${String(m.previousRank).padStart(4)} -> ${String(m.currentRank).padStart(4)}`,
      );
      for (const r of m.reasons) log.plain(`         · ${r}`);
    }
  };

  print('RISERS', result.risers);
  log.plain('');
  print('FALLERS', result.fallers);
}
