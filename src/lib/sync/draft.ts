import { prisma } from '../db';
import { sleeper, type SleeperDraft } from '../providers/sleeper';
import { writeJson } from '../json';
import { withSyncRun, type SyncResult } from './runner';

/**
 * Draft import and live pick synchronisation.
 *
 * `syncDraftPicks` is called both by the historical import and by the live
 * polling loop every couple of seconds, so it is written to be cheap and
 * idempotent: it only writes picks whose player has actually changed.
 */

export async function syncDrafts(leagueId: string): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'drafts' }, async () => {
    const drafts = await sleeper.getDrafts(leagueId);
    for (const d of drafts) await upsertDraft(d);
    return { recordsIn: drafts.length, recordsWritten: drafts.length };
  });
}

export async function upsertDraft(d: SleeperDraft, markPrimary = false) {
  const data = {
    leagueId: d.league_id,
    season: d.season,
    type: d.type,
    status: d.status,
    rounds: d.settings?.rounds ?? 0,
    teams: d.settings?.teams ?? 0,
    pickTimerSec: d.settings?.pick_timer ?? null,
    startTimeMs: d.start_time ? BigInt(d.start_time) : null,
    slotToRosterJson: writeJson(d.slot_to_roster_id ?? {}),
    settingsJson: writeJson(d.settings ?? {}),
    metadataJson: writeJson(d.metadata ?? {}),
    syncedAt: new Date(),
  };

  if (markPrimary) {
    await prisma.draft.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
  }

  return prisma.draft.upsert({
    where: { id: d.draft_id },
    create: { id: d.draft_id, ...data, isPrimary: markPrimary },
    update: { ...data, ...(markPrimary ? { isPrimary: true } : {}) },
  });
}

export interface DraftSyncResult extends SyncResult {
  /** Picks that are new or changed since the last poll — what the UI animates. */
  newPickNos: number[];
  totalPicks: number;
  status: string;
}

/**
 * Pull picks for a draft and write only what changed.
 *
 * Manual picks entered in the draft room are preserved: if Sleeper has no
 * player for a pick number but we do and it was entered by hand, we leave ours
 * alone. That makes the room usable when Sleeper lags or when a pick is
 * announced verbally before it is entered.
 */
export async function syncDraftPicks(draftId: string): Promise<DraftSyncResult> {
  const [draft, picks] = await Promise.all([sleeper.getDraft(draftId), sleeper.getDraftPicks(draftId)]);
  await upsertDraft(draft);

  const existing = await prisma.draftPick.findMany({
    where: { draftId },
    select: { pickNo: true, playerId: true, isManual: true },
  });
  const existingByPick = new Map(existing.map((p) => [p.pickNo, p]));

  const members = await prisma.leagueMember.findMany({ where: { leagueId: draft.league_id } });
  const memberByUserId = new Map(members.map((m) => [m.sleeperUserId, m.id]));

  const newPickNos: number[] = [];
  let written = 0;

  for (const p of picks) {
    const prior = existingByPick.get(p.pick_no);
    const playerId = p.player_id ?? null;

    if (prior?.playerId === playerId) continue; // unchanged — the common case
    if (!playerId && prior?.isManual) continue; // don't clobber a manual entry

    const data = {
      draftId,
      pickNo: p.pick_no,
      round: p.round,
      draftSlot: p.draft_slot,
      rosterId: p.roster_id,
      memberId: p.picked_by ? (memberByUserId.get(p.picked_by) ?? null) : null,
      playerId,
      isKeeper: p.is_keeper ?? false,
      isManual: false,
      metadataJson: writeJson(p.metadata ?? {}),
      capturedAt: new Date(),
    };

    await prisma.draftPick.upsert({
      where: { draftId_pickNo: { draftId, pickNo: p.pick_no } },
      create: data,
      update: data,
    });

    if (playerId) newPickNos.push(p.pick_no);
    written += 1;
  }

  return {
    recordsIn: picks.length,
    recordsWritten: written,
    newPickNos,
    totalPicks: picks.filter((p) => p.player_id).length,
    status: draft.status,
  };
}

/**
 * Record a pick by hand. Used for offline/live-room drafts and to correct a
 * mis-synced pick. Marked `isManual` so the Sleeper poller won't overwrite it.
 */
export async function recordManualPick(args: {
  draftId: string;
  pickNo: number;
  playerId: string | null;
  rosterId?: number | null;
}) {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: args.draftId } });
  const teams = draft.teams || 10;
  const round = Math.floor((args.pickNo - 1) / teams) + 1;
  const slotInRound = ((args.pickNo - 1) % teams) + 1;
  // Snake: even rounds run right-to-left.
  const draftSlot = draft.type === 'snake' && round % 2 === 0 ? teams - slotInRound + 1 : slotInRound;

  const data = {
    draftId: args.draftId,
    pickNo: args.pickNo,
    round,
    draftSlot,
    rosterId: args.rosterId ?? null,
    playerId: args.playerId,
    isManual: true,
    capturedAt: new Date(),
  };

  return prisma.draftPick.upsert({
    where: { draftId_pickNo: { draftId: args.draftId, pickNo: args.pickNo } },
    create: data,
    update: data,
  });
}

export async function undoPick(draftId: string, pickNo: number) {
  return prisma.draftPick.updateMany({
    where: { draftId, pickNo },
    data: { playerId: null, isManual: true },
  });
}
