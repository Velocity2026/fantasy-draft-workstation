import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getActiveRun, loadBoard } from '@/lib/valuation/engine';
import { readJson } from '@/lib/json';
import { relativeTime } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Badge } from '@/components/ui/primitives';
import { ActionButton } from '@/components/action-button';
import { runValuationNow } from '../actions';
import { BoardTable } from './board-table';

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    return (
      <EmptyState
        title="No league configured"
        description="Set your Sleeper league id on the Settings page, then build a board."
      />
    );
  }

  const activeRun = await getActiveRun(cfg.leagueId, cfg.season, 'DRAFT');
  if (!activeRun) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
        <EmptyState
          title="No board built yet"
          description="The valuation engine turns projections into VORP, tiers and auction values for your specific league settings."
          action={<ActionButton action={runValuationNow}>Build board</ActionButton>}
        />
      </div>
    );
  }

  const [board, overrides, keepers] = await Promise.all([
    loadBoard(activeRun.id),
    prisma.boardEntry.findMany({ where: { leagueId: cfg.leagueId, season: cfg.season } }),
    prisma.keeperDeclaration.findMany({
      where: { leagueId: cfg.leagueId, season: cfg.season },
      select: { playerId: true },
    }),
  ]);

  const params = readJson<{
    replacementPoints?: Record<string, number>;
    replacementMethod?: string;
    projectionWeights?: Record<string, number>;
  }>(activeRun.paramsJson, {});

  const baselineCount = board.filter((b) => b.isBaseline).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
          <p className="text-sm text-muted-foreground">
            {board.length} players valued {relativeTime(activeRun.createdAt)} ·{' '}
            {params.replacementMethod ?? 'BLENDED'} replacement ·{' '}
            {Object.entries(params.projectionWeights ?? {})
              .map(([k, v]) => `${k}×${v}`)
              .join(' ')}
          </p>
        </div>
        <ActionButton action={runValuationNow}>Rebuild board</ActionButton>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(params.replacementPoints ?? {}).map(([pos, pts]) => (
          <Card key={pos}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {pos} replacement
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular">{pts.toFixed(0)}</div>
              <p className="text-xs text-muted-foreground">points — the bar every {pos} is measured against</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {baselineCount > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <Badge variant="warning" className="mr-2">
            {baselineCount} estimated
          </Badge>
          These players have no imported projection and use the fallback rank curve. They&apos;re marked{' '}
          <span className="font-medium text-amber-600 dark:text-amber-500">est</span> below. Import projections on the
          Sources page for real numbers.
        </div>
      ) : null}

      <BoardTable
        rows={board}
        overrides={overrides.map((o) => ({
          playerId: o.playerId,
          userRank: o.userRank,
          userTier: o.userTier,
          targetRound: o.targetRound,
          status: o.status,
          note: o.note,
          isDoNotDraft: o.isDoNotDraft,
        }))}
        keeperIds={keepers.map((k) => k.playerId)}
      />
    </div>
  );
}
