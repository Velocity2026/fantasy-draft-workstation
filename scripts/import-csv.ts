import { readFileSync } from 'node:fs';
import path from 'node:path';
import { args, log, main, resolveSeason } from './_cli';
import { importAdpCsv, importProjectionsCsv, importRankingsCsv } from '../src/lib/sync/import';
import type { ScoringFormat } from '../src/lib/enums';

/**
 * Import a rankings / projections / ADP CSV under any source key.
 *
 *   npx tsx scripts/import-csv.ts --file ~/Downloads/ftn.csv --source ftn --type projections
 *   npx tsx scripts/import-csv.ts --file fp.csv --source fantasypros --type rankings
 *   npx tsx scripts/import-csv.ts --file mike.csv --source mike-clay --type rankings --label "Mike Clay"
 *
 * The source key is free-text — importing under a new key registers it
 * automatically, so adding a new site or a specific writer needs no code change.
 */
main(async () => {
  const a = args();

  const file = typeof a.file === 'string' ? a.file : null;
  const source = typeof a.source === 'string' ? a.source : null;
  const type = typeof a.type === 'string' ? a.type.toLowerCase() : 'rankings';

  if (!file || !source) {
    throw new Error(
      'Usage: --file <path.csv> --source <key> --type <rankings|projections|adp> [--label "Nice Name"] [--week N] [--format PPR]',
    );
  }

  const csv = readFileSync(path.resolve(file), 'utf8');
  const season = await resolveSeason(a.season);
  const format = (typeof a.format === 'string' ? a.format.toUpperCase() : 'PPR') as ScoringFormat;
  const label = typeof a.label === 'string' ? a.label : undefined;
  const week = typeof a.week === 'string' ? Number(a.week) : undefined;

  log.title(`Importing ${type} from ${path.basename(file)} as source "${source}"`);

  const outcome =
    type === 'projections'
      ? await importProjectionsCsv({
          csv,
          source,
          label,
          season,
          scope: week ? 'WEEKLY' : 'SEASON',
          week,
          format,
        })
      : type === 'adp'
        ? await importAdpCsv({
            csv,
            source,
            label,
            season,
            format,
            teamCount: typeof a.teams === 'string' ? Number(a.teams) : undefined,
          })
        : await importRankingsCsv({
            csv,
            source,
            label,
            season,
            scope: week ? 'WEEKLY' : 'DRAFT',
            week,
            format,
          });

  log.ok(`${outcome.recordsWritten} of ${outcome.recordsIn} rows imported`);
  log.plain(`  Columns recognised: ${outcome.headersDetected.join(', ') || 'none'}`);

  if (outcome.skipped.length) {
    log.warn(`${outcome.skipped.length} rows skipped:`);
    for (const s of outcome.skipped.slice(0, 10)) log.plain(`    row ${s.row}: ${s.reason}`);
    if (outcome.skipped.length > 10) log.plain(`    ...and ${outcome.skipped.length - 10} more`);
  }

  if (outcome.unresolved.length) {
    log.warn(`${outcome.unresolved.length} players could not be matched to a Sleeper player:`);
    for (const u of outcome.unresolved.slice(0, 20)) {
      log.plain(`    ${u.name}${u.team ? ` (${u.team})` : ''}${u.position ? ` ${u.position}` : ''}`);
    }
    if (outcome.unresolved.length > 20) log.plain(`    ...and ${outcome.unresolved.length - 20} more`);
    log.plain('\n  Unmatched names are usually retired players, team defences, or spelling differences.');
    log.plain('  They are reported rather than dropped silently so you can check nothing important is missing.');
  }

  log.plain('\n  Run `npm run value` to rebuild the board with this data.');
});
