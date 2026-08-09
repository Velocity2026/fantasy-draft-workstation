import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { syncLeague, syncTransactions } from '../src/lib/sync/league';
import { syncDrafts } from '../src/lib/sync/draft';
import { prisma } from '../src/lib/db';

/**
 * Sync one league: settings, managers, rosters, drafts and optionally
 * transactions.
 *
 *   npx tsx scripts/sync-league.ts --league 123 --primary
 *   npx tsx scripts/sync-league.ts --transactions 1-18
 */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);

  log.title(`Syncing league ${leagueId}`);
  const result = await syncLeague(leagueId, { markPrimary: a.primary === true });

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  log.ok(`${league.name} — ${league.totalRosters} teams, ${league.scoringType}, season ${league.season}`);
  log.plain(`  ${result.recordsWritten} member/roster records`);

  await syncDrafts(leagueId);
  log.ok('Drafts synced');

  if (typeof a.transactions === 'string') {
    const weeks = parseWeeks(a.transactions);
    const season = await resolveSeason(a.season);
    log.step(`Importing transactions for weeks ${weeks[0]}–${weeks[weeks.length - 1]}...`);
    const txns = await syncTransactions(leagueId, season, weeks);
    log.ok(`${txns.recordsWritten} transactions`);
  }
});

/** Accepts "1-18", "1,5,9" or "7". */
function parseWeeks(spec: string): number[] {
  if (spec.includes('-')) {
    const [from, to] = spec.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return spec.split(',').map(Number).filter(Number.isFinite);
}
