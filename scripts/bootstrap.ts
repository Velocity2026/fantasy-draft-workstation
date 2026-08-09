import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { seedSources } from '../src/lib/sources';
import { syncPlayers } from '../src/lib/sync/players';
import { syncLeague } from '../src/lib/sync/league';
import { syncHistory, computeManagerProfiles } from '../src/lib/sync/history';
import { deriveLeagueAdp, syncTrending } from '../src/lib/sync/market';
import { syncDrafts } from '../src/lib/sync/draft';
import { runValuation } from '../src/lib/valuation/engine';
import { setConfig } from '../src/lib/config';
import { prisma } from '../src/lib/db';

/**
 * One-shot first-run setup. Safe to re-run — every step is idempotent.
 *
 *   npm run setup
 *   npx tsx scripts/bootstrap.ts --league 123456789 --username craig
 */
main(async () => {
  const a = args();
  log.title('Fantasy Draft Workstation — bootstrap');

  // --- 1. Source registry -------------------------------------------------
  log.step('Seeding data-source registry...');
  const created = await seedSources();
  log.ok(`Data sources ready (${created} added)`);

  // --- 2. Players ---------------------------------------------------------
  log.step('Downloading Sleeper player dictionary (~5 MB, cached for 24h)...');
  const players = await syncPlayers({ force: a.force === true });
  log.ok(`${players.recordsWritten} fantasy-relevant players stored`);

  // --- 3. League ----------------------------------------------------------
  const leagueId = await resolveLeagueId(a.league);
  const username = typeof a.username === 'string' ? a.username : process.env.SLEEPER_USERNAME;
  if (username) await setConfig({ sleeperUsername: username });

  log.step(`Importing league ${leagueId}...`);
  const league = await syncLeague(leagueId, { markPrimary: true });
  const leagueRow = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  log.ok(`${leagueRow.name} — ${leagueRow.totalRosters} teams, ${leagueRow.scoringType}, ${leagueRow.season}`);
  if (leagueRow.isKeeper) log.ok('Keeper league detected');
  log.plain(`  ${league.recordsWritten} member/roster records written`);

  const me = await prisma.leagueMember.findFirst({ where: { leagueId, isMe: true } });
  if (me) {
    log.ok(`Identified you as "${me.displayName}"`);
  } else {
    log.warn('Could not tell which team is yours — set SLEEPER_USERNAME in .env, or pick it on the Settings page.');
  }

  // --- 4. Drafts and history ---------------------------------------------
  log.step('Importing drafts...');
  await syncDrafts(leagueId);

  log.step('Walking prior seasons for draft history...');
  const history = await syncHistory(leagueId);
  log.ok(`${history.recordsIn} season(s), ${history.recordsWritten} draft(s) imported`);

  // --- 5. Market ----------------------------------------------------------
  const season = await resolveSeason(a.season);

  log.step('Deriving ADP from this league’s own draft history...');
  const adp = await deriveLeagueAdp({ leagueId, season });
  if (adp.recordsWritten > 0) {
    log.ok(`ADP derived for ${adp.recordsWritten} players`);
  } else {
    log.warn('No completed drafts found yet — ADP will be thin until you import projections or a public ADP CSV.');
  }

  log.step('Fetching Sleeper add/drop trends...');
  const trending = await syncTrending(season);
  log.ok(`${trending.recordsWritten} trending players recorded`);

  log.step('Building manager tendency profiles...');
  const profiles = await computeManagerProfiles(leagueId);
  log.ok(`${profiles.recordsWritten} manager profiles computed`);

  // --- 6. First valuation -------------------------------------------------
  log.step('Running initial valuation...');
  const valuation = await runValuation({ leagueId, season, scope: 'DRAFT', label: 'Bootstrap' });
  log.ok(`${valuation.recordsWritten} players valued`);

  const baselineCount = (valuation.detail as { baselineCount?: number })?.baselineCount ?? 0;
  if (baselineCount > 0) {
    log.warn(
      `${baselineCount} players have no imported projection and are using the fallback curve.\n` +
        '    Import a projections CSV on the Sources page for real numbers.',
    );
  }

  log.title('Bootstrap complete');
  log.plain('Next: run `npm run dev` and open http://localhost:3210');
});
