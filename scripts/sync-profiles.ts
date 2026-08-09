import { log, main } from './_cli';
import { syncPlayerProfiles } from '../src/lib/sync/profiles';
import { prisma } from '../src/lib/db';

/**
 * Build player athletic/draft-capital profiles from nflverse.
 *
 *   npm run sync:profiles
 */
main(async () => {
  log.title('Building player profiles from nflverse');
  log.step('Downloading players.csv and combine.csv (~25k rows)...');

  const result = await syncPlayerProfiles();
  const d = result.detail as {
    matchedByBirthDate: number;
    matchedByNamePosition: number;
    withDraftCapital: number;
    withCombineWorkout: number;
    unmatchedRelevant: string[];
    unmatchedRelevantCount: number;
  };

  log.ok(`${result.recordsWritten} of ${result.recordsIn} players profiled`);
  log.plain(`  matched on name + birth date : ${d.matchedByBirthDate}`);
  log.plain(`  matched on name + position   : ${d.matchedByNamePosition}`);
  log.plain(`  with NFL draft capital       : ${d.withDraftCapital}`);
  log.plain(`  with a combine workout       : ${d.withCombineWorkout}`);

  if (d.unmatchedRelevantCount) {
    log.warn(`${d.unmatchedRelevantCount} draftable players could not be matched:`);
    log.plain(`    ${d.unmatchedRelevant.slice(0, 15).join(', ')}`);
    log.plain('    Usually current-year rookies nflverse has not published yet.');
  }

  // Show what this unlocks: the highest-capital players with no production yet.
  const sleepers = await prisma.playerProfile.findMany({
    where: {
      draftRound: { lte: 3 },
      player: { active: true, searchRank: { gt: 60 } },
    },
    include: { player: { select: { fullName: true, position: true, teamId: true, searchRank: true } } },
    orderBy: [{ draftOverall: 'asc' }],
    take: 15,
  });

  if (sleepers.length) {
    log.plain('\n  Premium draft capital, low current market interest:');
    log.plain(`  ${'PLAYER'.padEnd(24)} ${'POS'.padEnd(4)} ${'DRAFT'.padEnd(10)} ${'ATH'.padStart(5)} ${'RANK'.padStart(5)}`);
    log.plain(`  ${'-'.repeat(54)}`);
    for (const s of sleepers) {
      log.plain(
        `  ${s.player.fullName.slice(0, 24).padEnd(24)} ${s.player.position.padEnd(4)} ` +
          `${`R${s.draftRound} #${s.draftOverall ?? '?'}`.padEnd(10)} ` +
          `${(s.athleticScore !== null ? (s.athleticScore * 100).toFixed(0) : '—').padStart(5)} ` +
          `${String(s.player.searchRank ?? '—').padStart(5)}`,
      );
    }
  }
});
