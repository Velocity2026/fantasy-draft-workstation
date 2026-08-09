import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { NFL_TEAMS } from '../data/nfl-teams';
import { sleeper, normalisePosition, parseHeightInches, type SleeperPlayer } from '../providers/sleeper';
import { POSITIONS } from '../enums';
import { normaliseName } from '../utils';
import { writeJson } from '../json';
import { getConfig } from '../config';
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

    // Snapshot the state each player was in BEFORE this sync overwrites it.
    // Depth-chart order and injury status are otherwise upserted in place —
    // every prior value is silently lost the moment a new one arrives, which
    // is exactly the history a "why is he rising" report needs. This starts
    // capturing from whenever this code first runs; Sleeper only exposes
    // current state, so there is nothing to backfill retroactively.
    const before = new Map(
      (
        await prisma.player.findMany({
          where: { id: { in: keep.map((p) => p.player_id) } },
          select: { id: true, depthChartOrder: true, depthChartPosition: true, injuryStatus: true },
        })
      ).map((p) => [p.id, p]),
    );

    const season = (await getConfig()).season;
    const now = new Date();

    let written = 0;
    let depthChartEvents = 0;
    let injuryEvents = 0;

    // Chunked to keep a single SQLite transaction from getting unreasonably
    // long; ~1,500 upserts is fast but not instant.
    const CHUNK = 250;
    for (let i = 0; i < keep.length; i += CHUNK) {
      const chunk = keep.slice(i, i + CHUNK);
      const ops: Prisma.PrismaPromise<unknown>[] = [];

      for (const p of chunk) {
        const data = toPlayerData(p);
        ops.push(
          prisma.player.upsert({
            where: { id: p.player_id },
            create: { id: p.player_id, ...data },
            update: data,
          }),
        );

        const prior = before.get(p.player_id);

        // Depth-chart move: needs a real rank to write (the column is
        // non-nullable) and a team to satisfy the FK, so a player dropping
        // off the chart entirely is not representable here — only entering
        // or moving within one is.
        if (
          data.depthChartOrder !== null &&
          data.teamId &&
          (prior?.depthChartOrder !== data.depthChartOrder || prior?.depthChartPosition !== data.depthChartPosition)
        ) {
          ops.push(
            prisma.depthChartEntry.create({
              data: {
                teamId: data.teamId,
                playerId: p.player_id,
                position: data.position,
                rank: data.depthChartOrder,
                source: 'sleeper',
                season,
                effectiveAt: now,
              },
            }),
          );
          depthChartEvents += 1;
        }

        // Injury status change, including a change back to healthy (null) —
        // that transition matters as much as the injury itself.
        if (prior && prior.injuryStatus !== data.injuryStatus) {
          ops.push(
            prisma.injuryReport.create({
              data: {
                playerId: p.player_id,
                teamId: data.teamId,
                season,
                status: data.injuryStatus,
                bodyPart: data.injuryBodyPart,
                note: data.injuryNotes,
                source: 'sleeper',
                reportedAt: now,
              },
            }),
          );
          injuryEvents += 1;
        }
      }

      await prisma.$transaction(ops);
      written += chunk.length;
    }

    // Sleeper ids are our canonical ids, but record them explicitly so the
    // resolver's "source = sleeper" path works uniformly with other providers.
    return {
      recordsIn: entries.length,
      recordsWritten: written,
      detail: {
        keptPositions: [...RELEVANT],
        discarded: entries.length - keep.length,
        depthChartEvents,
        injuryEvents,
      },
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
    // Explicit `?? null` rather than leaving these `undefined`: Prisma treats
    // an undefined field as "omit from the update", not "clear it", so a
    // player Sleeper stops reporting an injury/depth-chart value for would
    // otherwise keep his last stored value forever.
    injuryStatus: p.injury_status ?? null,
    injuryBodyPart: p.injury_body_part ?? null,
    injuryNotes: p.injury_notes ?? null,
    depthChartPosition: p.depth_chart_position ?? null,
    depthChartOrder: typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null,
    rawJson: writeJson(p),
  };
}

const NFL_TEAM_SET = new Set(NFL_TEAMS.map((t) => t.id));
