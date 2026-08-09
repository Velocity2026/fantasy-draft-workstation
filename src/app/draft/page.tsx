import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { loadDraftRoomState } from '@/lib/draft/state';
import { Button, EmptyState, Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/primitives';
import { ActionButton } from '@/components/action-button';
import { setActiveDraft, syncNow } from '../actions';
import { DraftRoom } from './draft-room';

export const dynamic = 'force-dynamic';

export default async function DraftPage() {
  const cfg = await getConfig();
  if (!cfg.leagueId) {
    return (
      <EmptyState
        title="No league configured"
        description={
          <>
            Set your Sleeper league id on the{' '}
            <Link href="/settings" className="underline">
              Settings page
            </Link>{' '}
            first.
          </>
        }
      />
    );
  }

  const drafts = await prisma.draft.findMany({
    where: { leagueId: cfg.leagueId },
    orderBy: [{ season: 'desc' }],
  });

  if (!drafts.length) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Draft Room</h1>
        <EmptyState
          title="No draft found"
          description="Sleeper creates the draft object once your commissioner sets it up. Sync the league again after that happens."
          action={
            <ActionButton action={syncNow.bind(null, 'league')} variant="outline">
              Sync league
            </ActionButton>
          }
        />
      </div>
    );
  }

  // Prefer the explicitly active draft, then this season's, then the newest.
  const active =
    drafts.find((d) => d.isPrimary) ?? drafts.find((d) => d.season === cfg.season) ?? drafts[0];

  const state = await loadDraftRoomState(active.id);

  return (
    <div className="space-y-3">
      {drafts.length > 1 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Which draft?</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-center gap-1">
                {d.id === active.id ? (
                  <Badge variant="secondary">
                    {d.season} · {d.status}
                  </Badge>
                ) : (
                  <ActionButton action={setActiveDraft.bind(null, d.id)} variant="outline" size="sm" messageClassName="hidden">
                    {d.season} · {d.status}
                  </ActionButton>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {state.warning ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <span>{state.warning}</span>
          <Button asChild size="sm" variant="outline">
            <Link href="/board">Build board</Link>
          </Button>
        </div>
      ) : null}

      <DraftRoom initialState={state} />
    </div>
  );
}
