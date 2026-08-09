import { args, log, main, resolveLeagueId, resolveSeason } from './_cli';
import { runValuation, loadBoard } from '../src/lib/valuation/engine';
import { getProjectionWeights } from '../src/lib/sources';
import type { ReplacementMethod } from '../src/lib/valuation/replacement';

/**
 * Recompute player values and print the top of the board.
 *
 *   npm run value
 *   npx tsx scripts/run-valuation.ts --method LAST_STARTER --risk 0.4 --top 40
 */
main(async () => {
  const a = args();
  const leagueId = await resolveLeagueId(a.league);
  const season = await resolveSeason(a.season);
  const top = typeof a.top === 'string' ? Number(a.top) : 25;

  const weights = await getProjectionWeights();
  log.title(`Valuing ${season} board`);
  log.plain(`  Source weights: ${Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  const result = await runValuation({
    leagueId,
    season,
    scope: 'DRAFT',
    label: typeof a.label === 'string' ? a.label : 'CLI run',
    replacementMethod: typeof a.method === 'string' ? (a.method as ReplacementMethod) : undefined,
    riskAversion: typeof a.risk === 'string' ? Number(a.risk) : undefined,
  });

  log.ok(`${result.recordsWritten} players valued (run ${result.runId})`);

  const detail = result.detail as {
    replacement?: Record<string, number>;
    baselineCount?: number;
  };

  if (detail?.replacement) {
    log.plain('\n  Replacement level (points):');
    for (const [pos, pts] of Object.entries(detail.replacement)) {
      log.plain(`    ${pos.padEnd(3)} ${pts.toFixed(1)}`);
    }
  }

  if (detail?.baselineCount) {
    log.warn(`${detail.baselineCount} players used the fallback curve (no imported projection)`);
  }

  const board = await loadBoard(result.runId);
  log.plain(`\n  ${'#'.padStart(3)}  ${'PLAYER'.padEnd(24)} ${'POS'.padEnd(5)} ${'PTS'.padStart(6)} ${'VORP'.padStart(7)} ${'TIER'.padStart(4)} ${'ADP'.padStart(6)}`);
  log.plain(`  ${'-'.repeat(62)}`);

  for (const p of board.slice(0, top)) {
    const posLabel = `${p.position}${p.positionRank}`;
    log.plain(
      `  ${String(p.overallRank).padStart(3)}  ${p.fullName.slice(0, 24).padEnd(24)} ${posLabel.padEnd(5)} ` +
        `${p.projPoints.toFixed(0).padStart(6)} ${p.vorp.toFixed(1).padStart(7)} ${String(p.tier).padStart(4)} ` +
        `${(p.adp?.toFixed(1) ?? '—').padStart(6)}${p.isBaseline ? '  (baseline)' : ''}`,
    );
  }
});
