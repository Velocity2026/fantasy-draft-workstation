import { args, log, main } from './_cli';
import { syncPlayers } from '../src/lib/sync/players';

/** Refresh the Sleeper player dictionary. `--force` bypasses the 24h cache. */
main(async () => {
  const a = args();
  log.title('Syncing players from Sleeper');
  if (a.force === true) log.step('Forcing a fresh download (ignoring cache)...');

  const result = await syncPlayers({ force: a.force === true });
  log.ok(`${result.recordsWritten} fantasy-relevant players stored`);

  const detail = result.detail as { discarded?: number; keptPositions?: string[] };
  if (detail?.discarded) {
    log.plain(`  ${detail.discarded} non-fantasy players skipped (kept: ${detail.keptPositions?.join(', ')})`);
  }
});
