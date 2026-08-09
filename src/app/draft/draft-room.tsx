'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn, fmt, pickLabel, relativeTime } from '@/lib/utils';
import { DRAFT_STRATEGIES, DRAFT_STRATEGY_LABELS, SKILL_POSITIONS, type DraftStrategy } from '@/lib/enums';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from '@/components/ui/primitives';
import { PosBadge, TierChip, InjuryTag, ValueDelta, BaselineFlag, TeamTag } from '@/components/player-bits';
import { enterPick, undoDraftPick, pullDraftNow, setStrategy } from '../actions';
import type { DraftRoomState } from '@/lib/draft/state';

/**
 * The live draft room.
 *
 * Layout is deliberately three columns on a wide screen: what to do (left),
 * what just happened (middle), where everyone stands (right). During a draft
 * you have seconds, so the single most important number — who to take now —
 * is top-left and largest.
 */
export function DraftRoom({ initialState }: { initialState: DraftRoomState }) {
  const router = useRouter();
  const [state, setState] = React.useState(initialState);
  const [connection, setConnection] = React.useState<'connecting' | 'live' | 'error' | 'paused'>('connecting');
  const [lastCheck, setLastCheck] = React.useState<number | null>(null);
  const [lastError, setLastError] = React.useState<string | null>(null);
  const [flashPicks, setFlashPicks] = React.useState<Set<number>>(new Set());
  const [live, setLive] = React.useState(true);
  const [query, setQuery] = React.useState('');
  const [posFilter, setPosFilter] = React.useState('ALL');

  const draftId = state.draft.id;

  // --- Live sync -----------------------------------------------------------
  const refreshState = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/draft/${draftId}/state`, { cache: 'no-store' });
      if (!res.ok) return;
      setState(await res.json());
    } catch {
      // Transient — the next tick will retry.
    }
  }, [draftId]);

  React.useEffect(() => {
    if (!live) {
      setConnection('paused');
      return;
    }

    const source = new EventSource(`/api/draft/${draftId}/stream`);
    setConnection('connecting');

    source.addEventListener('open', () => setConnection('live'));

    source.addEventListener('heartbeat', (event) => {
      setConnection('live');
      setLastError(null);
      const data = JSON.parse((event as MessageEvent).data);
      setLastCheck(data.at);
    });

    source.addEventListener('picks', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { newPickNos: number[]; at: number };
      setConnection('live');
      setLastCheck(data.at);
      setLastError(null);
      if (data.newPickNos?.length) {
        setFlashPicks(new Set(data.newPickNos));
        window.setTimeout(() => setFlashPicks(new Set()), 2000);
      }
      void refreshState();
    });

    source.addEventListener('error', (event) => {
      const raw = (event as MessageEvent).data;
      if (raw) {
        try {
          setLastError(JSON.parse(raw).message);
        } catch {
          setLastError('Sync error');
        }
      }
      setConnection('error');
    });

    source.onerror = () => setConnection('error');

    return () => source.close();
  }, [draftId, live, refreshState]);

  // --- Derived -------------------------------------------------------------
  const draftedSet = React.useMemo(() => new Set(state.draftedIds), [state.draftedIds]);

  const available = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.board.filter((p) => {
      if (draftedSet.has(p.playerId)) return false;
      if (posFilter !== 'ALL' && p.position !== posFilter) return false;
      if (q && !p.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [state.board, draftedSet, posFilter, query]);

  const isMyTurn = state.onTheClock?.isMe ?? false;

  return (
    <div className="space-y-3">
      {/* --- Status bar --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              connection === 'live' && 'animate-pulse bg-emerald-500',
              connection === 'connecting' && 'bg-amber-500',
              connection === 'error' && 'bg-rose-500',
              connection === 'paused' && 'bg-muted-foreground',
            )}
          />
          <span className="text-sm font-medium capitalize">{connection}</span>
          {lastCheck ? (
            <span className="text-xs text-muted-foreground">checked {relativeTime(new Date(lastCheck))}</span>
          ) : null}
        </div>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">On the clock</span>
          <span className="text-lg font-semibold tabular">{state.currentPickLabel}</span>
          <span className={cn('text-sm', isMyTurn ? 'font-semibold text-emerald-500' : 'text-muted-foreground')}>
            {isMyTurn ? 'YOU' : (state.onTheClock?.memberName ?? '—')}
          </span>
        </div>

        {state.picksUntilMyTurn !== null ? (
          <>
            <div className="h-4 w-px bg-border" />
            <div className="text-sm">
              <span className="text-muted-foreground">Your next pick in </span>
              <span className="font-semibold tabular">{state.picksUntilMyTurn}</span>
              <span className="text-muted-foreground">
                {' '}
                ({state.myUpcomingPicks[0] ? pickLabel(state.myUpcomingPicks[0], state.draft.teams) : '—'})
              </span>
            </div>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={state.strategy}
            onChange={async (e) => {
              await setStrategy(e.target.value as DraftStrategy);
              router.refresh();
              void refreshState();
            }}
            className="h-8 w-auto text-xs"
          >
            {DRAFT_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {DRAFT_STRATEGY_LABELS[s]}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="sm" onClick={() => setLive((v) => !v)}>
            {live ? 'Pause sync' : 'Resume sync'}
          </Button>
          <ActionPull draftId={draftId} onDone={refreshState} />
        </div>
      </div>

      {lastError ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
          Sync problem: {lastError}. Picks you enter by hand still work.
        </div>
      ) : null}

      {/* --- Run alerts --------------------------------------------------- */}
      {state.runAlerts.length ? (
        <div className="flex flex-wrap gap-2">
          {state.runAlerts.map((alert) => (
            <div
              key={alert.position}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                alert.severity === 'HIGH'
                  ? 'border-rose-500/40 bg-rose-500/10'
                  : 'border-amber-500/40 bg-amber-500/10',
              )}
            >
              <PosBadge position={alert.position} />
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1.15fr_1fr_0.85fr]">
        {/* --- Recommendations ------------------------------------------- */}
        <Card className={cn(isMyTurn && 'ring-2 ring-emerald-500/50')}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle>{isMyTurn ? 'Take one of these' : 'Best available'}</CardTitle>
              <span className="text-xs text-muted-foreground">ranked by value + need</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {state.suggestions.slice(0, 8).map((s, i) => (
              <div
                key={s.player.playerId}
                className={cn(
                  'rounded-md border p-2.5',
                  i === 0 && isMyTurn ? 'border-emerald-500/50 bg-emerald-500/5' : 'bg-card',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.player.fullName}</span>
                      <PosBadge position={s.player.position} rank={s.player.positionRank} />
                      <TeamTag teamId={s.player.teamId} />
                      <TierChip tier={s.player.tier} />
                      <InjuryTag status={s.player.injuryStatus} />
                      <BaselineFlag isBaseline={s.player.isBaseline} />
                      {s.classification !== 'TARGET' ? (
                        <Badge variant="outline" className="text-[10px]">
                          {s.classification.replace('_', ' ').toLowerCase()}
                        </Badge>
                      ) : null}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {s.reasons.slice(0, 3).map((r, ri) => (
                        <li key={ri}>· {r}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular">{fmt(s.player.vorp, 0)}</div>
                    <div className="text-[10px] uppercase text-muted-foreground">vorp</div>
                    {s.vona > 0 ? (
                      <div className="mt-0.5 text-xs tabular text-emerald-600 dark:text-emerald-400">
                        +{fmt(s.vona, 0)} vona
                      </div>
                    ) : null}
                    {state.myUpcomingPicks.length > 1 ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground tabular">
                        {Math.round(s.availabilityAtNextPick * 100)}% next
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <TakeButton
                    draftId={draftId}
                    pickNo={state.currentPickNo}
                    playerId={s.player.playerId}
                    label={`Draft at ${state.currentPickLabel}`}
                    onDone={refreshState}
                  />
                </div>
              </div>
            ))}
            {!state.suggestions.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No board loaded — build one from the Board page.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* --- Pick feed + available -------------------------------------- */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Recent picks</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[280px] space-y-0.5 overflow-y-auto thin-scroll">
              {state.recentPicks.map((p) => (
                <div
                  key={p.pickNo}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm',
                    flashPicks.has(p.pickNo) && 'row-flash',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-10 shrink-0 text-xs tabular text-muted-foreground">
                      {pickLabel(p.pickNo, state.draft.teams)}
                    </span>
                    <PosBadge position={p.position ?? '?'} />
                    <span className="truncate">{p.playerName}</span>
                    {p.isKeeper ? (
                      <Badge variant="outline" className="text-[10px]">
                        kept
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="max-w-[7rem] truncate">{p.memberName}</span>
                    {p.ourRank ? (
                      <span className="tabular" title="Our overall rank vs where he actually went">
                        #{p.ourRank}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
              {!state.recentPicks.length ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No picks yet.</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="mr-auto">Available</CardTitle>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="h-7 w-32 text-xs"
                />
                <Select
                  value={posFilter}
                  onChange={(e) => setPosFilter(e.target.value)}
                  className="h-7 w-auto text-xs"
                >
                  <option value="ALL">All</option>
                  {SKILL_POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </div>
            </CardHeader>
            <CardContent className="max-h-[420px] overflow-y-auto thin-scroll">
              <table className="w-full text-sm">
                <tbody>
                  {available.slice(0, 100).map((p) => (
                    <tr key={p.playerId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="py-1 pr-2 tabular text-xs text-muted-foreground">{p.overallRank}</td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{p.fullName}</span>
                          <InjuryTag status={p.injuryStatus} />
                          <BaselineFlag isBaseline={p.isBaseline} />
                        </div>
                      </td>
                      <td className="py-1 pr-2">
                        <PosBadge position={p.position} rank={p.positionRank} />
                      </td>
                      <td className="py-1 pr-2 text-right tabular text-xs">{fmt(p.vorp, 0)}</td>
                      <td className="py-1 pr-2 text-right text-xs">
                        <ValueDelta delta={p.adpDelta} />
                      </td>
                      <td className="py-1 text-right">
                        <TakeButton
                          draftId={draftId}
                          pickNo={state.currentPickNo}
                          playerId={p.playerId}
                          label="Take"
                          compact
                          onDone={refreshState}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        {/* --- Rosters ---------------------------------------------------- */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Your roster</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {SKILL_POSITIONS.map((pos) => (
                  <span key={pos} className="rounded bg-secondary px-1.5 py-0.5 text-xs tabular">
                    {pos} {state.myRoster.counts[pos] ?? 0}/{state.shape.starters[pos] ?? 0}
                  </span>
                ))}
              </div>
              {state.rosters.find((r) => r.isMe)?.needs.length ? (
                <p className="mb-2 text-xs text-amber-600 dark:text-amber-500">
                  Still need: {state.rosters.find((r) => r.isMe)?.needs.join(', ')}
                </p>
              ) : (
                <p className="mb-2 text-xs text-emerald-600 dark:text-emerald-400">Starting lineup filled.</p>
              )}
              <div className="space-y-0.5">
                {state.rosters
                  .find((r) => r.isMe)
                  ?.players.map((p) => (
                    <div key={p.playerId} className="flex items-center gap-2 text-sm">
                      <span className="w-10 shrink-0 text-xs tabular text-muted-foreground">
                        {pickLabel(p.pickNo, state.draft.teams)}
                      </span>
                      <PosBadge position={p.position} />
                      <span className="truncate">{p.name}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-6 px-1.5 text-[10px]"
                        onClick={async () => {
                          await undoDraftPick(draftId, p.pickNo);
                          void refreshState();
                        }}
                      >
                        undo
                      </Button>
                    </div>
                  ))}
                {!state.rosters.find((r) => r.isMe)?.players.length ? (
                  <p className="py-3 text-center text-sm text-muted-foreground">Nothing drafted yet.</p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>League rosters</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[400px] space-y-2 overflow-y-auto thin-scroll">
              {state.rosters.map((r) => (
                <div key={r.rosterId} className={cn('rounded-md border p-2', r.isMe && 'border-emerald-500/40')}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{r.memberName}</span>
                    <span className="text-xs tabular text-muted-foreground">{r.players.length} picks</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {SKILL_POSITIONS.map((pos) => (
                      <span key={pos} className="text-[10px] tabular text-muted-foreground">
                        {pos}
                        {r.counts[pos] ?? 0}
                      </span>
                    ))}
                  </div>
                  {r.needs.length ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">needs {r.needs.join(', ')}</div>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// --- Small client helpers ---------------------------------------------------

function TakeButton({
  draftId,
  pickNo,
  playerId,
  label,
  compact,
  onDone,
}: {
  draftId: string;
  pickNo: number;
  playerId: string;
  label: string;
  compact?: boolean;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant={compact ? 'ghost' : 'default'}
      className={compact ? 'h-6 px-2 text-[10px]' : ''}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await enterPick(draftId, pickNo, playerId);
          onDone();
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? '…' : label}
    </Button>
  );
}

function ActionPull({ draftId, onDone }: { draftId: string; onDone: () => void }) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await pullDraftNow(draftId);
          onDone();
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? '…' : 'Pull now'}
    </Button>
  );
}
