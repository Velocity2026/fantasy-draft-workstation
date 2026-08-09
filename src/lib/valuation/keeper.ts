import { prisma } from '../db';
import { readJson } from '../json';
import { interpolateAtRank } from './replacement';
import type { ValuationRowWithPlayer } from './engine';

/**
 * Keeper analysis.
 *
 * The only question that matters: **is this player worth more than the pick he
 * costs?** Not "is he good" — a great player at a first-round keeper price is
 * worth exactly nothing in surplus terms.
 *
 * Surplus = (his value) - (value of the player you'd otherwise draft at that
 * pick). The second term is the part people skip, and it's why keeping a WR2 at
 * a 3rd-round cost is usually better than keeping a WR1 at a 1st.
 *
 * "Value of the player you'd draft at pick N" is derived from the board itself:
 * take the VORP curve ordered by overall rank and read it at rank N. That
 * automatically accounts for how deep this year's board is at that range.
 */

export interface KeeperEvaluation {
  playerId: string;
  fullName: string;
  position: string;
  teamId: string | null;
  costRound: number | null;
  costPickNo: number | null;
  /** VORP of this player in the active valuation run. */
  playerVorp: number;
  /** VORP we'd expect from simply drafting at that pick instead. */
  pickVorp: number;
  /** playerVorp - pickVorp. Positive = keep. */
  surplus: number;
  /** Surplus expressed in draft-pick terms: "worth ~2.3 rounds of value". */
  surplusInRounds: number | null;
  verdict: 'KEEP' | 'LEAN_KEEP' | 'MARGINAL' | 'LEAN_CUT' | 'CUT';
  reasoning: string[];
  tier: number;
  overallRank: number;
  adp: number | null;
  riskScore: number | null;
}

export interface KeeperContext {
  teams: number;
  /** Full board from the active run, ordered by overallRank ascending. */
  board: ValuationRowWithPlayer[];
}

export function evaluateKeeper(
  keeper: {
    playerId: string;
    costRound: number | null;
    costPickNo: number | null;
  },
  ctx: KeeperContext,
): KeeperEvaluation | null {
  const row = ctx.board.find((b) => b.playerId === keeper.playerId);
  if (!row) return null;

  // Resolve the cost to an overall pick number. A round-only cost is treated as
  // the middle of that round, which is the fair expectation before slots are known.
  const costPickNo =
    keeper.costPickNo ??
    (keeper.costRound !== null ? (keeper.costRound - 1) * ctx.teams + Math.ceil(ctx.teams / 2) : null);

  const vorpCurve = ctx.board.map((b) => b.vorp);
  const pickVorp = costPickNo !== null ? interpolateAtRank(vorpCurve, costPickNo) : 0;
  const surplus = row.vorp - pickVorp;

  // Convert surplus back into "rounds of draft capital" so it's legible: how
  // many picks up the board does this surplus move you?
  const surplusInRounds = costPickNo !== null ? surplusToRounds(surplus, vorpCurve, costPickNo, ctx.teams) : null;

  const reasoning: string[] = [];
  if (costPickNo !== null) {
    reasoning.push(
      `Costs pick ~${costPickNo} (round ${Math.ceil(costPickNo / ctx.teams)}), where the board returns about ${pickVorp.toFixed(0)} VORP.`,
    );
  }
  reasoning.push(`He projects at ${row.projPoints.toFixed(0)} pts / ${row.vorp.toFixed(0)} VORP (${row.position}${row.positionRank}, tier ${row.tier}).`);

  if (row.adp !== null && costPickNo !== null) {
    const adpGap = costPickNo - row.adp;
    if (adpGap > ctx.teams) {
      reasoning.push(`Market drafts him around ${row.adp.toFixed(0)} — you're getting him ${adpGap.toFixed(0)} picks late.`);
    } else if (adpGap < -ctx.teams) {
      reasoning.push(`Market drafts him around ${row.adp.toFixed(0)} — the keeper price is ${Math.abs(adpGap).toFixed(0)} picks worse than just drafting him.`);
    }
  }

  if (row.riskScore !== null && row.riskScore > 0.35) {
    reasoning.push(`Elevated risk score (${(row.riskScore * 100).toFixed(0)}%) — injury status or age curve is working against him.`);
  }
  if (row.isBaseline) {
    reasoning.push('No imported projection for this player — value is from the fallback curve, so treat it as approximate.');
  }

  // Thresholds are in VORP points. One "round" of value near the top of the
  // board is worth far more than one near the bottom, so compare against the
  // local slope rather than a flat number.
  const roundValue = costPickNo !== null ? localRoundValue(vorpCurve, costPickNo, ctx.teams) : 20;
  const verdict: KeeperEvaluation['verdict'] =
    surplus > roundValue * 1.5
      ? 'KEEP'
      : surplus > roundValue * 0.4
        ? 'LEAN_KEEP'
        : surplus > -roundValue * 0.4
          ? 'MARGINAL'
          : surplus > -roundValue * 1.5
            ? 'LEAN_CUT'
            : 'CUT';

  return {
    playerId: row.playerId,
    fullName: row.fullName,
    position: row.position,
    teamId: row.teamId,
    costRound: keeper.costRound,
    costPickNo,
    playerVorp: row.vorp,
    pickVorp,
    surplus,
    surplusInRounds,
    verdict,
    reasoning,
    tier: row.tier,
    overallRank: row.overallRank,
    adp: row.adp,
    riskScore: row.riskScore,
  };
}

/** VORP difference across one round at this point in the board. */
function localRoundValue(vorpCurve: number[], atPick: number, teams: number): number {
  const here = interpolateAtRank(vorpCurve, atPick);
  const nextRound = interpolateAtRank(vorpCurve, atPick + teams);
  return Math.max(1, here - nextRound);
}

/** Express a VORP surplus as a number of draft rounds of equivalent value. */
function surplusToRounds(surplus: number, vorpCurve: number[], atPick: number, teams: number): number {
  const perRound = localRoundValue(vorpCurve, atPick, teams);
  return surplus / perRound;
}

export async function evaluateAllKeepers(args: {
  leagueId: string;
  season: string;
  board: ValuationRowWithPlayer[];
  teams: number;
}): Promise<KeeperEvaluation[]> {
  const keepers = await prisma.keeperDeclaration.findMany({
    where: { leagueId: args.leagueId, season: args.season },
    include: { player: { select: { fullName: true } }, member: { select: { displayName: true } } },
  });

  const ctx: KeeperContext = { teams: args.teams, board: args.board };
  return keepers
    .map((k) => evaluateKeeper({ playerId: k.playerId, costRound: k.costRound, costPickNo: k.costPickNo }, ctx))
    .filter((e): e is KeeperEvaluation => e !== null)
    .sort((a, b) => b.surplus - a.surplus);
}

/**
 * Which picks are actually available to draft with, once keepers have consumed
 * their cost picks. The draft room needs this or every "your next pick" number
 * is wrong in a keeper league.
 */
export async function consumedPicks(leagueId: string, season: string, teams: number): Promise<Set<number>> {
  const keepers = await prisma.keeperDeclaration.findMany({
    where: { leagueId, season },
    select: { costPickNo: true, costRound: true, rosterId: true },
  });

  const consumed = new Set<number>();
  for (const k of keepers) {
    if (k.costPickNo) {
      consumed.add(k.costPickNo);
    } else if (k.costRound && k.rosterId) {
      // Round-only cost: the pick consumed is that roster's slot in that round.
      consumed.add((k.costRound - 1) * teams + k.rosterId);
    }
  }
  return consumed;
}

/** Read a league's team count without a second query at every call site. */
export async function leagueTeamCount(leagueId: string): Promise<number> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { totalRosters: true, rosterPositionsJson: true },
  });
  void readJson<string[]>(league?.rosterPositionsJson, []);
  return league?.totalRosters ?? 10;
}
