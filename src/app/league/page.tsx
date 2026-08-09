import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { leagueChain } from '@/lib/sync/market';
import { readJson } from '@/lib/json';
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
import { PosBadge } from '@/components/player-bits';
import { syncNow } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * League intelligence: how these specific managers draft.
 *
 * This is the part a generic tool can't do. Knowing that one manager reaches
 * two rounds early on quarterbacks and another never takes a tight end before
 * round ten changes which players you can afford to wait on.
 */
export default async function LeaguePage() {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    return <EmptyState title="No league configured" description="Set your league id on the Settings page." />;
  }

  const chain = await leagueChain(cfg.leagueId);

  const [league, profiles, drafts, transactions] = await Promise.all([
    prisma.league.findUniqueOrThrow({ where: { id: cfg.leagueId } }),
    prisma.managerProfile.findMany({
      where: { leagueId: cfg.leagueId },
      include: { member: { select: { displayName: true, teamName: true, isMe: true } } },
      orderBy: { sampleSize: 'desc' },
    }),
    prisma.draft.findMany({
      where: { leagueId: { in: chain } },
      orderBy: { season: 'desc' },
      include: { _count: { select: { picks: true } } },
    }),
    prisma.leagueTransaction.count({ where: { leagueId: { in: chain } } }),
  ]);

  const recentDraft = drafts.find((d) => d.status === 'complete') ?? null;
  const recentPicks = recentDraft
    ? await prisma.draftPick.findMany({
        where: { draftId: recentDraft.id, playerId: { not: null } },
        orderBy: { pickNo: 'asc' },
        take: 30,
        include: {
          player: { select: { fullName: true, position: true } },
          member: { select: { displayName: true } },
        },
      })
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{league.name}</h1>
          <p className="text-sm text-muted-foreground">
            {chain.length} season{chain.length === 1 ? '' : 's'} of history · {drafts.length} draft
            {drafts.length === 1 ? '' : 's'} · {transactions} transactions
          </p>
        </div>
        <ActionButton action={syncNow.bind(null, 'history')} variant="outline">
          Re-import history
        </ActionButton>
      </div>

      {/* --- Manager tendencies -------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Manager tendencies</CardTitle>
          <CardDescription>
            Built from every completed draft in the league chain. Reach is versus this league&apos;s own ADP — negative
            means they let players fall to them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {profiles.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Manager</th>
                    <th className="pb-2 pr-3 text-right font-medium">Reach vs ADP</th>
                    <th className="pb-2 pr-3 font-medium">QB</th>
                    <th className="pb-2 pr-3 font-medium">TE</th>
                    <th className="pb-2 pr-3 text-right font-medium">Early RB</th>
                    <th className="pb-2 pr-3 text-right font-medium">Early WR</th>
                    <th className="pb-2 pr-3 text-right font-medium">Predictable</th>
                    <th className="pb-2 text-right font-medium">Picks</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => {
                    const detail = readJson<{ favouriteNflTeam?: string | null; draftsSampled?: number }>(
                      p.detailJson,
                      {},
                    );
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{p.member.displayName}</span>
                            {p.member.isMe ? <Badge variant="secondary">you</Badge> : null}
                            {(p.homerScore ?? 0) > 0.25 && detail.favouriteNflTeam ? (
                              <Badge variant="outline" className="text-[10px]">
                                {detail.favouriteNflTeam} homer
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="pr-3 text-right tabular">
                          <span
                            className={
                              (p.avgReachVsAdp ?? 0) < -3
                                ? 'text-rose-600 dark:text-rose-400'
                                : (p.avgReachVsAdp ?? 0) > 3
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : ''
                            }
                          >
                            {p.avgReachVsAdp !== null ? fmtSigned(p.avgReachVsAdp, 1) : '—'}
                          </span>
                        </td>
                        <td className="pr-3 text-xs capitalize text-muted-foreground">{p.qbTendency ?? '—'}</td>
                        <td className="pr-3 text-xs capitalize text-muted-foreground">{p.teTendency ?? '—'}</td>
                        <td className="pr-3 text-right tabular text-muted-foreground">
                          {p.rbShareEarly !== null ? `${(p.rbShareEarly * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="pr-3 text-right tabular text-muted-foreground">
                          {p.wrShareEarly !== null ? `${(p.wrShareEarly * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="pr-3 text-right tabular text-muted-foreground">
                          {p.predictabilityR2 !== null ? `${(p.predictabilityR2 * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="text-right tabular text-muted-foreground">{p.sampleSize}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="pt-3 text-xs text-muted-foreground">
                &ldquo;Predictable&rdquo; is how closely their picks track ADP. The mock simulator gives unpredictable
                managers wider noise, so your availability odds reflect who is actually picking ahead of you.
              </p>
            </div>
          ) : (
            <EmptyState
              title="No manager profiles yet"
              description="These are built from completed drafts. Import history first."
              action={
                <ActionButton action={syncNow.bind(null, 'history')} variant="outline">
                  Import history
                </ActionButton>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* --- Drafts -------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Draft history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-accent/50">
                <div className="flex items-center gap-3">
                  <span className="font-medium tabular">{d.season}</span>
                  <span className="text-xs text-muted-foreground">
                    {d.type} · {d.rounds} rounds · {d.teams} teams
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular text-muted-foreground">{d._count.picks} picks</span>
                  <Badge variant={d.status === 'complete' ? 'outline' : 'secondary'}>{d.status}</Badge>
                </div>
              </div>
            ))}
            {!drafts.length ? <p className="text-sm text-muted-foreground">No drafts imported.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{recentDraft ? `${recentDraft.season} first rounds` : 'Recent draft'}</CardTitle>
            <CardDescription>How the board actually fell last time.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[420px] space-y-0.5 overflow-y-auto thin-scroll">
            {recentPicks.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
                <span className="w-10 shrink-0 text-xs tabular text-muted-foreground">
                  {pickLabel(p.pickNo, recentDraft?.teams ?? 10)}
                </span>
                <PosBadge position={p.player?.position ?? '?'} />
                <span className="truncate">{p.player?.fullName}</span>
                <span className="ml-auto max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">
                  {p.member?.displayName ?? '—'}
                </span>
                {p.isKeeper ? (
                  <Badge variant="outline" className="text-[10px]">
                    kept
                  </Badge>
                ) : null}
              </div>
            ))}
            {!recentPicks.length ? (
              <p className="text-sm text-muted-foreground">No completed draft to show.</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
