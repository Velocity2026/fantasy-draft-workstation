import { args, log, main } from './_cli';
import { analysePlayer, findPlayerByName } from '../src/lib/analysis/breakout';

/**
 * Breakout analysis for one player.
 *
 *   npx tsx scripts/analyze-player.ts --player "Tyler Warren"
 */
main(async () => {
  const a = args();
  const name = typeof a.player === 'string' ? a.player : null;
  if (!name) throw new Error('Usage: --player "Player Name"');

  const found = await findPlayerByName(name);
  if (!found) throw new Error(`No player matching "${name}".`);

  const r = await analysePlayer(found.id);
  if (!r) throw new Error('Analysis failed.');

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}`);

  log.title(`${r.player.name} — ${r.player.position}${r.player.team ? ` · ${r.player.team}` : ''}`);
  log.plain(
    `  age ${r.player.age ?? '—'} · exp ${r.player.yearsExp ?? '—'} · Sleeper relevance rank ${r.player.searchRank ?? '—'}`,
  );

  // --- Profile ------------------------------------------------------------
  if (r.profile) {
    log.plain('\n  PROFILE');
    log.plain(
      `    draft         ${r.profile.draftRound ? `R${r.profile.draftRound} #${r.profile.draftOverall} (${r.profile.draftTeam})` : 'undrafted'}` +
        `   capital ${pct(r.profile.draftCapitalScore)}`,
    );
    log.plain(
      `    measurables   ${r.profile.heightIn ?? '—'}in / ${r.profile.weightLb ?? '—'}lb` +
        `   athletic ${pct(r.profile.athleticScore)} (${r.profile.athleticSampleSize} tests)`,
    );
    log.plain(`    background    ${r.profile.college ?? '—'}   entered at ${r.profile.entryAge ?? '—'}`);
  }

  // --- Season usage -------------------------------------------------------
  if (r.seasons.length) {
    log.plain('\n  USAGE BY SEASON');
    log.plain(
      `    ${'SEAS'.padEnd(6)}${'G'.padStart(3)}${'PPG'.padStart(7)}${'SNAP%'.padStart(7)}${'TGT%'.padStart(7)}${'TGT'.padStart(5)}${'CAR'.padStart(5)}${'1st'.padStart(7)}${'2nd'.padStart(7)}${'TREND'.padStart(8)}`,
    );
    log.plain(`    ${'-'.repeat(62)}`);
    for (const s of r.seasons) {
      log.plain(
        `    ${s.season.padEnd(6)}${String(s.games).padStart(3)}${s.ppg.toFixed(1).padStart(7)}` +
          `${(s.avgSnapPct !== null ? (s.avgSnapPct * 100).toFixed(0) : '—').padStart(7)}` +
          `${(s.avgTargetShare !== null ? (s.avgTargetShare * 100).toFixed(1) : '—').padStart(7)}` +
          `${String(s.targets).padStart(5)}${String(s.carries).padStart(5)}` +
          `${(s.firstHalfPpg?.toFixed(1) ?? '—').padStart(7)}${(s.secondHalfPpg?.toFixed(1) ?? '—').padStart(7)}` +
          `${(s.trajectoryDelta !== null ? (s.trajectoryDelta > 0 ? '+' : '') + s.trajectoryDelta.toFixed(1) : '—').padStart(8)}`,
      );
    }
  } else {
    log.warn('No weekly usage data on record for this player.');
  }

  // --- Score --------------------------------------------------------------
  log.plain('\n  BREAKOUT FACTORS');
  log.plain(`    opportunity   ${pct(r.factors.opportunity).padStart(4)}   will he get the volume`);
  log.plain(`    talent        ${pct(r.factors.talent).padStart(4)}   can he convert it`);
  log.plain(`    ---------------------`);
  log.plain(`    BREAKOUT      ${pct(r.factors.breakoutScore).padStart(4)}   geometric mean (both must hold)`);

  // --- Signals ------------------------------------------------------------
  if (r.signals.length) {
    log.plain('\n  SIGNALS');
    for (const s of r.signals) log.plain(`    · ${s}`);
  }

  // --- Comparables --------------------------------------------------------
  if (r.comparables.length) {
    log.plain(`\n  HISTORICAL COMPARABLES (same position, career year, similar draft capital and production)`);
    log.plain(
      `    ${'PLAYER'.padEnd(24)}${'SEAS'.padStart(6)}${'PPG'.padStart(7)}${'NEXT'.padStart(7)}${'DELTA'.padStart(8)}`,
    );
    log.plain(`    ${'-'.repeat(52)}`);
    for (const c of r.comparables) {
      log.plain(
        `    ${c.name.slice(0, 23).padEnd(24)}${c.season.padStart(6)}${c.ppgThatYear.toFixed(1).padStart(7)}` +
          `${(c.ppgNextYear?.toFixed(1) ?? '—').padStart(7)}` +
          `${(c.delta !== null ? (c.delta > 0 ? '+' : '') + c.delta.toFixed(1) : '—').padStart(8)}`,
      );
    }
    if (r.comparableSummary.count) {
      log.plain(
        `\n    Of ${r.comparableSummary.count} comparables with a following season, ` +
          `${((r.comparableSummary.improvedPct ?? 0) * 100).toFixed(0)}% improved; ` +
          `median change ${r.comparableSummary.medianDelta !== null ? (r.comparableSummary.medianDelta > 0 ? '+' : '') + r.comparableSummary.medianDelta.toFixed(1) : '—'} PPG.`,
      );
    }
  }

  // --- Gaps ---------------------------------------------------------------
  if (r.gaps.length) {
    log.plain('');
    log.warn('DATA GAPS — read the above with these in mind:');
    for (const g of r.gaps) log.plain(`    · ${g}`);
  }
});
