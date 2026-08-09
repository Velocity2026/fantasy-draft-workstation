import { prisma } from '../db';
import { PlayerResolver } from '../providers/resolve';
import { writeJson } from '../json';
import type { ImpactLevel } from '../enums';

/**
 * Writer for hand-transcribed analyst team/rookie profile guides (e.g. the
 * Ratcliffe team-by-team outlooks, the FTN rookie scouting guide).
 *
 * DESIGNED FOR THE YEARLY SWAP. Craig plans to use this tool next season and
 * wants to replace this year's guide with next year's without losing the
 * ability to look back. Every row this writes carries:
 *   - `season`   — so a 2027 import lives in its own bucket and 2026 stays
 *                  untouched as history, the same discipline already applied
 *                  to Projection/Ranking/ADP.
 *   - `edition`  — a free-text tag (e.g. "2026-process-guide") distinguishing
 *                  this specific document from any other guide by the same
 *                  analyst in the same season, stored in tagsJson.
 *
 * Re-running for the SAME (source, season, edition) replaces just that
 * edition's rows — safe to re-run after fixing a transcription error without
 * duplicating or touching anything else.
 *
 * Player names are resolved through the same PlayerResolver every CSV import
 * uses, so a misread name is reported rather than silently attached to the
 * wrong player or silently dropped.
 */

export interface ProfilePlayerInput {
  name: string;
  position: string;
  team?: string;
  /** e.g. "HIGH CEILING WR3", "ELITE TE", "BOOM/BUST FEATURE RB" */
  archetype?: string;
  narrative: string;
  impact?: ImpactLevel;
}

export interface TeamProfileInput {
  teamId: string;
  outlook: string;
  players: ProfilePlayerInput[];
  bestStacks?: string[];
}

export interface RookieProfileInput {
  name: string;
  position: string;
  college?: string;
  narrative: string;
  archetype?: string;
  impact?: ImpactLevel;
}

export interface ProfileImportResult {
  written: number;
  unresolved: { name: string; position: string; context: string }[];
}

async function resolvePlayers(
  resolver: PlayerResolver,
  refs: { name: string; position: string; team?: string }[],
) {
  const { resolved, unresolved } = resolver.resolveMany(
    refs.map((r) => ({ name: r.name, position: r.position, team: r.team })),
  );
  const byNamePos = new Map(resolved.map((r) => [`${r.name}|${r.position}`, r.playerId]));
  return { byNamePos, unresolved };
}

export async function writeTeamProfiles(args: {
  source: string;
  season: string;
  edition: string;
  teams: TeamProfileInput[];
}): Promise<ProfileImportResult> {
  const resolver = await PlayerResolver.create({ source: args.source, learn: true });
  const observedAt = new Date();
  const unresolved: ProfileImportResult['unresolved'] = [];
  let written = 0;

  // Idempotent per (source, season, edition): clear this edition's own rows
  // before rewriting, never touching other editions or other seasons.
  await prisma.evidence.deleteMany({
    where: {
      sourceName: args.source,
      season: args.season,
      isUserEntered: false,
      tagsJson: { contains: `"${args.edition}"` },
    },
  });

  for (const team of args.teams) {
    await prisma.evidence.create({
      data: {
        subjectType: 'TEAM',
        subjectId: team.teamId,
        teamId: team.teamId,
        evidenceType: 'ANALYST_PROFILE',
        season: args.season,
        headline: `${team.teamId} 2026 team outlook`,
        body: team.outlook + (team.bestStacks?.length ? `\n\nBest stacks: ${team.bestStacks.join('; ')}` : ''),
        sourceName: args.source,
        confidence: await sourceTrust(args.source),
        impact: 'MEDIUM',
        tagsJson: writeJson([args.edition, 'team-outlook']),
        observedAt,
      },
    });
    written += 1;

    const { byNamePos, unresolved: teamUnresolved } = await resolvePlayers(
      resolver,
      team.players.map((p) => ({ name: p.name, position: p.position, team: team.teamId })),
    );
    for (const u of teamUnresolved) unresolved.push({ name: u.name, position: u.position ?? '?', context: team.teamId });

    for (const p of team.players) {
      const playerId = byNamePos.get(`${p.name}|${p.position}`);
      if (!playerId) continue;

      await prisma.evidence.create({
        data: {
          subjectType: 'PLAYER',
          subjectId: playerId,
          playerId,
          evidenceType: 'ANALYST_PROFILE',
          season: args.season,
          headline: p.archetype ? `${args.source}: ${p.archetype}` : `${args.source}: player profile`,
          body: p.narrative,
          sourceName: args.source,
          confidence: await sourceTrust(args.source),
          impact: p.impact ?? 'MEDIUM',
          tagsJson: writeJson([args.edition, 'team-profile', p.archetype].filter(Boolean)),
          observedAt,
        },
      });
      written += 1;
    }
  }

  await resolver.commitLearned();
  return { written, unresolved };
}

export async function writeRookieProfiles(args: {
  source: string;
  season: string;
  edition: string;
  rookies: RookieProfileInput[];
}): Promise<ProfileImportResult> {
  const resolver = await PlayerResolver.create({ source: args.source, learn: true });
  const observedAt = new Date();
  const unresolved: ProfileImportResult['unresolved'] = [];
  let written = 0;

  await prisma.evidence.deleteMany({
    where: {
      sourceName: args.source,
      season: args.season,
      isUserEntered: false,
      tagsJson: { contains: `"${args.edition}"` },
    },
  });

  const { byNamePos, unresolved: batchUnresolved } = await resolvePlayers(
    resolver,
    args.rookies.map((r) => ({ name: r.name, position: r.position })),
  );
  for (const u of batchUnresolved) unresolved.push({ name: u.name, position: u.position ?? '?', context: 'rookie guide' });

  for (const r of args.rookies) {
    const playerId = byNamePos.get(`${r.name}|${r.position}`);
    if (!playerId) continue;

    await prisma.evidence.create({
      data: {
        subjectType: 'PLAYER',
        subjectId: playerId,
        playerId,
        evidenceType: 'ANALYST_PROFILE',
        season: args.season,
        headline: r.archetype ? `${args.source}: ${r.archetype}` : `${args.source}: rookie scouting report`,
        body: r.narrative + (r.college ? `\n\n${r.college}` : ''),
        sourceName: args.source,
        confidence: await sourceTrust(args.source),
        impact: r.impact ?? 'MEDIUM',
        tagsJson: writeJson([args.edition, 'rookie-profile', r.archetype].filter(Boolean)),
        observedAt,
      },
    });
    written += 1;
  }

  await resolver.commitLearned();
  return { written, unresolved };
}

async function sourceTrust(source: string): Promise<number> {
  const row = await prisma.dataSource.findUnique({ where: { key: source }, select: { trust: true } });
  return row?.trust ?? 0.5;
}
