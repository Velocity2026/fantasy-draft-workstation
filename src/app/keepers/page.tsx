import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getActiveRun, loadBoard } from '@/lib/valuation/engine';
import { evaluateAllKeepers } from '@/lib/valuation/keeper';
import { fmt, fmtSigned, pickLabel } from '@/lib/utils';
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
import { PosBadge, TierChip } from '@/components/player-bits';
import { importKeepersFromLastDraft, removeKeeper, runValuationNow } from '../actions';
import { KeeperForm } from './keeper-form';

export const dynamic = 'force-dynamic';

const VERDICT_STYLE: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  KEEP: { label: 'Keep', variant: 'success' },
  LEAN_KEEP: { label: 'Lean keep', variant: 'success' },
  MARGINAL: { label: 'Marginal', variant: 'secondary' },
  LEAN_CUT: { label: 'Lean cut', variant: 'warning' },
  CUT: { label: 'Cut', variant: 'destructive' },
};

export default async function KeepersPage() {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    return <EmptyState title="No league configured" description="Set your league id on the Settings page." />;
  }

  const league = await prisma.league.findUnique({ where: { id: cfg.leagueId } });
  const activeRun = await getActiveRun(cfg.leagueId, cfg.season, 'DRAFT');

  if (!activeRun) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Keepers</h1>
        <EmptyState
          title="Build a board first"
          description="Keeper value is measured against what that draft pick would otherwise return, so the board has to exist."
          action={<ActionButton action={runValuationNow}>Build board</ActionButton>}
        />
      </div>
    );
  }

  const teams = league?.totalRosters ?? 10;
  const board = await loadBoard(activeRun.id);
  const evaluations = await evaluateAllKeepers({
    leagueId: cfg.leagueId,
    season: cfg.season,
    board,
    teams,
  });

  const rosters = await prisma.leagueRoster.findMany({
    where: { leagueId: cfg.leagueId },
    include: { member: { select: { displayName: true, isMe: true } } },
    orderBy: { rosterId: 'asc' },
  });

  const keeperRows = await prisma.keeperDeclaration.findMany({
    where: { leagueId: cfg.leagueId, season: cfg.season },
    include: { player: { select: { fullName: true } } },
  });
  const rosterByPlayer = new Map(keeperRows.map((k) => [k.playerId, k.rosterId]));
  const myRosterId = rosters.find((r) => r.member?.isMe)?.rosterId ?? null;

  const mine = evaluations.filter((e) => rosterByPlayer.get(e.playerId) === myRosterId);
  const others = evaluations.filter((e) => rosterByPlayer.get(e.playerId) !== myRosterId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Keepers</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The only question that matters is whether a player is worth more than the pick he costs. A great player at
            a first-round price is worth nothing in surplus terms.
          </p>
        </div>
        <ActionButton action={importKeepersFromLastDraft} variant="outline">
          Import from Sleeper
        </ActionButton>
      </div>

      {mine.length ? <KeeperTable title="Your keepers" rows={mine} teams={teams} /> : null}
      {others.length ? <KeeperTable title="Other teams" rows={others} teams={teams} muted /> : null}

      {!evaluations.length ? (
        <EmptyState
          title="No keepers declared"
          description={
            <>
              Add them below, or import from Sleeper if last season&apos;s draft recorded them. Keeper costs also
              remove picks from the{' '}
              <Link href="/draft" className="underline">
                draft room
              </Link>{' '}
              so your pick numbers stay correct.
            </>
          }
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Add or update a keeper</CardTitle>
          <CardDescription>
            Cost can be a round or an exact pick. A round-only cost is treated as the middle of that round.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <KeeperForm
            players={board.slice(0, 400).map((b) => ({
              id: b.playerId,
              name: b.fullName,
              position: b.position,
              team: b.teamId,
            }))}
            rosters={rosters.map((r) => ({
              rosterId: r.rosterId,
              name: r.member?.displayName ?? `Roster ${r.rosterId}`,
              isMe: r.member?.isMe ?? false,
            }))}
            existing={keeperRows.map((k) => ({
              playerId: k.playerId,
              name: k.player.fullName,
              rosterId: k.rosterId,
              costRound: k.costRound,
              costPickNo: k.costPickNo,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function KeeperTable({
  title,
  rows,
  teams,
  muted,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof evaluateAllKeepers>>;
  teams: number;
  muted?: boolean;
}) {
  return (
    <Card className={muted ? 'opacity-90' : undefined}>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((k) => {
          const style = VERDICT_STYLE[k.verdict];
          return (
            <div key={k.playerId} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.fullName}</span>
                    <PosBadge position={k.position} />
                    <TierChip tier={k.tier} />
                    <Badge variant={style.variant}>{style.label}</Badge>
                    {k.costPickNo ? (
                      <span className="text-xs text-muted-foreground tabular">
                        costs {pickLabel(k.costPickNo, teams)}
                      </span>
                    ) : null}
                  </div>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                    {k.reasoning.map((r, i) => (
                      <li key={i}>· {r}</li>
                    ))}
                  </ul>
                </div>

                <div className="flex shrink-0 items-start gap-4 text-right">
                  <div>
                    <div
                      className={
                        k.surplus > 0
                          ? 'text-lg font-semibold tabular text-emerald-600 dark:text-emerald-400'
                          : 'text-lg font-semibold tabular text-rose-600 dark:text-rose-400'
                      }
                    >
                      {fmtSigned(k.surplus, 0)}
                    </div>
                    <div className="text-[10px] uppercase text-muted-foreground">surplus</div>
                    {k.surplusInRounds !== null ? (
                      <div className="text-[10px] text-muted-foreground tabular">
                        ≈{fmtSigned(k.surplusInRounds, 1)} rounds
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <div className="text-sm tabular">{fmt(k.playerVorp, 0)}</div>
                    <div className="text-[10px] uppercase text-muted-foreground">his vorp</div>
                    <div className="text-[10px] text-muted-foreground tabular">pick {fmt(k.pickVorp, 0)}</div>
                  </div>
                  <ActionButton
                    action={() => removeKeeper(k.playerId)}
                    variant="ghost"
                    size="sm"
                    messageClassName="hidden"
                  >
                    Remove
                  </ActionButton>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
