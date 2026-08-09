'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getConfig, setConfig } from '@/lib/config';
import { writeJson, readJson } from '@/lib/json';
import { runValuation } from '@/lib/valuation/engine';
import { syncPlayers } from '@/lib/sync/players';
import { syncLeague } from '@/lib/sync/league';
import { syncDrafts, recordManualPick, undoPick, syncDraftPicks } from '@/lib/sync/draft';
import { syncHistory, computeManagerProfiles, importKeepersFromDraft } from '@/lib/sync/history';
import { deriveLeagueAdp, syncTrending } from '@/lib/sync/market';
import { importAdpCsv, importProjectionsCsv, importRankingsCsv } from '@/lib/sync/import';
import { upsertSource, deleteSource, setSourceEnabled, seedSources } from '@/lib/sources';
import { zBoardStatus, type ScoringFormat, type DraftStrategy } from '@/lib/enums';

/**
 * Server actions — every mutation in the app.
 *
 * These return a plain `{ ok, message }` rather than throwing, because most are
 * called from forms where a thrown error produces a blank error page. During a
 * live draft an inline red message is far more useful than losing the screen.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  leagueId: z.string().trim().min(1).nullable().optional(),
  sleeperUsername: z.string().trim().nullable().optional(),
  season: z.string().trim().optional(),
  myDraftSlot: z.coerce.number().int().min(1).max(20).nullable().optional(),
  draftPollMs: z.coerce.number().int().min(1000).max(30000).optional(),
  needWeight: z.coerce.number().min(0).max(1).optional(),
  boardOverrideWeight: z.coerce.number().min(0).max(1).optional(),
  riskAversion: z.coerce.number().min(0).max(1).optional(),
  replacementMethod: z.enum(['STARTER_COUNT', 'BLENDED', 'LAST_STARTER']).optional(),
});

export async function saveSettings(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const raw = Object.fromEntries(formData.entries());
    const parsed = settingsSchema.parse({
      ...raw,
      myDraftSlot: raw.myDraftSlot === '' ? null : raw.myDraftSlot,
      leagueId: raw.leagueId === '' ? null : raw.leagueId,
    });

    await setConfig(parsed);
    revalidatePath('/settings');
    revalidatePath('/');
    return { ok: true, message: 'Settings saved.' };
  });
}

export async function setMyTeam(memberId: string): Promise<ActionResult> {
  return guard(async () => {
    const member = await prisma.leagueMember.findUniqueOrThrow({ where: { id: memberId } });
    await prisma.leagueMember.updateMany({ where: { leagueId: member.leagueId }, data: { isMe: false } });
    await prisma.leagueMember.update({ where: { id: memberId }, data: { isMe: true } });
    revalidatePath('/settings');
    revalidatePath('/draft');
    return { ok: true, message: `You are now set as ${member.displayName}.` };
  });
}

export async function setStrategy(strategy: DraftStrategy): Promise<ActionResult> {
  return guard(async () => {
    await prisma.appSetting.upsert({
      where: { key: 'draft.strategy' },
      create: { key: 'draft.strategy', valueJson: writeJson({ strategy }) ?? '{}' },
      update: { valueJson: writeJson({ strategy }) ?? '{}' },
    });
    revalidatePath('/draft');
    return { ok: true, message: `Strategy set to ${strategy}.` };
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncNow(kind: 'players' | 'league' | 'history' | 'market' | 'all'): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId && kind !== 'players') {
      return { ok: false, message: 'Set your Sleeper league id on the Settings page first.' };
    }

    const messages: string[] = [];

    if (kind === 'players' || kind === 'all') {
      const r = await syncPlayers();
      messages.push(`${r.recordsWritten} players`);
    }
    if ((kind === 'league' || kind === 'all') && cfg.leagueId) {
      await syncLeague(cfg.leagueId, { markPrimary: true });
      await syncDrafts(cfg.leagueId);
      messages.push('league + drafts');
    }
    if (kind === 'history' && cfg.leagueId) {
      const r = await syncHistory(cfg.leagueId);
      await deriveLeagueAdp({ leagueId: cfg.leagueId, season: cfg.season });
      await computeManagerProfiles(cfg.leagueId);
      messages.push(`${r.recordsWritten} historical drafts`);
    }
    if ((kind === 'market' || kind === 'all') && cfg.leagueId) {
      const t = await syncTrending(cfg.season);
      const a = await deriveLeagueAdp({ leagueId: cfg.leagueId, season: cfg.season });
      messages.push(`${t.recordsWritten} trends, ${a.recordsWritten} ADP`);
    }

    revalidatePath('/');
    revalidatePath('/board');
    return { ok: true, message: `Synced: ${messages.join(', ')}.` };
  });
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

export async function runValuationNow(): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'Set your Sleeper league id on the Settings page first.' };

    const result = await runValuation({
      leagueId: cfg.leagueId,
      season: cfg.season,
      scope: 'DRAFT',
      label: 'Manual run',
    });

    const detail = result.detail as { baselineCount?: number };
    revalidatePath('/board');
    revalidatePath('/draft');
    revalidatePath('/keepers');
    revalidatePath('/');

    return {
      ok: true,
      message:
        `Valued ${result.recordsWritten} players.` +
        (detail?.baselineCount ? ` ${detail.baselineCount} used the fallback curve.` : ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Board overrides
// ---------------------------------------------------------------------------

const boardSchema = z.object({
  playerId: z.string().min(1),
  userRank: z.coerce.number().positive().nullable().optional(),
  userTier: z.coerce.number().int().positive().nullable().optional(),
  targetRound: z.coerce.number().int().positive().nullable().optional(),
  status: zBoardStatus.optional(),
  note: z.string().trim().nullable().optional(),
  isDoNotDraft: z.coerce.boolean().optional(),
});

export async function saveBoardEntry(input: {
  playerId: string;
  userRank?: number | null;
  userTier?: number | null;
  targetRound?: number | null;
  status?: string;
  note?: string | null;
  isDoNotDraft?: boolean;
}): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };

    const parsed = boardSchema.parse(input);
    const data = {
      userRank: parsed.userRank ?? null,
      userTier: parsed.userTier ?? null,
      targetRound: parsed.targetRound ?? null,
      status: parsed.status ?? 'NEUTRAL',
      note: parsed.note ?? null,
      isDoNotDraft: parsed.isDoNotDraft ?? parsed.status === 'DO_NOT_DRAFT',
    };

    await prisma.boardEntry.upsert({
      where: {
        leagueId_season_playerId: { leagueId: cfg.leagueId, season: cfg.season, playerId: parsed.playerId },
      },
      create: { leagueId: cfg.leagueId, season: cfg.season, playerId: parsed.playerId, ...data },
      update: data,
    });

    revalidatePath('/board');
    revalidatePath('/draft');
    return { ok: true, message: 'Saved.' };
  });
}

export async function clearBoardEntry(playerId: string): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };
    await prisma.boardEntry.deleteMany({
      where: { leagueId: cfg.leagueId, season: cfg.season, playerId },
    });
    revalidatePath('/board');
    return { ok: true, message: 'Override cleared.' };
  });
}

// ---------------------------------------------------------------------------
// Sources + imports
// ---------------------------------------------------------------------------

const sourceSchema = z.object({
  key: z.string().trim().min(1, 'Give the source a short key, e.g. "mike-clay"'),
  label: z.string().trim().min(1, 'Give the source a display name'),
  kind: z.enum(['PROJECTIONS', 'RANKINGS', 'ADP', 'USAGE', 'NEWS', 'ANALYST', 'MARKET']),
  adapter: z.enum(['CSV', 'SLEEPER', 'HTTP_JSON', 'MANUAL']),
  weight: z.coerce.number().min(0).max(10),
  trust: z.coerce.number().min(0).max(1),
  url: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  enabled: z.coerce.boolean().optional(),
});

export async function saveSource(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const raw = Object.fromEntries(formData.entries());
    const parsed = sourceSchema.parse({ ...raw, enabled: raw.enabled === 'on' || raw.enabled === 'true' });
    await upsertSource(parsed);
    revalidatePath('/sources');
    return { ok: true, message: `Saved "${parsed.label}".` };
  });
}

export async function removeSource(key: string): Promise<ActionResult> {
  return guard(async () => {
    await deleteSource(key);
    revalidatePath('/sources');
    return { ok: true, message: 'Source removed. Its historical data was kept.' };
  });
}

export async function toggleSource(key: string, enabled: boolean): Promise<ActionResult> {
  return guard(async () => {
    await setSourceEnabled(key, enabled);
    revalidatePath('/sources');
    return { ok: true, message: enabled ? 'Source enabled.' : 'Source disabled.' };
  });
}

export async function seedDefaultSources(): Promise<ActionResult> {
  return guard(async () => {
    const n = await seedSources();
    revalidatePath('/sources');
    return { ok: true, message: `${n} default sources added.` };
  });
}

export async function importCsv(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    const file = formData.get('file');
    const source = String(formData.get('source') ?? '').trim();
    const type = String(formData.get('type') ?? 'rankings');
    const label = String(formData.get('label') ?? '').trim() || undefined;
    const format = (String(formData.get('format') ?? 'PPR') || 'PPR') as ScoringFormat;
    const weekRaw = String(formData.get('week') ?? '').trim();
    const week = weekRaw ? Number(weekRaw) : undefined;

    if (!source) return { ok: false, message: 'Choose or name a source.' };
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a CSV file.' };

    const csv = await file.text();

    const outcome =
      type === 'projections'
        ? await importProjectionsCsv({
            csv,
            source,
            label,
            season: cfg.season,
            scope: week ? 'WEEKLY' : 'SEASON',
            week,
            format,
          })
        : type === 'adp'
          ? await importAdpCsv({ csv, source, label, season: cfg.season, format })
          : await importRankingsCsv({
              csv,
              source,
              label,
              season: cfg.season,
              scope: week ? 'WEEKLY' : 'DRAFT',
              week,
              format,
            });

    revalidatePath('/sources');

    const parts = [`Imported ${outcome.recordsWritten} of ${outcome.recordsIn} rows.`];
    if (outcome.unresolved.length) {
      parts.push(
        `${outcome.unresolved.length} names could not be matched: ${outcome.unresolved
          .slice(0, 8)
          .map((u) => u.name)
          .join(', ')}${outcome.unresolved.length > 8 ? '…' : ''}`,
      );
    }
    if (outcome.skipped.length) parts.push(`${outcome.skipped.length} rows skipped.`);
    parts.push('Re-run the valuation to use this data.');

    return { ok: true, message: parts.join(' '), data: outcome };
  });
}

// ---------------------------------------------------------------------------
// Keepers
// ---------------------------------------------------------------------------

const keeperSchema = z.object({
  playerId: z.string().min(1),
  rosterId: z.coerce.number().int().nullable().optional(),
  costRound: z.coerce.number().int().min(1).max(30).nullable().optional(),
  costPickNo: z.coerce.number().int().min(1).nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

export async function saveKeeper(input: {
  playerId: string;
  rosterId?: number | null;
  costRound?: number | null;
  costPickNo?: number | null;
  notes?: string | null;
}): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };
    const parsed = keeperSchema.parse(input);

    const member = parsed.rosterId
      ? await prisma.leagueRoster.findFirst({
          where: { leagueId: cfg.leagueId, rosterId: parsed.rosterId },
          select: { memberId: true },
        })
      : null;

    const data = {
      rosterId: parsed.rosterId ?? null,
      memberId: member?.memberId ?? null,
      costRound: parsed.costRound ?? null,
      costPickNo: parsed.costPickNo ?? null,
      notes: parsed.notes ?? null,
      source: 'manual',
      isConfirmed: true,
    };

    await prisma.keeperDeclaration.upsert({
      where: {
        leagueId_season_playerId: { leagueId: cfg.leagueId, season: cfg.season, playerId: parsed.playerId },
      },
      create: { leagueId: cfg.leagueId, season: cfg.season, playerId: parsed.playerId, ...data },
      update: data,
    });

    revalidatePath('/keepers');
    revalidatePath('/draft');
    return { ok: true, message: 'Keeper saved.' };
  });
}

export async function removeKeeper(playerId: string): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };
    await prisma.keeperDeclaration.deleteMany({
      where: { leagueId: cfg.leagueId, season: cfg.season, playerId },
    });
    revalidatePath('/keepers');
    return { ok: true, message: 'Keeper removed.' };
  });
}

export async function importKeepersFromLastDraft(): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };

    const draft = await prisma.draft.findFirst({
      where: { leagueId: cfg.leagueId, season: cfg.season },
      orderBy: { createdAt: 'desc' },
    });
    if (!draft) return { ok: false, message: 'No draft found for this season yet.' };

    const result = await importKeepersFromDraft(draft.id);
    revalidatePath('/keepers');
    return { ok: true, message: `${result.recordsWritten} keepers imported from Sleeper.` };
  });
}

// ---------------------------------------------------------------------------
// Draft room
// ---------------------------------------------------------------------------

export async function setActiveDraft(draftId: string): Promise<ActionResult> {
  return guard(async () => {
    await prisma.draft.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
    await prisma.draft.update({ where: { id: draftId }, data: { isPrimary: true } });
    await setConfig({ activeDraftId: draftId });
    revalidatePath('/draft');
    return { ok: true, message: 'Active draft set.' };
  });
}

export async function pullDraftNow(draftId: string): Promise<ActionResult> {
  return guard(async () => {
    const result = await syncDraftPicks(draftId);
    revalidatePath('/draft');
    return { ok: true, message: `${result.totalPicks} picks on record (${result.recordsWritten} updated).` };
  });
}

export async function enterPick(draftId: string, pickNo: number, playerId: string | null): Promise<ActionResult> {
  return guard(async () => {
    await recordManualPick({ draftId, pickNo, playerId });
    revalidatePath('/draft');
    return { ok: true, message: playerId ? 'Pick recorded.' : 'Pick cleared.' };
  });
}

export async function undoDraftPick(draftId: string, pickNo: number): Promise<ActionResult> {
  return guard(async () => {
    await undoPick(draftId, pickNo);
    revalidatePath('/draft');
    return { ok: true, message: `Pick ${pickNo} cleared.` };
  });
}

// ---------------------------------------------------------------------------
// Research / evidence
// ---------------------------------------------------------------------------

const evidenceSchema = z.object({
  playerId: z.string().trim().nullable().optional(),
  teamId: z.string().trim().nullable().optional(),
  evidenceType: z.string().min(1),
  headline: z.string().trim().min(1, 'Headline is required'),
  body: z.string().trim().nullable().optional(),
  sourceName: z.string().trim().nullable().optional(),
  sourceUrl: z.string().trim().nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  sentiment: z.coerce.number().min(-1).max(1).optional(),
  impact: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
});

export async function addEvidence(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const cfg = await getConfig();
    const raw = Object.fromEntries(formData.entries());
    const parsed = evidenceSchema.parse(raw);

    if (!parsed.playerId && !parsed.teamId) {
      return { ok: false, message: 'Attach the note to a player or a team.' };
    }

    // If the note names a registered source, inherit that source's trust as the
    // default confidence — that's the whole point of rating your sources.
    let confidence = parsed.confidence;
    if (confidence === undefined && parsed.sourceName) {
      const source = await prisma.dataSource.findFirst({
        where: { OR: [{ key: parsed.sourceName }, { label: parsed.sourceName }] },
        select: { trust: true },
      });
      confidence = source?.trust;
    }

    await prisma.evidence.create({
      data: {
        subjectType: parsed.playerId ? 'PLAYER' : 'TEAM',
        subjectId: parsed.playerId || parsed.teamId || '',
        playerId: parsed.playerId || null,
        teamId: parsed.teamId || null,
        evidenceType: parsed.evidenceType,
        season: cfg.season,
        headline: parsed.headline,
        body: parsed.body || null,
        sourceName: parsed.sourceName || null,
        sourceUrl: parsed.sourceUrl || null,
        confidence: confidence ?? 0.5,
        sentiment: parsed.sentiment ?? 0,
        impact: parsed.impact ?? 'MEDIUM',
        isUserEntered: true,
        observedAt: new Date(),
      },
    });

    revalidatePath('/research');
    return { ok: true, message: 'Note saved.' };
  });
}

export async function deleteEvidence(id: string): Promise<ActionResult> {
  return guard(async () => {
    await prisma.evidence.delete({ where: { id } });
    revalidatePath('/research');
    return { ok: true, message: 'Note deleted.' };
  });
}

// ---------------------------------------------------------------------------
// Mock drafts
// ---------------------------------------------------------------------------

export async function deleteMock(id: string): Promise<ActionResult> {
  return guard(async () => {
    await prisma.mockDraft.delete({ where: { id } });
    revalidatePath('/mock');
    return { ok: true, message: 'Mock deleted.' };
  });
}

/** Read the saved draft strategy without exposing the AppSetting table shape. */
export async function getStrategy(): Promise<DraftStrategy> {
  const row = await prisma.appSetting.findUnique({ where: { key: 'draft.strategy' } });
  return (readJson<{ strategy?: DraftStrategy }>(row?.valueJson, {}).strategy ?? 'BALANCED') as DraftStrategy;
}
