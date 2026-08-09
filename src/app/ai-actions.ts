'use server';

import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getActiveRun, loadBoard } from '@/lib/valuation/engine';
import { evaluateAllKeepers } from '@/lib/valuation/keeper';
import { loadDraftRoomState } from '@/lib/draft/state';
import { summarize, buildKeeperContext, buildDraftContext, buildLeagueContext } from '@/lib/ai/summarize';
import type { ActionResult } from './actions';

/** Written keeper analysis across every declared keeper. */
export async function summarizeKeepers(): Promise<ActionResult> {
  const cfg = await getConfig();
  if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };

  const activeRun = await getActiveRun(cfg.leagueId, cfg.season, 'DRAFT');
  if (!activeRun) return { ok: false, message: 'Build a board first.' };

  const league = await prisma.league.findUniqueOrThrow({ where: { id: cfg.leagueId } });
  const board = await loadBoard(activeRun.id);
  const evaluations = await evaluateAllKeepers({
    leagueId: cfg.leagueId,
    season: cfg.season,
    board,
    teams: league.totalRosters,
  });

  if (!evaluations.length) return { ok: false, message: 'No keepers declared yet.' };

  const result = await summarize({
    module: 'KEEPER',
    subjectType: 'LEAGUE',
    subjectId: cfg.leagueId,
    season: cfg.season,
    context: buildKeeperContext(evaluations),
    instruction:
      'Give me a short keeper verdict. Lead with which ones are clear keeps and which are clear cuts, then spend most of the words on the genuinely marginal calls and what would tip them either way. Mention where the surplus is coming from — his value, or a cheap pick.',
  });

  if (result.error) return { ok: false, message: result.error };
  return { ok: true, message: 'Done.', data: result };
}

/** Written read on the current draft situation. */
export async function summarizeDraft(draftId: string): Promise<ActionResult> {
  const cfg = await getConfig();
  const state = await loadDraftRoomState(draftId);

  if (!state.suggestions.length) return { ok: false, message: 'No board loaded — build one first.' };

  const me = state.rosters.find((r) => r.isMe);

  const result = await summarize({
    module: 'DRAFT',
    subjectType: 'DRAFT',
    subjectId: draftId,
    season: cfg.season,
    context: buildDraftContext({
      pickLabel: state.currentPickLabel,
      onTheClock: state.onTheClock?.isMe ? 'me' : (state.onTheClock?.memberName ?? 'unknown'),
      picksUntilMyTurn: state.picksUntilMyTurn,
      myCounts: state.myRoster.counts,
      needs: me?.needs ?? [],
      strategy: state.strategy,
      suggestions: state.suggestions.slice(0, 6).map((s) => ({
        fullName: s.player.fullName,
        position: s.player.position,
        positionRank: s.player.positionRank,
        tier: s.player.tier,
        vorp: s.player.vorp,
        vona: s.vona,
        adp: s.player.adp,
        adpDelta: s.player.adpDelta,
        availabilityAtNextPick: s.availabilityAtNextPick,
        isBaseline: s.player.isBaseline,
        reasons: s.reasons,
      })),
      runAlerts: state.runAlerts.map((a) => ({ position: a.position, message: a.message })),
    }),
    instruction:
      'In four sentences or fewer: what should I do with this pick, and why? Name one player. If waiting is better than taking the top option, say that instead.',
    maxTokens: 400,
  });

  if (result.error) return { ok: false, message: result.error };
  return { ok: true, message: 'Done.', data: result };
}

/** Written read on how this league's managers draft. */
export async function summarizeLeague(): Promise<ActionResult> {
  const cfg = await getConfig();
  if (!cfg.leagueId) return { ok: false, message: 'No league configured.' };

  const profiles = await prisma.managerProfile.findMany({
    where: { leagueId: cfg.leagueId },
    include: { member: { select: { displayName: true, isMe: true } } },
  });

  if (!profiles.length) return { ok: false, message: 'No manager profiles yet — import league history first.' };

  const result = await summarize({
    module: 'LEAGUE',
    subjectType: 'LEAGUE',
    subjectId: cfg.leagueId,
    season: cfg.season,
    context: buildLeagueContext(
      profiles.map((p) => ({
        displayName: p.member.displayName + (p.member.isMe ? ' (me)' : ''),
        avgReachVsAdp: p.avgReachVsAdp,
        qbTendency: p.qbTendency,
        teTendency: p.teTendency,
        rbShareEarly: p.rbShareEarly,
        wrShareEarly: p.wrShareEarly,
        predictabilityR2: p.predictabilityR2,
        sampleSize: p.sampleSize,
      })),
    ),
    instruction:
      'How should these tendencies change how I draft? Focus on exploitable patterns — positions I can afford to wait on because nobody here takes them early, and positions where I need to move first. Be specific about which managers create each situation.',
  });

  if (result.error) return { ok: false, message: result.error };
  return { ok: true, message: 'Done.', data: result };
}
