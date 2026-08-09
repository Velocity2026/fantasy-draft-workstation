import { args, log, main, resolveSeason } from './_cli';
import { sleeper } from '../src/lib/providers/sleeper';

/**
 * Find a league id from a public Sleeper username.
 *
 * Sleeper's read API needs no authentication, so this only ever uses your
 * public username — never a password. It exists so setup doesn't require
 * digging a league id out of a browser URL.
 *
 *   npx tsx scripts/find-league.ts --username craig
 *   npx tsx scripts/find-league.ts --username craig --season 2025
 */
main(async () => {
  const a = args();
  const username = typeof a.username === 'string' ? a.username : process.env.SLEEPER_USERNAME;

  if (!username) {
    throw new Error('Pass --username <your public Sleeper username>, or set SLEEPER_USERNAME in .env');
  }

  const season = await resolveSeason(a.season);
  log.title(`Looking up leagues for "${username}" (${season})`);

  // Sleeper answers 200 with a `null` body for an unknown username rather than
  // returning 404, so a try/catch alone would let the null through.
  let user;
  try {
    user = await sleeper.getUserByName(username);
  } catch {
    user = null;
  }
  if (!user?.user_id) {
    throw new Error(
      `Sleeper has no user called "${username}". Check the spelling — it's the username other managers see, not an email address.`,
    );
  }

  log.ok(`Found ${user.display_name} (user id ${user.user_id})`);

  const leagues = await sleeper.getUserLeagues(user.user_id, season);

  if (!leagues.length) {
    log.warn(`No ${season} leagues found for this user.`);
    log.plain('  If your league is for a different season, try --season 2024.');
    return;
  }

  log.plain('');
  for (const league of leagues) {
    const keeper = (league.settings?.max_keepers ?? 0) > 0;
    const ppr = league.scoring_settings?.rec ?? 0;
    const scoring = ppr >= 1 ? 'full PPR' : ppr >= 0.4 ? 'half PPR' : 'standard';

    log.plain(`  ${league.name}`);
    log.plain(`    league id : ${league.league_id}`);
    log.plain(`    format    : ${league.total_rosters} teams, ${scoring}${keeper ? ', keeper' : ''}`);
    log.plain(`    status    : ${league.status}`);
    log.plain('');
  }

  log.plain('Put the league id you want into .env as SLEEPER_LEAGUE_ID, then run `npm run setup`.');
});
