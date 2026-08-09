import { args, log, main } from './_cli';
import { backfillWeekly } from '../src/lib/sync/weekly';
import { prisma } from '../src/lib/db';

/**
 * Backfill weekly stats and snap counts from nflverse.
 *
 *   npm run backfill            # 2018-2025
 *   npx tsx scripts/backfill-weekly.ts --from 2020 --to 2025
 */
main(async () => {
  const a = args();
  const from = typeof a.from === 'string' ? Number(a.from) : 2018;
  const to = typeof a.to === 'string' ? Number(a.to) : 2025;

  log.title(`Backfilling weekly stats ${from}–${to}`);
  log.plain('  Each season is ~19k player-weeks plus ~27k snap rows. This takes a while.\n');

  const results = await backfillWeekly(from, to);

  for (const r of results) {
    if (r.error) log.fail(`${r.season}: ${r.error}`);
    else log.ok(`${r.season}: ${r.written} player-weeks${r.unresolved ? ` (${r.unresolved} unresolved)` : ''}`);
  }

  const total = await prisma.playerWeekStat.count();
  const withSnaps = await prisma.playerWeekStat.count({ where: { snapPct: { not: null } } });
  log.plain(`\n  PlayerWeekStat now holds ${total.toLocaleString()} rows (${withSnaps.toLocaleString()} with snap share).`);

  // Prove the point of the exercise: trajectory is now computable.
  const rows = await prisma.playerWeekStat.findMany({
    where: { season: String(to), seasonType: 'REG', fantasyPointsPpr: { not: null } },
    select: { playerId: true, week: true, fantasyPointsPpr: true },
  });

  const byPlayer = new Map<string, { week: number; pts: number }[]>();
  for (const r of rows) {
    const list = byPlayer.get(r.playerId) ?? [];
    list.push({ week: r.week, pts: r.fantasyPointsPpr as number });
    byPlayer.set(r.playerId, list);
  }

  const risers: { playerId: string; first: number; second: number; delta: number }[] = [];
  for (const [playerId, weeks] of byPlayer) {
    const early = weeks.filter((w) => w.week <= 9);
    const late = weeks.filter((w) => w.week >= 10);
    // Need a real sample in both halves or the "trend" is noise.
    if (early.length < 4 || late.length < 4) continue;
    const first = early.reduce((s, w) => s + w.pts, 0) / early.length;
    const second = late.reduce((s, w) => s + w.pts, 0) / late.length;
    if (second < 8) continue; // ignore players who finished irrelevant anyway
    risers.push({ playerId, first, second, delta: second - first });
  }

  risers.sort((a, b) => b.delta - a.delta);
  const top = risers.slice(0, 12);
  const names = new Map(
    (
      await prisma.player.findMany({
        where: { id: { in: top.map((t) => t.playerId) } },
        select: { id: true, fullName: true, position: true },
      })
    ).map((p) => [p.id, p]),
  );

  if (top.length) {
    log.plain(`\n  ${to} second-half risers (PPG weeks 1-9 vs 10+) — the trajectory signal:`);
    log.plain(`  ${'PLAYER'.padEnd(24)} ${'POS'.padEnd(4)} ${'1st'.padStart(6)} ${'2nd'.padStart(6)} ${'DELTA'.padStart(7)}`);
    log.plain(`  ${'-'.repeat(52)}`);
    for (const r of top) {
      const p = names.get(r.playerId);
      log.plain(
        `  ${(p?.fullName ?? r.playerId).slice(0, 24).padEnd(24)} ${(p?.position ?? '?').padEnd(4)} ` +
          `${r.first.toFixed(1).padStart(6)} ${r.second.toFixed(1).padStart(6)} ${('+' + r.delta.toFixed(1)).padStart(7)}`,
      );
    }
  }
});
