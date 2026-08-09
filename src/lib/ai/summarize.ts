import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db';
import { listSources } from '../sources';

/**
 * AI analytical summaries.
 *
 * Two rules govern this module:
 *
 * 1. **The model never invents numbers.** Every figure it writes about is
 *    passed in as structured context. It is a writer, not an analyst — the
 *    analysis already happened in the valuation engine. This keeps the output
 *    trustworthy on draft day, when there is no time to verify a claim.
 *
 * 2. **Summaries are cached by input hash.** Re-rendering a page shouldn't cost
 *    an API call, but a changed board should invalidate immediately. Hashing
 *    the rendered context gives both for free.
 *
 * The app works fully without an API key; every entry point degrades to a
 * "not configured" note rather than an error.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface SummaryRequest {
  module: 'DRAFT' | 'PLAYER' | 'KEEPER' | 'LEAGUE' | 'MOCK';
  subjectType: string;
  subjectId: string;
  season: string;
  week?: number;
  /** Human-readable, pre-computed facts. The model only reasons over these. */
  context: string;
  instruction: string;
  maxTokens?: number;
}

export interface SummaryResult {
  content: string;
  cached: boolean;
  configured: boolean;
  error?: string;
}

function hashInput(req: SummaryRequest): string {
  return createHash('sha256')
    .update(`${MODEL}\n${req.instruction}\n${req.context}`)
    .digest('hex')
    .slice(0, 32);
}

export async function summarize(req: SummaryRequest): Promise<SummaryResult> {
  if (!isAiConfigured()) {
    return {
      content: '',
      cached: false,
      configured: false,
      error: 'No ANTHROPIC_API_KEY set — add one to .env to enable written analysis.',
    };
  }

  const inputHash = hashInput(req);
  const week = req.week ?? 0;

  const existing = await prisma.aiSummary.findUnique({
    where: {
      module_subjectType_subjectId_season_week_inputHash: {
        module: req.module,
        subjectType: req.subjectType,
        subjectId: req.subjectId,
        season: req.season,
        week,
        inputHash,
      },
    },
  });

  if (existing && !existing.isStale) {
    return { content: existing.content, cached: true, configured: true };
  }

  // Give the model the user's own source hierarchy so its language reflects
  // which inputs this particular user actually trusts.
  const sources = await listSources();
  const sourceNote = sources
    .filter((s) => s.enabled && s.notes)
    .map((s) => `- ${s.label} (weight ${s.weight}, trust ${(s.trust * 100).toFixed(0)}%): ${s.notes}`)
    .join('\n');

  const system = [
    'You are an analyst embedded in a private fantasy football draft tool for a single user.',
    'The user is preparing for a 10-team, full-PPR, keeper league on Sleeper.',
    '',
    'Hard rules:',
    '- Use ONLY the numbers and facts given to you in the context block. Never invent or recall statistics, projections, ADP, injuries or news from memory.',
    '- If the context is thin, say so plainly rather than padding.',
    '- Numbers marked "estimated" come from a fallback curve, not a real projection. Flag that when you lean on one.',
    '- Be concise and decisive. The user often reads this while on the clock.',
    '- Write in plain prose. No preamble, no restating the question, no bullet-point dumps unless asked.',
    sourceNote ? `\nThe user's configured sources and how much they trust them:\n${sourceNote}` : '',
  ].join('\n');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: req.maxTokens ?? 700,
      system,
      messages: [
        {
          role: 'user',
          content: `${req.instruction}\n\n<context>\n${req.context}\n</context>`,
        },
      ],
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    await prisma.aiSummary.upsert({
      where: {
        module_subjectType_subjectId_season_week_inputHash: {
          module: req.module,
          subjectType: req.subjectType,
          subjectId: req.subjectId,
          season: req.season,
          week,
          inputHash,
        },
      },
      create: {
        module: req.module,
        subjectType: req.subjectType,
        subjectId: req.subjectId,
        season: req.season,
        week,
        inputHash,
        model: MODEL,
        content,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
      },
      update: { content, isStale: false, tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
    });

    return { content, cached: false, configured: true };
  } catch (error) {
    return {
      content: '',
      cached: false,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Context builders — these do the real work of deciding what the model sees.
// ---------------------------------------------------------------------------

export function buildKeeperContext(evaluations: {
  fullName: string;
  position: string;
  costRound: number | null;
  costPickNo: number | null;
  playerVorp: number;
  pickVorp: number;
  surplus: number;
  surplusInRounds: number | null;
  verdict: string;
  tier: number;
  adp: number | null;
  riskScore: number | null;
}[]): string {
  const lines = evaluations.map(
    (k) =>
      `${k.fullName} (${k.position}, tier ${k.tier}) — cost ${k.costPickNo ? `pick ${k.costPickNo}` : `round ${k.costRound ?? '?'}`}; ` +
      `his value ${k.playerVorp.toFixed(0)} VORP vs ${k.pickVorp.toFixed(0)} VORP expected from that pick; ` +
      `surplus ${k.surplus.toFixed(0)}${k.surplusInRounds !== null ? ` (~${k.surplusInRounds.toFixed(1)} rounds)` : ''}; ` +
      `model verdict ${k.verdict}${k.adp !== null ? `; market ADP ${k.adp.toFixed(0)}` : ''}` +
      `${k.riskScore !== null && k.riskScore > 0.35 ? `; elevated risk ${(k.riskScore * 100).toFixed(0)}%` : ''}`,
  );
  return `Keeper candidates:\n${lines.join('\n')}`;
}

export function buildDraftContext(args: {
  pickLabel: string;
  onTheClock: string;
  picksUntilMyTurn: number | null;
  myCounts: Record<string, number>;
  needs: string[];
  strategy: string;
  suggestions: {
    fullName: string;
    position: string;
    positionRank: number;
    tier: number;
    vorp: number;
    vona: number;
    adp: number | null;
    adpDelta: number | null;
    availabilityAtNextPick: number;
    isBaseline: boolean;
    reasons: string[];
  }[];
  runAlerts: { position: string; message: string }[];
}): string {
  const roster = Object.entries(args.myCounts)
    .map(([pos, n]) => `${pos}:${n}`)
    .join(' ');

  const options = args.suggestions
    .slice(0, 6)
    .map(
      (s) =>
        `${s.fullName} (${s.position}${s.positionRank}, tier ${s.tier}) — ${s.vorp.toFixed(0)} VORP, ` +
        `${s.vona.toFixed(0)} VONA, ADP ${s.adp?.toFixed(0) ?? 'unknown'}, ` +
        `${Math.round(s.availabilityAtNextPick * 100)}% likely to last until my next pick` +
        `${s.isBaseline ? ' [projection estimated]' : ''}`,
    )
    .join('\n');

  return [
    `Current pick: ${args.pickLabel}, on the clock: ${args.onTheClock}.`,
    args.picksUntilMyTurn !== null ? `My next pick is ${args.picksUntilMyTurn} picks away.` : '',
    `My roster so far: ${roster || 'empty'}. Unfilled starting slots: ${args.needs.join(', ') || 'none'}.`,
    `Configured strategy: ${args.strategy}.`,
    args.runAlerts.length ? `Positional runs in progress: ${args.runAlerts.map((a) => a.message).join(' ')}` : '',
    '',
    `Top options by the model's own ranking:\n${options}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildLeagueContext(profiles: {
  displayName: string;
  avgReachVsAdp: number | null;
  qbTendency: string | null;
  teTendency: string | null;
  rbShareEarly: number | null;
  wrShareEarly: number | null;
  predictabilityR2: number | null;
  sampleSize: number;
}[]): string {
  const lines = profiles.map(
    (p) =>
      `${p.displayName}: ${p.sampleSize} picks sampled; ` +
      `reach vs ADP ${p.avgReachVsAdp?.toFixed(1) ?? 'unknown'}; ` +
      `QB ${p.qbTendency ?? '?'}, TE ${p.teTendency ?? '?'}; ` +
      `early picks ${p.rbShareEarly !== null ? `${(p.rbShareEarly * 100).toFixed(0)}% RB` : '?'} / ` +
      `${p.wrShareEarly !== null ? `${(p.wrShareEarly * 100).toFixed(0)}% WR` : '?'}; ` +
      `ADP-predictability ${p.predictabilityR2 !== null ? `${(p.predictabilityR2 * 100).toFixed(0)}%` : 'unknown'}`,
  );
  return `Manager draft tendencies (positive reach = takes players earlier than this league's ADP):\n${lines.join('\n')}`;
}
