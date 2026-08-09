'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getConfig, deriveRosterShape } from '@/lib/config';
import { readJson } from '@/lib/json';
import { getActiveRun, loadBoard } from '@/lib/valuation/engine';
import { consumedPicks } from '@/lib/valuation/keeper';
import { runAndSaveMock, predictabilityBySlot } from '@/lib/draft/simulate';
import type { DraftStrategy } from '@/lib/enums';
import type { ActionResult } from './actions';

/**
 * Mock-draft simulation. Kept out of actions.ts because a 500-iteration run is
 * meaningfully slower than every other action and it helps to see that at the
 * call site.
 */
export async function runMock(formData: FormData): Promise<ActionResult> {
  try {
    const cfg = await getConfig();
    if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };

    const league = await prisma.league.findUniqueOrThrow({ where: { id: cfg.leagueId } });
    const activeRun = await getActiveRun(cfg.leagueId, cfg.season, 'DRAFT');
    if (!activeRun) return { ok: false, message: 'Build a board first — the simulator needs player values.' };

    const board = await loadBoard(activeRun.id);
    const rosterPositions = readJson<string[]>(league.rosterPositionsJson, []);
    const shape = deriveRosterShape(rosterPositions, league.totalRosters);

    const draft = await prisma.draft.findFirst({
      where: { leagueId: cfg.leagueId, season: cfg.season },
      orderBy: { createdAt: 'desc' },
    });

    const teams = draft?.teams || league.totalRosters;
    const rounds = Number(formData.get('rounds')) || draft?.rounds || shape.rounds || 15;
    const slot = Number(formData.get('slot')) || cfg.myDraftSlot || 1;
    const strategy = (String(formData.get('strategy') || 'BALANCED')) as DraftStrategy;
    const iterations = Math.min(2000, Math.max(20, Number(formData.get('iterations')) || 200));
    const name = String(formData.get('name') || '').trim() || `${strategy} from slot ${slot}`;

    // Keepers are off the board and their picks are already spent.
    const keepers = await prisma.keeperDeclaration.findMany({
      where: { leagueId: cfg.leagueId, season: cfg.season },
      select: { playerId: true },
    });
    const consumed = league.isKeeper ? await consumedPicks(cfg.leagueId, cfg.season, teams) : new Set<number>();

    const slotToRoster = readJson<Record<string, number>>(draft?.slotToRosterJson, {});
    const predictability = Object.keys(slotToRoster).length
      ? await predictabilityBySlot(cfg.leagueId, slotToRoster)
      : undefined;

    const { mockDraftId, result } = await runAndSaveMock({
      leagueId: cfg.leagueId,
      season: cfg.season,
      name,
      params: {
        leagueId: cfg.leagueId,
        season: cfg.season,
        board,
        shape,
        teams,
        rounds,
        myDraftSlot: slot,
        strategy,
        iterations,
        unavailable: new Set(keepers.map((k) => k.playerId)),
        consumedPicks: consumed,
        predictabilityBySlot: predictability,
        needWeight: cfg.needWeight,
      },
    });

    revalidatePath('/mock');
    return {
      ok: true,
      message: `Ran ${iterations} drafts. Average starting-lineup value ${result.myOutcomes.avgStartingPoints.toFixed(0)} VORP.`,
      data: { mockDraftId },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
