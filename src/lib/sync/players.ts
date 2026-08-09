import { prisma } from '../db';
import { NFL_TEAMS } from '../data/nfl-teams';
import { sleeper, normalisePosition, parseHeightInches, type SleeperPlayer } from '../providers/sleeper';
import { POSITIONS } from '../enums';
import { normaliseName } from '../utils';
import { writeJson } from '../json';
import { withSyncRun, type SyncResult } from './runner';

const RELEVANT = new Set<string>(POSITIONS);

/**
 * Pull the Sleeper player dictionary into the Player table.
 *
 * Sleeper ships ~11k players including practice-squad linemen. We keep only
 * fantasy-relevant positions, which cuts the table to roughly 1,500 rows and
 * keeps every board query fast without a search index.
 *
 * Inactive-but-known players are retained rather than deleted: historical draft
 * picks and prior-season stats reference them, and losing the row would break
 * the history views.
 */
export async function syncPlayers(opts: { force?: boolean } = {}): Promise<SyncResult> {
  return withSyncRun({ provider: 'sleeper', job: 'players' }, async () => {
    // Teams first — Player.teamId is a real FK.
    for (const team of NFL_TEAMS) {
      await prisma.nflTeam.upsert({
        where: { id: team.id },
        create: { id: team.id, name: team.name, conference: team.conference, division: team.division },
        update: { name: team.name, conference: team.conference, division: team.division },
      });
    }

    const all = await sleeper.getAllPlayers({ force: opts.force });
    const entries = Object.values(all);
    const keep = entries.filter((p) => {
      const pos = normalisePosition(p.position, p.fantasy_positions);
      return pos !== null && RELEVANT.has(pos);
    });

    let written = 0;
    // Chunked to keep a single SQLite transaction from getting unreasonably
    // long; ~1,500 upserts is fast but not instant.
    const CHUNK = 250;
    for (let i = 0; i < keep.length; i += CHUNK) {
      const chunk = keep.slice(i, i + CHUNK);
      await prisma.$transaction(
        chunk.map((p) => {
          const data = toPlayerData(p);
          return prisma.player.upsert({
            where: { id: p.player_id },
            create: { id: p.player_id, ...data },
            update: data,
          });
        }),
      );
      written += chunk.length;
    }

    // Sleeper ids are our canonical ids, but record them explicitly so the
    // resolver's "source = sleeper" path works uniformly with other providers.
    return {
      recordsIn: entries.length,
      recordsWritten: written,
      detail: { keptPositions: [...RELEVANT], discarded: entries.length - keep.length },
    };
  });
}

function toPlayerData(p: SleeperPlayer) {
  const position = normalisePosition(p.position, p.fantasy_positions) ?? 'DEF';
  const fullName = p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? p.player_id;
  // Sleeper's team defences have no team field; their player_id *is* the team.
  const teamId = p.team ?? (position === 'DEF' ? p.player_id : null);

  return {
    fullName,
    firstName: p.first_name,
    lastName: p.last_name,
    searchName: normaliseName(fullName),
    position,
    teamId: teamId && NFL_TEAM_SET.has(teamId) ? teamId : null,
    age: p.age,
    birthDate: p.birth_date,
    heightIn: parseHeightInches(p.height),
    weightLb: p.weight ? Number(p.weight) || null : null,
    college: p.college,
    yearsExp: p.years_exp,
    jerseyNumber: p.number,
    active: p.active ?? true,
    status: p.status,
    searchRank: typeof p.search_rank === 'number' && p.search_rank < 9999999 ? p.search_rank : null,
    injuryStatus: p.injury_status,
    injuryBodyPart: p.injury_body_part,
    injuryNotes: p.injury_notes,
    depthChartPosition: p.depth_chart_position,
    depthChartOrder: p.depth_chart_order,
    rawJson: writeJson(p),
  };
}

const NFL_TEAM_SET = new Set(NFL_TEAMS.map((t) => t.id));
