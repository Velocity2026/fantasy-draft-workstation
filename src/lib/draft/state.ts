import { prisma } from '../db';
import { getConfig, deriveRosterShape, type RosterShape } from '../config';
import { readJson } from '../json';
import { getActiveRun, loadBoard, type ValuationRowWithPlayer } from '../valuation/engine';
import { consumedPicks } from '../valuation/keeper';
import {
  buildRosterState,
  buildSuggestions,
  detectRuns,
  myPickNumbers,
  type PositionRunAlert,
  type RosterState,
  type Suggestion,
} from './advisor';
import type { DraftStrategy } from '../enums';
import { pickLabel } from '../utils';

/**
 * Assembles everything the draft room renders, in one query pass.
 *
 * The live room re-reads this on every poll tick, so it is written as a small
 * number of bulk queries rather than per-player lookups. On a 10-team, 15-round
 * draft this is a handful of queries against a few thousand rows — fast enough
 * to run every two seconds without any caching layer.
 */

export interface DraftRoomState {
  draft: {
    id: string;
    leagueId: string;
    season: string;
    status: string;
    type: string;
    teams: number;
    rounds: number;
    isPrimary: boolean;
  };
  league: { id: string; name: string; scoringType: string | null; isKeeper: boolean };
  shape: RosterShape;
  /** Overall pick number currently on the clock. */
  currentPickNo: number;
  currentRound: number;
  currentPickLabel: string;
  onTheClock: { rosterId: number | null; memberName: string | null; isMe: boolean } | null;
  myDraftSlot: number | null;
  myRosterId: number | null;
  myUpcomingPicks: number[];
  picksUntilMyTurn: number | null;
  picks: DraftPickView[];
  recentPicks: DraftPickView[];
  board: ValuationRowWithPlayer[];
  draftedIds: string[];
  suggestions: Suggestion[];
  runAlerts: PositionRunAlert[];
  myRoster: RosterState;
  rosters: RosterSummary[];
  valuationRunId: string | null;
  strategy: DraftStrategy;
  /** Set when there is no valuation run yet — the UI shows a call to action. */
  warning: string | null;
}

export interface DraftPickView {
  pickNo: number;
  round: number;
  draftSlot: number;
  rosterId: number | null;
  memberName: string | null;
  playerId: string | null;
  playerName: string | null;
  position: string | null;
  teamId: string | null;
  isKeeper: boolean;
  isManual: boolean;
  /** Where our board had him — the "reach or value" read on someone else's pick. */
  ourRank: number | null;
  adp: number | null;
}

export interface RosterSummary {
  rosterId: number;
  memberName: string;
  isMe: boolean;
  counts: Record<string, number>;
  players: { playerId: string; name: string; position: string; pickNo: number }[];
  needs: string[];
}

export async function loadDraftRoomState(draftId: string): Promise<DraftRoomState> {
  const cfg = await getConfig();

  const draft = await prisma.draft.findUniqueOrThrow({
    where: { id: draftId },
    include: { league: true },
  });

  const teams = draft.teams || draft.league.totalRosters || 10;
  const rosterPositions = readJson<string[]>(draft.league.rosterPositionsJson, []);
  const shape = deriveRosterShape(rosterPositions, teams);
  const rounds = draft.rounds || shape.rounds || 15;

  const [picks, members, rosters, activeRun] = await Promise.all([
    prisma.draftPick.findMany({
      where: { draftId },
      orderBy: { pickNo: 'asc' },
      include: {
        player: { select: { fullName: true, position: true, teamId: true } },
        member: { select: { displayName: true, isMe: true } },
      },
    }),
    prisma.leagueMember.findMany({ where: { leagueId: draft.leagueId } }),
    prisma.leagueRoster.findMany({ where: { leagueId: draft.leagueId } }),
    getActiveRun(draft.leagueId, draft.season, 'DRAFT'),
  ]);

  const board = activeRun ? await loadBoard(activeRun.id) : [];
  const boardByPlayer = new Map(board.map((b) => [b.playerId, b]));

  // --- Who is who --------------------------------------------------------
  const slotToRoster = readJson<Record<string, number>>(draft.slotToRosterJson, {});
  const rosterToSlot = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(slotToRoster)) rosterToSlot.set(rosterId, Number(slot));

  const memberById = new Map(members.map((m) => [m.id, m]));
  const meMember = members.find((m) => m.isMe) ?? null;
  const myRoster = rosters.find((r) => r.memberId && r.memberId === meMember?.id) ?? null;
  const myRosterId = myRoster?.rosterId ?? null;
  const myDraftSlot =
    cfg.myDraftSlot ?? (myRosterId !== null ? (rosterToSlot.get(myRosterId) ?? null) : null);

  const rosterIdToMemberName = new Map<number, string>();
  for (const r of rosters) {
    const m = r.memberId ? memberById.get(r.memberId) : null;
    rosterIdToMemberName.set(r.rosterId, m?.displayName ?? `Roster ${r.rosterId}`);
  }

  // --- Picks -------------------------------------------------------------
  const pickViews: DraftPickView[] = picks.map((p) => {
    const boardRow = p.playerId ? boardByPlayer.get(p.playerId) : undefined;
    return {
      pickNo: p.pickNo,
      round: p.round,
      draftSlot: p.draftSlot,
      rosterId: p.rosterId,
      memberName:
        (p.memberId ? memberById.get(p.memberId)?.displayName : null) ??
        (p.rosterId !== null ? (rosterIdToMemberName.get(p.rosterId) ?? null) : null),
      playerId: p.playerId,
      playerName: p.player?.fullName ?? null,
      position: p.player?.position ?? null,
      teamId: p.player?.teamId ?? null,
      isKeeper: p.isKeeper,
      isManual: p.isManual,
      ourRank: boardRow?.overallRank ?? null,
      adp: boardRow?.adp ?? null,
    };
  });

  const made = pickViews.filter((p) => p.playerId);
  const draftedIds = made.map((p) => p.playerId!).filter(Boolean);
  const draftedSet = new Set(draftedIds);

  // Next unmade pick is the clock. Falls back to "one past the last made pick"
  // when Sleeper hasn't materialised future pick rows yet.
  const firstOpen = pickViews.find((p) => !p.playerId);
  const currentPickNo = firstOpen?.pickNo ?? made.length + 1;
  const currentRound = Math.floor((currentPickNo - 1) / teams) + 1;

  const keeperConsumed = draft.league.isKeeper
    ? await consumedPicks(draft.leagueId, draft.season, teams)
    : new Set<number>();

  const myUpcomingPicks =
    myDraftSlot !== null
      ? myPickNumbers({ draftSlot: myDraftSlot, teams, rounds, consumedByKeepers: keeperConsumed }).filter(
          (p) => p >= currentPickNo,
        )
      : [];

  const nextMine = myUpcomingPicks[0] ?? null;
  const picksUntilMyTurn = nextMine !== null ? nextMine - currentPickNo : null;

  // --- My roster + suggestions -------------------------------------------
  const myPicks = made.filter((p) => p.rosterId !== null && p.rosterId === myRosterId);
  const myRosterState = buildRosterState(
    myPicks.map((p) => ({ playerId: p.playerId, position: p.position })),
    myRosterId,
  );

  const overrideRows = await prisma.boardEntry.findMany({
    where: { leagueId: draft.leagueId, season: draft.season },
    select: { playerId: true, userRank: true, status: true, isDoNotDraft: true },
  });
  const overrides = new Map(
    overrideRows.map((o) => [o.playerId, { userRank: o.userRank, status: o.status, isDoNotDraft: o.isDoNotDraft }]),
  );

  const strategy = (readJson<{ strategy?: DraftStrategy }>(
    (await prisma.appSetting.findUnique({ where: { key: 'draft.strategy' } }))?.valueJson,
    {},
  ).strategy ?? 'BALANCED') as DraftStrategy;

  const suggestions = board.length
    ? buildSuggestions({
        board,
        drafted: draftedSet,
        shape,
        myRosterState,
        myUpcomingPicks,
        currentPickNo,
        strategy,
        needWeight: cfg.needWeight,
        overrides,
        boardOverrideWeight: cfg.boardOverrideWeight,
      })
    : [];

  const runAlerts = board.length
    ? detectRuns({
        recentPicks: made.slice(-10).map((p) => ({ position: p.position ?? '' })),
        available: board.filter((b) => !draftedSet.has(b.playerId)),
      })
    : [];

  // --- All rosters --------------------------------------------------------
  const rosterSummaries: RosterSummary[] = rosters
    .map((r) => {
      const theirPicks = made.filter((p) => p.rosterId === r.rosterId);
      const counts: Record<string, number> = {};
      for (const p of theirPicks) if (p.position) counts[p.position] = (counts[p.position] ?? 0) + 1;
      const member = r.memberId ? memberById.get(r.memberId) : null;
      return {
        rosterId: r.rosterId,
        memberName: member?.displayName ?? `Roster ${r.rosterId}`,
        isMe: r.rosterId === myRosterId,
        counts,
        players: theirPicks.map((p) => ({
          playerId: p.playerId!,
          name: p.playerName ?? p.playerId!,
          position: p.position ?? '?',
          pickNo: p.pickNo,
        })),
        needs: unmetStarters(counts, shape),
      };
    })
    .sort((a, b) => a.rosterId - b.rosterId);

  // --- On the clock -------------------------------------------------------
  const clockPick = firstOpen ?? null;
  const clockRosterId =
    clockPick?.rosterId ?? (clockPick ? (slotToRoster[String(clockPick.draftSlot)] ?? null) : null);

  return {
    draft: {
      id: draft.id,
      leagueId: draft.leagueId,
      season: draft.season,
      status: draft.status,
      type: draft.type,
      teams,
      rounds,
      isPrimary: draft.isPrimary,
    },
    league: {
      id: draft.league.id,
      name: draft.league.name,
      scoringType: draft.league.scoringType,
      isKeeper: draft.league.isKeeper,
    },
    shape,
    currentPickNo,
    currentRound,
    currentPickLabel: pickLabel(currentPickNo, teams),
    onTheClock: clockPick
      ? {
          rosterId: clockRosterId,
          memberName: clockRosterId !== null ? (rosterIdToMemberName.get(clockRosterId) ?? null) : null,
          isMe: clockRosterId !== null && clockRosterId === myRosterId,
        }
      : null,
    myDraftSlot,
    myRosterId,
    myUpcomingPicks,
    picksUntilMyTurn,
    picks: pickViews,
    recentPicks: made.slice(-12).reverse(),
    board,
    draftedIds,
    suggestions,
    runAlerts,
    myRoster: myRosterState,
    rosters: rosterSummaries,
    valuationRunId: activeRun?.id ?? null,
    strategy,
    warning: board.length
      ? null
      : 'No valuation run found for this league and season. Run one from the Board page before drafting.',
  };
}

function unmetStarters(counts: Record<string, number>, shape: RosterShape): string[] {
  const out: string[] = [];
  for (const [pos, required] of Object.entries(shape.starters)) {
    if (required === 0) continue;
    const have = counts[pos] ?? 0;
    if (have < required) out.push(`${pos} x${required - have}`);
  }
  const flexCapable = ['RB', 'WR', 'TE'].reduce(
    (sum, p) => sum + Math.max(0, (counts[p] ?? 0) - (shape.starters[p] ?? 0)),
    0,
  );
  if (flexCapable < shape.flex) out.push(`FLEX x${shape.flex - flexCapable}`);
  return out;
}
