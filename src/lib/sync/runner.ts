import { prisma } from '../db';
import { writeJson } from '../json';

/**
 * Every sync is wrapped in a SyncRun row. On draft day the first question when
 * something looks wrong is always "did the sync actually work, and when" — this
 * makes that answerable from the UI instead of from a terminal scrollback.
 */

export interface SyncResult {
  recordsIn: number;
  recordsWritten: number;
  detail?: unknown;
  /** Set when the job partially succeeded — e.g. some CSV rows unresolved. */
  partial?: boolean;
}

export async function withSyncRun<T extends SyncResult>(
  args: { provider: string; job: string; season?: string; week?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const run = await prisma.syncRun.create({
    data: {
      provider: args.provider,
      job: args.job,
      season: args.season,
      week: args.week,
      status: 'RUNNING',
    },
  });

  try {
    const result = await fn();
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: result.partial ? 'PARTIAL' : 'SUCCESS',
        recordsIn: result.recordsIn,
        recordsWritten: result.recordsWritten,
        detailJson: writeJson(result.detail),
        finishedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        finishedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function lastSuccessfulRun(provider: string, job: string) {
  return prisma.syncRun.findFirst({
    where: { provider, job, status: { in: ['SUCCESS', 'PARTIAL'] } },
    orderBy: { startedAt: 'desc' },
  });
}
