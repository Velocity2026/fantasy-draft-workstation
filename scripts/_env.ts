/**
 * Minimal .env loader for CLI scripts.
 *
 * Next.js loads .env automatically, but standalone `tsx` scripts do not, and
 * PrismaClient reads DATABASE_URL straight from process.env. Rather than add a
 * dependency for twenty lines, this parses the file directly. Import it first
 * in every script.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');

if (existsSync(envPath)) {
  const contents = readFileSync(envPath, 'utf8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Real environment variables always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export {};
