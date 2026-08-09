import './_env';
import { prisma } from '../src/lib/db';

/**
 * Shared plumbing for the CLI scripts: consistent output, argument parsing and
 * a guaranteed database disconnect so a script never hangs the terminal.
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export const log = {
  title: (msg: string) => console.log(`\n${COLOURS.bold}${COLOURS.cyan}${msg}${COLOURS.reset}`),
  step: (msg: string) => console.log(`${COLOURS.dim}  ${msg}${COLOURS.reset}`),
  ok: (msg: string) => console.log(`${COLOURS.green}  ✓ ${msg}${COLOURS.reset}`),
  warn: (msg: string) => console.log(`${COLOURS.yellow}  ! ${msg}${COLOURS.reset}`),
  fail: (msg: string) => console.log(`${COLOURS.red}  ✗ ${msg}${COLOURS.reset}`),
  plain: (msg: string) => console.log(`  ${msg}`),
};

/** Parse `--key value` and `--flag` style arguments. */
export function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Wraps a script body. Disconnects Prisma and sets a non-zero exit code on
 * failure so these can be chained in a shell without silently continuing.
 */
export async function main(fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    log.plain(`\n${COLOURS.dim}Done in ${((Date.now() - started) / 1000).toFixed(1)}s${COLOURS.reset}`);
  } catch (error) {
    log.fail(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

/** Resolve the league id from --league, .env, or the primary league in the DB. */
export async function resolveLeagueId(explicit?: string | boolean): Promise<string> {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (process.env.SLEEPER_LEAGUE_ID) return process.env.SLEEPER_LEAGUE_ID;

  const primary = await prisma.league.findFirst({ where: { isPrimary: true } });
  if (primary) return primary.id;

  const any = await prisma.league.findFirst();
  if (any) return any.id;

  throw new Error(
    'No league configured. Pass --league <id>, set SLEEPER_LEAGUE_ID in .env, or run `npm run setup` first.\n' +
      '  Find your league id in the Sleeper URL: https://sleeper.com/leagues/<THIS_NUMBER>/team',
  );
}

export async function resolveSeason(explicit?: string | boolean): Promise<string> {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (process.env.SEASON) return process.env.SEASON;

  const { sleeper } = await import('../src/lib/providers/sleeper');
  try {
    const state = await sleeper.getState();
    return state.season;
  } catch {
    return new Date().getFullYear().toString();
  }
}
