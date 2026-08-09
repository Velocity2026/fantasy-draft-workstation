import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { deriveLeagueAdp, syncTrending } from '../src/lib/sync/market';

/** Refresh add/drop velocity and re-derive ADP. Cheap — safe to run often. */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);
  const season = await resolveSeason(a.season);
  const lookback = typeof a.lookback === 'string' ? Number(a.lookback) : 24;

  log.title(`Refreshing market data (${season})`);

  log.step(`Sleeper add/drop trends, ${lookback}h lookback...`);
  const trending = await syncTrending(season, lookback);
  log.ok(`${trending.recordsWritten} players`);

  log.step('Re-deriving league ADP...');
  const adp = await deriveLeagueAdp({ leagueId, season });
  log.ok(`${adp.recordsWritten} players`);
});
