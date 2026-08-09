import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { getActiveRun } from '@/lib/valuation/engine';
import { readJson } from '@/lib/json';
import { relativeTime } from '@/lib/utils';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Badge,
} from '@/components/ui/primitives';
import { ActionButton } from '@/components/action-button';
import { runValuationNow, syncNow } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Dashboard: is this thing ready to draft with, and if not, what's missing?
 * Every check links straight to the page that fixes it.
 */
export default async function DashboardPage() {
  const cfg = await getConfig();

  const league = cfg.leagueId ? await prisma.league.findUnique({ where: { id: cfg.leagueId } }) : null;

  const [playerCount, activeRun, drafts, sourceCount, lastSyncs, me, keeperCount, boardCount] = await Promise.all([
    prisma.player.count({ where: { active: true } }),
    league ? getActiveRun(league.id, cfg.season, 'DRAFT') : null,
    league
      ? prisma.draft.findMany({ where: { leagueId: league.id }, orderBy: { season: 'desc' }, take: 6 })
      : [],
    prisma.dataSource.count({ where: { enabled: true } }),
    prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 6 }),
    league ? prisma.leagueMember.findFirst({ where: { leagueId: league.id, isMe: true } }) : null,
    league
      ? prisma.keeperDeclaration.count({ where: { leagueId: league.id, season: cfg.season } })
      : 0,
    league ? prisma.boardEntry.count({ where: { leagueId: league.id, season: cfg.season } }) : 0,
  ]);

  const currentDraft = drafts.find((d) => d.season === cfg.season) ?? drafts[0] ?? null;
  const rosterPositions = readJson<string[]>(league?.rosterPositionsJson, []);

  const checks = [
    {
      label: 'Sleeper league imported',
      done: !!league,
      detail: league ? `${league.name} — ${league.totalRosters} teams, ${league.scoringType}` : 'Not configured',
      href: '/settings',
      cta: 'Set league id',
    },
    {
      label: 'Players synced',
      done: playerCount > 0,
      detail: playerCount > 0 ? `${playerCount.toLocaleString()} active players` : 'No players yet',
      href: '/settings',
      cta: 'Sync players',
    },
    {
      label: 'Your team identified',
      done: !!me,
      detail: me ? me.displayName : 'Unknown — recommendations need to know which roster is yours',
      href: '/settings',
      cta: 'Pick your team',
    },
    {
      label: 'Valuation run',
      done: !!activeRun,
      detail: activeRun
        ? `${activeRun.playerCount} players valued ${relativeTime(activeRun.createdAt)}`
        : 'No board built yet',
      href: '/board',
      cta: 'Build board',
    },
    {
      label: 'Projection sources',
      done: sourceCount > 0,
      detail: `${sourceCount} enabled`,
      href: '/sources',
      cta: 'Manage sources',
    },
  ];

  const ready = checks.every((c) => c.done);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {league ? league.name : 'Draft Workstation'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {league
              ? `${league.season} season · ${league.totalRosters} teams · ${league.scoringType}${league.isKeeper ? ' · keeper' : ''}`
              : 'Set up your league to get started'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton action={syncNow.bind(null, 'all')} variant="outline" size="sm">
            Sync now
          </ActionButton>
          <ActionButton action={runValuationNow} size="sm">
            Rebuild board
          </ActionButton>
        </div>
      </div>

      {/* --- Readiness ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Draft readiness</CardTitle>
            {ready ? <Badge variant="success">Ready</Badge> : <Badge variant="warning">Setup incomplete</Badge>}
          </div>
          <CardDescription>
            Everything below needs to be true before the draft room gives useful recommendations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {checks.map((check) => (
            <div
              key={check.label}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-accent/50"
            >
              <div className="flex items-center gap-3">
                <span
                  className={
                    check.done
                      ? 'grid h-5 w-5 place-items-center rounded-full bg-emerald-600/15 text-xs text-emerald-600 dark:text-emerald-400'
                      : 'grid h-5 w-5 place-items-center rounded-full bg-amber-500/15 text-xs text-amber-600 dark:text-amber-500'
                  }
                >
                  {check.done ? '✓' : '!'}
                </span>
                <div>
                  <div className="text-sm font-medium">{check.label}</div>
                  <div className="text-xs text-muted-foreground">{check.detail}</div>
                </div>
              </div>
              {!check.done ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={check.href}>{check.cta}</Link>
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- Draft ------------------------------------------------------ */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Drafts</CardTitle>
            <CardDescription>Live sync follows the draft marked active.</CardDescription>
          </CardHeader>
          <CardContent>
            {drafts.length ? (
              <div className="space-y-1">
                {drafts.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-accent/50">
                    <div className="flex items-center gap-3">
                      <span className="font-medium tabular">{d.season}</span>
                      <span className="text-muted-foreground">
                        {d.type} · {d.rounds} rounds · {d.teams} teams
                      </span>
                      {d.isPrimary ? <Badge variant="secondary">active</Badge> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={d.status === 'complete' ? 'outline' : d.status === 'drafting' ? 'success' : 'secondary'}>
                        {d.status}
                      </Badge>
                      {d.id === currentDraft?.id ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href="/draft">Open room</Link>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No drafts found"
                description="Sleeper creates the draft once the commissioner sets it up. Sync the league again after that."
                action={
                  <ActionButton action={syncNow.bind(null, 'league')} variant="outline" size="sm">
                    Sync league
                  </ActionButton>
                }
              />
            )}
          </CardContent>
        </Card>

        {/* --- League shape ----------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>League shape</CardTitle>
            <CardDescription>Drives replacement level and roster need.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {rosterPositions.length ? (
              <>
                <div className="flex flex-wrap gap-1">
                  {rosterPositions.map((pos, i) => (
                    <span key={`${pos}-${i}`} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                      {pos}
                    </span>
                  ))}
                </div>
                <div className="pt-2 text-xs text-muted-foreground">
                  {keeperCount} keeper{keeperCount === 1 ? '' : 's'} declared · {boardCount} board override
                  {boardCount === 1 ? '' : 's'}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Import the league to see its roster slots.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* --- Sync log ----------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Recent syncs</CardTitle>
          <CardDescription>
            When something looks stale mid-draft, this answers &ldquo;did it actually run?&rdquo;
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lastSyncs.length ? (
            <div className="space-y-1 text-sm">
              {lastSyncs.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-accent/50">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={s.status === 'SUCCESS' ? 'success' : s.status === 'FAILED' ? 'destructive' : 'warning'}
                      className="w-20 justify-center"
                    >
                      {s.status.toLowerCase()}
                    </Badge>
                    <span className="font-medium">{s.provider}</span>
                    <span className="text-muted-foreground">{s.job}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="tabular">{s.recordsWritten} written</span>
                    <span>{relativeTime(s.startedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing has run yet.</p>
          )}
          {lastSyncs.some((s) => s.status === 'FAILED') ? (
            <p className="pt-2 text-xs text-rose-600 dark:text-rose-400">
              {lastSyncs.find((s) => s.status === 'FAILED')?.error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
