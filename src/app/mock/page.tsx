import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getActiveRun } from '@/lib/valuation/engine';
import { readJson } from '@/lib/json';
import { fmt, pickLabel, relativeTime, snakePickNo } from '@/lib/utils';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@/components/ui/primitives';
import { ActionButton } from '@/components/action-button';
import { PosBadge } from '@/components/player-bits';
import { deleteMock, runValuationNow } from '../actions';
import { MockForm } from './mock-form';

export const dynamic = 'force-dynamic';

export default async function MockPage() {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    return <EmptyState title="No league configured" description="Set your league id on the Settings page." />;
  }

  const activeRun = await getActiveRun(cfg.leagueId, cfg.season, 'DRAFT');
  if (!activeRun) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Mock drafts</h1>
        <EmptyState
          title="Build a board first"
          description="The simulator needs player values to decide what anyone would take."
          action={<ActionButton action={runValuationNow}>Build board</ActionButton>}
        />
      </div>
    );
  }

  const [league, draft, mocks] = await Promise.all([
    prisma.league.findUniqueOrThrow({ where: { id: cfg.leagueId } }),
    prisma.draft.findFirst({ where: { leagueId: cfg.leagueId, season: cfg.season }, orderBy: { createdAt: 'desc' } }),
    prisma.mockDraft.findMany({
      where: { leagueId: cfg.leagueId, season: cfg.season },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  const teams = draft?.teams || league.totalRosters;
  const latest = mocks[0] ?? null;

  const availability = latest
    ? await prisma.mockAvailability.findMany({
        where: { mockDraftId: latest.id },
        include: { player: { select: { fullName: true, position: true, teamId: true } } },
        orderBy: [{ pickNo: 'asc' }, { availabilityPct: 'desc' }],
      })
    : [];

  // Group availability by my pick number so the page answers "who's likely to
  // be there at 2.07" rather than dumping a flat list.
  const byPick = new Map<number, typeof availability>();
  for (const row of availability) {
    const list = byPick.get(row.pickNo) ?? [];
    if (list.length < 12) list.push(row);
    byPick.set(row.pickNo, list);
  }

  const summary = latest
    ? readJson<{
        avgStartingPoints?: number;
        p10StartingPoints?: number;
        p90StartingPoints?: number;
        positionCounts?: Record<string, number>;
        mostCommonByRound?: { round: number; name: string; pct: number }[];
      }>(latest.summaryJson, {})
    : {};

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mock drafts</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Runs the draft hundreds of times with realistic opponents to answer the question that actually matters: if
          you take a receiver now, will your running back still be there next time around?
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run a simulation</CardTitle>
          <CardDescription>
            Opponents pick from ADP with noise plus roster need. Managers whose past drafts track ADP closely get less
            noise, so the model reflects how these ten actually behave.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockForm
            defaultSlot={cfg.myDraftSlot ?? 1}
            teams={teams}
            defaultRounds={draft?.rounds || 15}
          />
        </CardContent>
      </Card>

      {latest ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Average outcome"
              value={fmt(summary.avgStartingPoints, 0)}
              hint="starting-lineup VORP"
            />
            <Stat
              label="Bad run (10th pct)"
              value={fmt(summary.p10StartingPoints, 0)}
              hint="when the board breaks against you"
            />
            <Stat
              label="Good run (90th pct)"
              value={fmt(summary.p90StartingPoints, 0)}
              hint="when it falls your way"
            />
            <Stat label="Iterations" value={String(latest.iterations)} hint={latest.strategy.replace('_', ' ')} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Who&apos;s likely to be there</CardTitle>
              <CardDescription>
                Chance each player is still on the board when your pick comes around, from slot {latest.myDraftSlot}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {[...byPick.entries()].slice(0, 8).map(([pickNo, rows]) => (
                <div key={pickNo}>
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="text-sm font-semibold tabular">{pickLabel(pickNo, teams)}</span>
                    <span className="text-xs text-muted-foreground">pick {pickNo} overall</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {rows.map((r) => (
                      <div
                        key={`${pickNo}-${r.playerId}`}
                        className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                        title={`${r.player.fullName} — taken on average at pick ${r.avgPickTaken?.toFixed(0) ?? '—'}`}
                      >
                        <PosBadge position={r.player.position} />
                        <span className="max-w-[9rem] truncate">{r.player.fullName}</span>
                        <span
                          className={
                            r.availabilityPct > 0.66
                              ? 'font-medium tabular text-emerald-600 dark:text-emerald-400'
                              : r.availabilityPct > 0.33
                                ? 'font-medium tabular text-amber-600 dark:text-amber-500'
                                : 'font-medium tabular text-rose-600 dark:text-rose-400'
                          }
                        >
                          {Math.round(r.availabilityPct * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {summary.mostCommonByRound?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Most common pick by round</CardTitle>
                <CardDescription>Who this strategy lands on most often from that slot.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {summary.mostCommonByRound.map((r) => (
                    <div key={r.round} className="rounded-md border px-2.5 py-1.5 text-sm">
                      <span className="mr-2 text-xs tabular text-muted-foreground">R{r.round}</span>
                      <span>{r.name}</span>
                      <span className="ml-2 text-xs tabular text-muted-foreground">
                        {Math.round(r.pct * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      {mocks.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Saved runs</CardTitle>
            <CardDescription>Compare strategies by their average and downside outcome.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {mocks.map((m) => {
              const s = readJson<{ avgStartingPoints?: number; p10StartingPoints?: number }>(m.summaryJson, {});
              return (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-accent/50">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    <Badge variant="outline">{m.strategy.replace('_', ' ').toLowerCase()}</Badge>
                    <span className="text-xs text-muted-foreground tabular">
                      slot {m.myDraftSlot} · {m.iterations} runs · pick{' '}
                      {pickLabel(snakePickNo(1, m.myDraftSlot, m.teams), m.teams)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular">
                      avg <strong>{fmt(s.avgStartingPoints, 0)}</strong>
                    </span>
                    <span className="text-xs tabular text-muted-foreground">
                      floor {fmt(s.p10StartingPoints, 0)}
                    </span>
                    <span className="text-xs text-muted-foreground">{relativeTime(m.createdAt)}</span>
                    <ActionButton action={() => deleteMock(m.id)} variant="ghost" size="sm" messageClassName="hidden">
                      Delete
                    </ActionButton>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold tabular">{value}</div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
