import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { syncHistory, computeManagerProfiles, importKeepersFromDraft } from '../src/lib/sync/history';
import { deriveLeagueAdp } from '../src/lib/sync/market';
import { prisma } from '../src/lib/db';

/**
 * Walk the league's season chain, import every prior draft, then rebuild ADP
 * and manager tendency profiles from it. This is the step that turns generic
 * advice into advice about *these ten managers*.
 */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);
  const season = await resolveSeason(a.season);

  log.title('Importing league history');
  const history = await syncHistory(leagueId);
  log.ok(`${history.recordsIn} season(s) walked, ${history.recordsWritten} draft(s) imported`);

  const detail = history.detail as { leagueIds?: string[] };
  if (detail?.leagueIds?.length) log.plain(`  Chain: ${detail.leagueIds.join(' → ')}`);

  const drafts = await prisma.draft.findMany({
    where: { leagueId: { in: detail?.leagueIds ?? [leagueId] } },
    select: { id: true, season: true, status: true },
    orderBy: { season: 'desc' },
  });
  for (const d of drafts) log.plain(`  ${d.season}: draft ${d.id} (${d.status})`);

  log.step('Importing keepers recorded on past drafts...');
  let keepers = 0;
  for (const d of drafts) {
    const result = await importKeepersFromDraft(d.id);
    keepers += result.recordsWritten;
  }
  log.ok(`${keepers} keeper declarations`);

  log.step('Deriving ADP...');
  const adp = await deriveLeagueAdp({ leagueId, season });
  log.ok(`${adp.recordsWritten} players`);

  log.step('Computing manager profiles...');
  const profiles = await computeManagerProfiles(leagueId);
  log.ok(`${profiles.recordsWritten} managers profiled`);

  if (!drafts.length) {
    log.warn('No drafts found. If this is the league’s first season there is no history to learn from yet.');
  }
});
