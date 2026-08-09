import { prisma } from '../db';
import {
  nflverse,
  identityKey,
  nameposKey,
  num,
  int,
  text,
  draftCapitalScore,
  speedScore,
  athleticScore,
  type NflversePlayerRow,
  type NflverseCombineRow,
} from '../providers/nflverse';
import { withSyncRun, type SyncResult } from './runner';

/**
 * Build PlayerProfile rows: draft capital, combine athleticism and college
 * background, joined from nflverse onto our Sleeper-keyed players.
 *
 * Match strategy, chosen by measurement rather than assumption:
 *   1. name + birth date  — resolves ~99% of the top 100 (confidence 1.0)
 *   2. name + position    — fallback, mostly current-year rookies (0.8)
 *
 * Combine data keys on `pfr_id`, not gsis, so it joins through the player row
 * we just matched. Where a player has no combine workout at all we still write
 * the profile: draft capital alone is the more predictive half.
 */
export async function syncPlayerProfiles(): Promise<SyncResult> {
  return withSyncRun({ provider: 'nflverse', job: 'profiles' }, async () => {
    const [nflPlayers, combine] = await Promise.all([nflverse.players(), nflverse.combine()]);

    // --- Index nflverse by both join keys --------------------------------
    const byIdentity = new Map<string, NflversePlayerRow>();
    const byNamePos = new Map<string, NflversePlayerRow[]>();

    for (const row of nflPlayers) {
      const idKey = identityKey(row.display_name, row.birth_date);
      if (idKey && !byIdentity.has(idKey)) byIdentity.set(idKey, row);

      const npKey = nameposKey(row.display_name, row.position);
      if (npKey) {
        const list = byNamePos.get(npKey) ?? [];
        list.push(row);
        byNamePos.set(npKey, list);
      }
    }

    // Combine rows key on pfr_id; a player can appear once.
    const combineByPfr = new Map<string, NflverseCombineRow>();
    for (const c of combine) {
      const pfr = text(c.pfr_id);
      if (pfr && !combineByPfr.has(pfr)) combineByPfr.set(pfr, c);
    }

    // --- Walk our players -------------------------------------------------
    const ourPlayers = await prisma.player.findMany({
      where: { position: { in: ['QB', 'RB', 'WR', 'TE'] } },
      select: { id: true, fullName: true, position: true, birthDate: true, searchRank: true },
    });

    let matched = 0;
    let byBirth = 0;
    let byName = 0;
    let withDraft = 0;
    let withCombine = 0;
    const unmatched: string[] = [];

    for (const p of ourPlayers) {
      let row: NflversePlayerRow | undefined;
      let confidence = 0;

      const idKey = identityKey(p.fullName, p.birthDate);
      if (idKey) {
        row = byIdentity.get(idKey);
        if (row) {
          confidence = 1;
          byBirth += 1;
        }
      }

      if (!row) {
        const npKey = nameposKey(p.fullName, p.position);
        const candidates = npKey ? byNamePos.get(npKey) : undefined;
        // Only accept a name+position match when it is unambiguous — two
        // active players sharing a normalised name is rare but real, and
        // guessing silently attaches the wrong draft capital.
        if (candidates && candidates.length === 1) {
          row = candidates[0];
          confidence = 0.8;
          byName += 1;
        }
      }

      if (!row) {
        // Only worth reporting for players anyone might actually draft.
        if (p.searchRank !== null && p.searchRank < 400) unmatched.push(p.fullName);
        continue;
      }

      matched += 1;

      const draftRound = int(row.draft_round);
      const draftPick = int(row.draft_pick);
      const draftYear = int(row.draft_year);
      // nflverse gives round + pick-within-round, not overall. Approximate
      // overall from a 32-pick round; exact enough for a decay curve.
      const draftOverall =
        draftRound !== null && draftPick !== null ? (draftRound - 1) * 32 + draftPick : null;
      if (draftRound !== null) withDraft += 1;

      const pfr = text(row.pfr_id);
      const c = pfr ? combineByPfr.get(pfr) : undefined;
      if (c) withCombine += 1;

      const weightLb = num(row.weight) ?? num(c?.wt ?? null);
      const forty = num(c?.forty ?? null);

      const athletic = athleticScore({
        position: p.position,
        forty,
        vertical: num(c?.vertical ?? null),
        broadJump: num(c?.broad_jump ?? null),
        threeCone: num(c?.cone ?? null),
        shuttle: num(c?.shuttle ?? null),
        weightLb,
      });

      const rookieSeason = int(row.rookie_season);
      const birth = p.birthDate ?? text(row.birth_date);
      const entryAge =
        rookieSeason && birth
          ? Math.round(
              ((new Date(`${rookieSeason}-09-01`).getTime() - new Date(birth).getTime()) /
                (365.25 * 24 * 3600 * 1000)) *
                10,
            ) / 10
          : null;

      const data = {
        gsisId: text(row.gsis_id),
        pfrId: pfr,
        espnId: text(row.espn_id),
        draftYear,
        draftRound,
        draftPick,
        draftOverall,
        draftTeam: text(row.draft_team),
        isUdfa: draftRound === null,
        draftCapitalScore: draftCapitalScore(draftOverall),
        heightIn: num(row.height),
        weightLb,
        fortyYard: forty,
        benchReps: int(c?.bench ?? null),
        vertical: num(c?.vertical ?? null),
        broadJump: num(c?.broad_jump ?? null),
        threeCone: num(c?.cone ?? null),
        shuttle: num(c?.shuttle ?? null),
        speedScore: speedScore(weightLb, forty),
        athleticScore: athletic.score,
        athleticSampleSize: athletic.sampleSize,
        collegeName: text(row.college_name),
        collegeConference: text(row.college_conference),
        rookieSeason,
        entryAge,
        source: 'nflverse',
        matchConfidence: confidence,
        computedAt: new Date(),
      };

      await prisma.playerProfile.upsert({
        where: { playerId: p.id },
        create: { playerId: p.id, ...data },
        update: data,
      });

      // Record the resolved ids so future joins are exact rather than fuzzy.
      const gsis = text(row.gsis_id);
      if (gsis) {
        await prisma.playerExternalId
          .upsert({
            where: { source_externalId: { source: 'nflverse', externalId: gsis } },
            create: { source: 'nflverse', externalId: gsis, playerId: p.id, confidence },
            update: { playerId: p.id, confidence },
          })
          .catch(() => {
            // Another player already claimed this id — leave the first match.
          });
      }
    }

    return {
      recordsIn: ourPlayers.length,
      recordsWritten: matched,
      partial: unmatched.length > 0,
      detail: {
        matchedByBirthDate: byBirth,
        matchedByNamePosition: byName,
        withDraftCapital: withDraft,
        withCombineWorkout: withCombine,
        unmatchedRelevant: unmatched.slice(0, 40),
        unmatchedRelevantCount: unmatched.length,
      },
    };
  });
}
