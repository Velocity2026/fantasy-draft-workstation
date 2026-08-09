import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { EVIDENCE_TYPE_LABELS, type EvidenceType } from '@/lib/enums';
import { relativeTime } from '@/lib/utils';
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
import { deleteEvidence } from '../actions';
import { EvidenceForm } from './evidence-form';

export const dynamic = 'force-dynamic';

/**
 * Research log.
 *
 * Everything here is Evidence — the same table the waiver, breakout and
 * start/sit modules will read from later. Camp reports and beat notes logged
 * now become training signal for those modules rather than being thrown away
 * after the draft.
 */
export default async function ResearchPage() {
  const cfg = await getConfig();

  const [evidence, players, teams, sources] = await Promise.all([
    prisma.evidence.findMany({
      orderBy: [{ isPinned: 'desc' }, { observedAt: 'desc' }],
      take: 120,
      include: { player: { select: { fullName: true, position: true, teamId: true } } },
    }),
    prisma.player.findMany({
      where: { active: true, position: { in: ['QB', 'RB', 'WR', 'TE'] } },
      select: { id: true, fullName: true, position: true, teamId: true },
      orderBy: { fullName: 'asc' },
      take: 900,
    }),
    prisma.nflTeam.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } }),
    prisma.dataSource.findMany({
      where: { enabled: true },
      select: { key: true, label: true, trust: true },
      orderBy: { label: 'asc' },
    }),
  ]);

  const impactVariant = (impact: string) =>
    impact === 'HIGH' ? 'destructive' : impact === 'MEDIUM' ? 'warning' : 'outline';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Research</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Camp reports, beat notes, coach quotes and depth-chart moves. These aren&apos;t just notes — they&apos;re the
          evidence trail the in-season modules will read when they start flagging breakouts and waiver targets.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Log an observation</CardTitle>
          <CardDescription>
            If you name a registered source, its trust rating becomes the default confidence on this note.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EvidenceForm
            players={players.map((p) => ({ id: p.id, name: p.fullName, position: p.position, team: p.teamId }))}
            teams={teams}
            sources={sources}
            season={cfg.season}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>{evidence.length} most recent observations.</CardDescription>
        </CardHeader>
        <CardContent>
          {evidence.length ? (
            <div className="space-y-2">
              {evidence.map((e) => (
                <div key={e.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {e.player ? (
                          <>
                            <span className="font-medium">{e.player.fullName}</span>
                            <PosBadge position={e.player.position} />
                          </>
                        ) : (
                          <span className="font-medium">{e.teamId ?? 'League'}</span>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {EVIDENCE_TYPE_LABELS[e.evidenceType as EvidenceType] ?? e.evidenceType}
                        </Badge>
                        <Badge variant={impactVariant(e.impact)} className="text-[10px]">
                          {e.impact.toLowerCase()} impact
                        </Badge>
                        {e.sentiment !== 0 ? (
                          <span
                            className={
                              e.sentiment > 0
                                ? 'text-xs text-emerald-600 dark:text-emerald-400'
                                : 'text-xs text-rose-600 dark:text-rose-400'
                            }
                          >
                            {e.sentiment > 0 ? 'positive' : 'negative'}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm">{e.headline}</p>
                      {e.body ? <p className="mt-1 text-sm text-muted-foreground">{e.body}</p> : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {e.sourceName ? <span>{e.sourceName}</span> : null}
                        <span>confidence {(e.confidence * 100).toFixed(0)}%</span>
                        <span>{relativeTime(e.observedAt)}</span>
                        {e.sourceUrl ? (
                          <a href={e.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                            link
                          </a>
                        ) : null}
                      </div>
                    </div>
                    <ActionButton
                      action={deleteEvidence.bind(null, e.id)}
                      variant="ghost"
                      size="sm"
                      messageClassName="hidden"
                    >
                      Delete
                    </ActionButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Nothing logged yet"
              description="Add what you're hearing about camp battles, role changes and injuries. It compounds over the season."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
