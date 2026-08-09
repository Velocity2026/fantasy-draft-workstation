import { prisma } from '../db';
import { mean } from '../utils';

/**
 * Breakout analysis.
 *
 * Built as two independent factors that multiply, not one blended number:
 *
 *   OPPORTUNITY — will he get the volume? (snap share, target share, usage
 *                 trajectory, depth-chart position)
 *   TALENT      — can he convert it? (draft capital, athleticism, entry age)
 *
 * They multiply because a breakout needs both. A great athlete with no path to
 * snaps scores near zero, and so does a bell-cow role given to a player the
 * team has no investment in. Averaging the two would let either one hide a
 * fatal weakness in the other.
 *
 * Every claim is grounded in a stored number, and anything we cannot measure is
 * reported as a gap rather than silently treated as zero — a missing signal and
 * a bad signal are very different things when you are deciding on a pick.
 */

export interface SeasonUsage {
  season: string;
  games: number;
  ppg: number;
  totalPoints: number;
  avgSnapPct: number | null;
  avgTargetShare: number | null;
  targets: number;
  carries: number;
  firstHalfPpg: number | null;
  secondHalfPpg: number | null;
  trajectoryDelta: number | null;
}

export interface Comparable {
  playerId: string;
  name: string;
  season: string;
  careerYear: number;
  draftCapital: number | null;
  ppgThatYear: number;
  ppgNextYear: number | null;
  delta: number | null;
}

export interface BreakoutAnalysis {
  player: {
    id: string;
    name: string;
    position: string;
    team: string | null;
    age: number | null;
    yearsExp: number | null;
    searchRank: number | null;
  };
  profile: {
    draftRound: number | null;
    draftOverall: number | null;
    draftTeam: string | null;
    draftCapitalScore: number | null;
    athleticScore: number | null;
    athleticSampleSize: number;
    speedScore: number | null;
    heightIn: number | null;
    weightLb: number | null;
    college: string | null;
    entryAge: number | null;
  } | null;
  seasons: SeasonUsage[];
  factors: {
    opportunity: number | null;
    talent: number | null;
    breakoutScore: number | null;
  };
  comparables: Comparable[];
  comparableSummary: {
    count: number;
    medianDelta: number | null;
    improvedPct: number | null;
  };
  signals: string[];
  gaps: string[];
}

/** Weekly rows collapsed into one season summary. */
function summariseSeason(
  season: string,
  rows: {
    week: number;
    fantasyPointsPpr: number | null;
    snapPct: number | null;
    targetShare: number | null;
    targets: number | null;
    carries: number | null;
  }[],
): SeasonUsage {
  const played = rows.filter((r) => r.fantasyPointsPpr !== null);
  const pts = played.map((r) => r.fantasyPointsPpr as number);
  const snaps = rows.map((r) => r.snapPct).filter((v): v is number => v !== null);
  const shares = rows.map((r) => r.targetShare).filter((v): v is number => v !== null && v > 0);

  const early = played.filter((r) => r.week <= 9).map((r) => r.fantasyPointsPpr as number);
  const late = played.filter((r) => r.week >= 10).map((r) => r.fantasyPointsPpr as number);
  // Three games a side is the minimum before a "trend" is anything but noise.
  const firstHalfPpg = early.length >= 3 ? mean(early) : null;
  const secondHalfPpg = late.length >= 3 ? mean(late) : null;

  return {
    season,
    games: played.length,
    ppg: pts.length ? mean(pts) : 0,
    totalPoints: pts.reduce((a, b) => a + b, 0),
    avgSnapPct: snaps.length ? mean(snaps) : null,
    avgTargetShare: shares.length ? mean(shares) : null,
    targets: rows.reduce((s, r) => s + (r.targets ?? 0), 0),
    carries: rows.reduce((s, r) => s + (r.carries ?? 0), 0),
    firstHalfPpg,
    secondHalfPpg,
    trajectoryDelta:
      firstHalfPpg !== null && secondHalfPpg !== null ? secondHalfPpg - firstHalfPpg : null,
  };
}

/**
 * Opportunity factor, 0..1.
 *
 * Weighted toward the most recent season, and toward *direction* rather than
 * level — a player already at a 90% snap share has little room to break out;
 * one climbing from 40% to 70% is the profile we are hunting.
 */
function opportunityFactor(seasons: SeasonUsage[], position: string): { score: number | null; notes: string[] } {
  const notes: string[] = [];
  const latest = seasons[seasons.length - 1];
  if (!latest || latest.games === 0) return { score: null, notes };

  const parts: number[] = [];

  if (latest.avgSnapPct !== null) {
    // Snap share is the base rate of opportunity.
    parts.push(Math.min(1, latest.avgSnapPct / 0.75));
    notes.push(`Averaged ${(latest.avgSnapPct * 100).toFixed(0)}% of offensive snaps in ${latest.season}.`);
  }

  if (['WR', 'TE'].includes(position) && latest.avgTargetShare !== null) {
    parts.push(Math.min(1, latest.avgTargetShare / 0.22));
    notes.push(`Target share averaged ${(latest.avgTargetShare * 100).toFixed(1)}%.`);
  }

  if (position === 'RB' && latest.carries > 0) {
    parts.push(Math.min(1, latest.carries / (latest.games * 14)));
    notes.push(`${latest.carries} carries across ${latest.games} games.`);
  }

  // Second-half surge is the leading indicator — coaches signalling intent.
  if (latest.trajectoryDelta !== null) {
    const surge = Math.max(0, Math.min(1, latest.trajectoryDelta / 8));
    parts.push(surge);
    if (latest.trajectoryDelta > 2) {
      notes.push(
        `Finished stronger than he started: ${latest.firstHalfPpg?.toFixed(1)} PPG through week 9, ` +
          `${latest.secondHalfPpg?.toFixed(1)} after (+${latest.trajectoryDelta.toFixed(1)}).`,
      );
    } else if (latest.trajectoryDelta < -2) {
      notes.push(
        `Faded late: ${latest.firstHalfPpg?.toFixed(1)} PPG early, ${latest.secondHalfPpg?.toFixed(1)} after.`,
      );
    }
  }

  if (!parts.length) return { score: null, notes };
  return { score: mean(parts), notes };
}

/** Talent factor, 0..1. Draft capital dominates; athleticism is a modifier. */
function talentFactor(profile: BreakoutAnalysis['profile']): { score: number | null; notes: string[] } {
  const notes: string[] = [];
  if (!profile) return { score: null, notes };

  const capital = profile.draftCapitalScore;
  const parts: { value: number; weight: number }[] = [];

  if (capital !== null) {
    parts.push({ value: capital, weight: 0.65 });
    if (profile.draftRound === 1) {
      notes.push(`First-round pick (#${profile.draftOverall} overall, ${profile.draftTeam}) — teams give premium picks runway.`);
    } else if (profile.draftRound && profile.draftRound <= 3) {
      notes.push(`Day-two pick (round ${profile.draftRound}, #${profile.draftOverall}) — meaningful investment.`);
    } else if (profile.draftRound) {
      notes.push(`Round ${profile.draftRound} pick — limited draft capital, so the role has to be earned.`);
    } else {
      notes.push('Undrafted — no draft capital backing his opportunity.');
    }
  }

  // Only trust athleticism when it is backed by a real workout.
  if (profile.athleticScore !== null && profile.athleticSampleSize >= 3) {
    parts.push({ value: profile.athleticScore, weight: 0.2 });
    notes.push(`Athletic composite ${(profile.athleticScore * 100).toFixed(0)} from ${profile.athleticSampleSize} combine measurements.`);
  }

  if (profile.entryAge !== null) {
    // Younger entry means more development runway; 21 is elite, 24 is late.
    const youth = Math.max(0, Math.min(1, (24.5 - profile.entryAge) / 3));
    parts.push({ value: youth, weight: 0.15 });
    notes.push(`Entered the league at ${profile.entryAge.toFixed(1)}.`);
  }

  if (!parts.length) return { score: null, notes };
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  return { score: parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight, notes };
}

/**
 * Historical comparables: players at the same position and career year with
 * similar draft capital and similar usage, and what they did the following
 * season. This is the "look back at history to predict forward" step — it
 * answers "what usually happens to players who look like this" with actual
 * outcomes rather than intuition.
 */
async function findComparables(args: {
  position: string;
  careerYear: number;
  draftCapital: number | null;
  ppg: number;
  snapPct: number | null;
  excludePlayerId: string;
}): Promise<Comparable[]> {
  const profiles = await prisma.playerProfile.findMany({
    where: {
      player: { position: args.position },
      rookieSeason: { not: null },
      playerId: { not: args.excludePlayerId },
    },
    include: { player: { select: { fullName: true, position: true } } },
  });

  const candidates: Comparable[] = [];

  for (const prof of profiles) {
    if (prof.rookieSeason === null) continue;
    const targetSeason = prof.rookieSeason + (args.careerYear - 1);
    const nextSeason = targetSeason + 1;

    // Draft capital similarity is the primary filter.
    if (args.draftCapital !== null && prof.draftCapitalScore !== null) {
      if (Math.abs(prof.draftCapitalScore - args.draftCapital) > 0.18) continue;
    }

    const [thisYear, next] = await Promise.all([
      prisma.playerWeekStat.findMany({
        where: { playerId: prof.playerId, season: String(targetSeason), seasonType: 'REG' },
        select: { fantasyPointsPpr: true },
      }),
      prisma.playerWeekStat.findMany({
        where: { playerId: prof.playerId, season: String(nextSeason), seasonType: 'REG' },
        select: { fantasyPointsPpr: true },
      }),
    ]);

    const thisPts = thisYear.map((r) => r.fantasyPointsPpr).filter((v): v is number => v !== null);
    if (thisPts.length < 6) continue; // need a real season to compare against

    const ppgThatYear = mean(thisPts);
    // Usage similarity: within 4 PPG of our subject.
    if (Math.abs(ppgThatYear - args.ppg) > 4) continue;

    const nextPts = next.map((r) => r.fantasyPointsPpr).filter((v): v is number => v !== null);
    const ppgNextYear = nextPts.length >= 6 ? mean(nextPts) : null;

    candidates.push({
      playerId: prof.playerId,
      name: prof.player.fullName,
      season: String(targetSeason),
      careerYear: args.careerYear,
      draftCapital: prof.draftCapitalScore,
      ppgThatYear,
      ppgNextYear,
      delta: ppgNextYear !== null ? ppgNextYear - ppgThatYear : null,
    });
  }

  return candidates.sort((a, b) => (b.delta ?? -99) - (a.delta ?? -99));
}

export async function analysePlayer(playerId: string): Promise<BreakoutAnalysis | null> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      fullName: true,
      position: true,
      teamId: true,
      age: true,
      yearsExp: true,
      searchRank: true,
    },
  });
  if (!player) return null;

  const profileRow = await prisma.playerProfile.findUnique({ where: { playerId } });
  const profile: BreakoutAnalysis['profile'] = profileRow
    ? {
        draftRound: profileRow.draftRound,
        draftOverall: profileRow.draftOverall,
        draftTeam: profileRow.draftTeam,
        draftCapitalScore: profileRow.draftCapitalScore,
        athleticScore: profileRow.athleticScore,
        athleticSampleSize: profileRow.athleticSampleSize,
        speedScore: profileRow.speedScore,
        heightIn: profileRow.heightIn,
        weightLb: profileRow.weightLb,
        college: profileRow.collegeName,
        entryAge: profileRow.entryAge,
      }
    : null;

  const weekly = await prisma.playerWeekStat.findMany({
    where: { playerId, seasonType: 'REG' },
    orderBy: [{ season: 'asc' }, { week: 'asc' }],
    select: {
      season: true,
      week: true,
      fantasyPointsPpr: true,
      snapPct: true,
      targetShare: true,
      targets: true,
      carries: true,
      routeParticipation: true,
    },
  });

  const bySeason = new Map<string, typeof weekly>();
  for (const row of weekly) {
    const list = bySeason.get(row.season) ?? [];
    list.push(row);
    bySeason.set(row.season, list);
  }
  const seasons = [...bySeason.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([season, rows]) => summariseSeason(season, rows));

  const opportunity = opportunityFactor(seasons, player.position);
  const talent = talentFactor(profile);

  const breakoutScore =
    opportunity.score !== null && talent.score !== null
      ? Math.sqrt(opportunity.score * talent.score) // geometric mean — both must hold
      : null;

  const latest = seasons[seasons.length - 1];
  const careerYear = seasons.length;

  const comparables = latest
    ? await findComparables({
        position: player.position,
        careerYear,
        draftCapital: profile?.draftCapitalScore ?? null,
        ppg: latest.ppg,
        snapPct: latest.avgSnapPct,
        excludePlayerId: playerId,
      })
    : [];

  const withNext = comparables.filter((c) => c.delta !== null);
  const deltas = withNext.map((c) => c.delta as number).sort((a, b) => a - b);
  const medianDelta = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  const improvedPct = withNext.length
    ? withNext.filter((c) => (c.delta as number) > 0).length / withNext.length
    : null;

  // --- Honest accounting of what we could not measure --------------------
  const gaps: string[] = [];
  if (!profile) gaps.push('No athletic/draft profile matched for this player.');
  else if (profile.athleticSampleSize < 3) {
    gaps.push('No usable combine workout — athleticism is excluded from the talent score rather than assumed average.');
  }
  if (!weekly.length) gaps.push('No weekly usage data on record, so the opportunity factor cannot be computed.');
  if (weekly.length && weekly.every((w) => w.routeParticipation === null)) {
    gaps.push('Route participation and first-read share are unavailable — the two strongest receiving signals are missing.');
  }
  if (comparables.length < 5) {
    gaps.push(`Only ${comparables.length} historical comparables matched; treat the comparison as directional at best.`);
  }

  return {
    player: {
      id: player.id,
      name: player.fullName,
      position: player.position,
      team: player.teamId,
      age: player.age,
      yearsExp: player.yearsExp,
      searchRank: player.searchRank,
    },
    profile,
    seasons,
    factors: { opportunity: opportunity.score, talent: talent.score, breakoutScore },
    comparables: comparables.slice(0, 12),
    comparableSummary: { count: withNext.length, medianDelta, improvedPct },
    signals: [...talent.notes, ...opportunity.notes],
    gaps,
  };
}

/** Resolve a player by fuzzy name so the CLI can take "Tyler Warren". */
export async function findPlayerByName(query: string) {
  const q = query.trim().toLowerCase();
  const matches = await prisma.player.findMany({
    where: { fullName: { contains: query.trim() } },
    select: { id: true, fullName: true, position: true, teamId: true, searchRank: true },
    take: 20,
  });
  const exact = matches.find((m) => m.fullName.toLowerCase() === q);
  if (exact) return exact;
  // Prefer the most fantasy-relevant match.
  return (
    matches.sort((a, b) => (a.searchRank ?? 99999) - (b.searchRank ?? 99999))[0] ?? null
  );
}
