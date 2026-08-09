import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { syncPlayers } from '../src/lib/sync/players';
import { syncLeague } from '../src/lib/sync/league';
import { syncDrafts } from '../src/lib/sync/draft';
import { computeManagerProfiles } from '../src/lib/sync/history';
import { deriveLeagueAdp, syncTrending } from '../src/lib/sync/market';
import { runValuation } from '../src/lib/valuation/engine';

/**
 * Routine refresh. Run this the morning of the draft, or on a schedule.
 * Unlike bootstrap it does not re-walk prior seasons — that only needs doing
 * once (use `npm run sync:history` if a past season is missing).
 */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);
  const season = await resolveSeason(a.season);

  log.title(`Refreshing league ${leagueId} (${season})`);

  log.step('Players...');
  const players = await syncPlayers({ force: a.force === true });
  log.ok(`${players.recordsWritten} players`);

  log.step('League, members, rosters...');
  await syncLeague(leagueId);
  log.ok('League synced');

  log.step('Drafts...');
  await syncDrafts(leagueId);
  log.ok('Drafts synced');

  log.step('ADP from league history...');
  const adp = await deriveLeagueAdp({ leagueId, season });
  log.ok(`${adp.recordsWritten} ADP records`);

  log.step('Add/drop trends...');
  const trending = await syncTrending(season);
  log.ok(`${trending.recordsWritten} trend records`);

  log.step('Manager profiles...');
  await computeManagerProfiles(leagueId);
  log.ok('Profiles updated');

  if (a['skip-valuation'] !== true) {
    log.step('Re-running valuation...');
    const valuation = await runValuation({ leagueId, season, scope: 'DRAFT', label: 'Scheduled refresh' });
    log.ok(`${valuation.recordsWritten} players valued`);
  }
});
