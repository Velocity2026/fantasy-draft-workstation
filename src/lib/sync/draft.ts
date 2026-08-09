import { prisma } from '../db';
import { sleeper, normalisePosition, type SleeperDraft, type SleeperDraftPick } from '../providers/sleeper';
import { writeJson } from '../json';
import { normaliseName } from '../utils';
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

  // Historical drafts reference players Sleeper has since dropped from its
  // active dictionary (retirees, camp bodies). Their ids would fail the Player
  // foreign key. Reconstruct a minimal Player row from the pick's own metadata
  // instead of discarding the pick — losing old picks would quietly corrupt
  // both the derived ADP and the manager tendency profiles.
  await ensurePlayersExist(picks);

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
 * Create stub Player rows for any drafted player we don't already know about.
 *
 * Sleeper's draft-pick metadata carries first/last name, position and team, so
 * a usable record can be rebuilt without another API call. These stubs are
 * marked inactive: they should appear in draft history and count toward ADP,
 * but never surface as draftable on this year's board.
 */
async function ensurePlayersExist(picks: SleeperDraftPick[]) {
  const referenced = [...new Set(picks.map((p) => p.player_id).filter((id): id is string => !!id))];
  if (!referenced.length) return;

  const known = new Set(
    (await prisma.player.findMany({ where: { id: { in: referenced } }, select: { id: true } })).map(
      (p) => p.id,
    ),
  );
  const missing = referenced.filter((id) => !known.has(id));
  if (!missing.length) return;

  const validTeams = new Set(
    (await prisma.nflTeam.findMany({ select: { id: true } })).map((t) => t.id),
  );
  const metaByPlayer = new Map<string, Record<string, string>>();
  for (const p of picks) {
    if (p.player_id && p.metadata) metaByPlayer.set(p.player_id, p.metadata);
  }

  for (const playerId of missing) {
    const meta = metaByPlayer.get(playerId) ?? {};
    const first = meta.first_name ?? '';
    const last = meta.last_name ?? '';
    const fullName = [first, last].filter(Boolean).join(' ') || `Unknown player ${playerId}`;
    const position = normalisePosition(meta.position ?? null, null) ?? 'UNK';
    const team = meta.team && validTeams.has(meta.team) ? meta.team : null;

    await prisma.player.upsert({
      where: { id: playerId },
      create: {
        id: playerId,
        fullName,
        firstName: first || null,
        lastName: last || null,
        searchName: normaliseName(fullName),
        position,
        teamId: team,
        // Not on a current roster as far as we know — keep off this year's board.
        active: false,
        status: 'Historical',
      },
      update: {},
    });
  }
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
