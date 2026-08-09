'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn, fmt } from '@/lib/utils';
import { BOARD_STATUS_LABELS, BOARD_STATUSES, SKILL_POSITIONS } from '@/lib/enums';
import { Badge, Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { PosBadge, TierChip, InjuryTag, ValueDelta, BaselineFlag, AvoidFlag, TeamTag } from '@/components/player-bits';
import { saveBoardEntry, clearBoardEntry } from '../actions';
import type { ValuationRowWithPlayer } from '@/lib/valuation/engine';

interface Override {
  playerId: string;
  userRank: number | null;
  userTier: number | null;
  targetRound: number | null;
  status: string;
  note: string | null;
  isDoNotDraft: boolean;
}

/**
 * The big board.
 *
 * Filtering and sorting happen client-side over the full list because a
 * 10-team board is a few hundred rows — instant, and avoids a round trip while
 * you're scanning. Manual overrides save immediately on change; there is no
 * "save board" button to forget to press before a draft.
 */
export function BoardTable({
  rows,
  overrides,
  keeperIds,
}: {
  rows: ValuationRowWithPlayer[];
  overrides: Override[];
  keeperIds: string[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [position, setPosition] = React.useState('ALL');
  const [sort, setSort] = React.useState<'value' | 'adp' | 'mine'>('value');
  const [hideKeepers, setHideKeepers] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const overrideMap = React.useMemo(() => new Map(overrides.map((o) => [o.playerId, o])), [overrides]);
  const keeperSet = React.useMemo(() => new Set(keeperIds), [keeperIds]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((r) => {
      if (position !== 'ALL' && r.position !== position) return false;
      if (hideKeepers && keeperSet.has(r.playerId)) return false;
      if (q && !r.fullName.toLowerCase().includes(q) && !(r.teamId ?? '').toLowerCase().includes(q)) return false;
      return true;
    });

    if (sort === 'adp') {
      list = [...list].sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999));
    } else if (sort === 'mine') {
      list = [...list].sort((a, b) => {
        const ra = overrideMap.get(a.playerId)?.userRank ?? 9999;
        const rb = overrideMap.get(b.playerId)?.userRank ?? 9999;
        if (ra !== rb) return ra - rb;
        return a.overallRank - b.overallRank;
      });
    }
    return list;
  }, [rows, query, position, sort, hideKeepers, keeperSet, overrideMap]);

  async function update(playerId: string, patch: Partial<Override>) {
    const current = overrideMap.get(playerId);
    await saveBoardEntry({
      playerId,
      userRank: patch.userRank !== undefined ? patch.userRank : (current?.userRank ?? null),
      userTier: patch.userTier !== undefined ? patch.userTier : (current?.userTier ?? null),
      targetRound: patch.targetRound !== undefined ? patch.targetRound : (current?.targetRound ?? null),
      status: patch.status !== undefined ? patch.status : (current?.status ?? 'NEUTRAL'),
      note: patch.note !== undefined ? patch.note : (current?.note ?? null),
      isDoNotDraft: patch.isDoNotDraft !== undefined ? patch.isDoNotDraft : (current?.isDoNotDraft ?? false),
    });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {/* --- Controls ----------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search player or team…"
          className="max-w-xs"
        />
        <div className="flex gap-1">
          {['ALL', ...SKILL_POSITIONS].map((pos) => (
            <Button
              key={pos}
              variant={position === pos ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setPosition(pos)}
            >
              {pos}
            </Button>
          ))}
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-auto">
          <option value="value">Sort: our value</option>
          <option value="adp">Sort: market ADP</option>
          <option value="mine">Sort: my rank</option>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={hideKeepers}
            onChange={(e) => setHideKeepers(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Hide keepers
        </label>
        <span className="ml-auto text-sm text-muted-foreground tabular">{filtered.length} players</span>
      </div>

      {/* --- Table -------------------------------------------------------- */}
      <div className="max-h-[70vh] overflow-auto rounded-lg border thin-scroll">
        <table className="w-full text-sm">
          <thead className="sticky-head">
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Player</th>
              <th className="px-2 py-2 font-medium">Pos</th>
              <th className="px-2 py-2 text-right font-medium">Proj</th>
              <th className="px-2 py-2 text-right font-medium">VORP</th>
              <th className="px-2 py-2 text-center font-medium">Tier</th>
              <th className="px-2 py-2 text-right font-medium">ADP</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="px-2 py-2 text-right font-medium">$</th>
              <th className="px-2 py-2 text-right font-medium">My rank</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const o = overrideMap.get(row.playerId);
              const isKeeper = keeperSet.has(row.playerId);
              const dnd = o?.isDoNotDraft;
              return (
                <React.Fragment key={row.playerId}>
                  <tr
                    className={cn(
                      'border-b last:border-0 hover:bg-accent/40',
                      dnd && 'opacity-45',
                      o?.status === 'MUST_HAVE' && 'bg-emerald-500/5',
                      o?.status === 'AVOID' && 'bg-rose-500/5',
                    )}
                  >
                    <td className="px-2 py-1.5 tabular text-muted-foreground">{row.overallRank}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={cn('font-medium', dnd && 'line-through')}>{row.fullName}</span>
                        <TeamTag teamId={row.teamId} />
                        <InjuryTag status={row.injuryStatus} />
                        <BaselineFlag isBaseline={row.isBaseline} />
                        <AvoidFlag sources={row.avoidSources} />
                        {isKeeper ? (
                          <Badge variant="outline" className="text-[10px]">
                            kept
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <PosBadge position={row.position} rank={row.positionRank} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular">{fmt(row.projPoints, 0)}</td>
                    <td className="px-2 py-1.5 text-right tabular font-medium">{fmt(row.vorp, 0)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <TierChip tier={row.tier} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular text-muted-foreground">
                      {row.adp ? fmt(row.adp, 0) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <ValueDelta delta={row.adpDelta} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular text-muted-foreground">
                      {row.auctionValue ? `$${row.auctionValue}` : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        min={1}
                        defaultValue={o?.userRank ?? ''}
                        placeholder="—"
                        className="h-7 w-16 px-1.5 text-right tabular"
                        onBlur={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          if (v !== (o?.userRank ?? null)) update(row.playerId, { userRank: v });
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Select
                        value={o?.status ?? 'NEUTRAL'}
                        onChange={(e) =>
                          update(row.playerId, {
                            status: e.target.value,
                            isDoNotDraft: e.target.value === 'DO_NOT_DRAFT',
                          })
                        }
                        className="h-7 w-32 px-1.5 text-xs"
                      >
                        {BOARD_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {BOARD_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded(expanded === row.playerId ? null : row.playerId)}
                      >
                        {o?.note ? '📝' : '＋'}
                      </Button>
                    </td>
                  </tr>

                  {expanded === row.playerId ? (
                    <tr className="border-b bg-muted/30">
                      <td colSpan={12} className="px-4 py-3">
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="md:col-span-2 space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Note</label>
                            <Textarea
                              rows={2}
                              defaultValue={o?.note ?? ''}
                              placeholder="Why you like or dislike him. Shows up in the draft room."
                              onBlur={(e) => {
                                if (e.target.value !== (o?.note ?? '')) update(row.playerId, { note: e.target.value });
                              }}
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="space-y-1.5">
                              <label className="text-xs font-medium text-muted-foreground">Target round</label>
                              <Input
                                type="number"
                                min={1}
                                defaultValue={o?.targetRound ?? ''}
                                className="h-8 tabular"
                                onBlur={(e) => {
                                  const v = e.target.value === '' ? null : Number(e.target.value);
                                  if (v !== (o?.targetRound ?? null)) update(row.playerId, { targetRound: v });
                                }}
                              />
                            </div>
                            <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
                              <span>Risk {row.riskScore !== null ? `${(row.riskScore * 100).toFixed(0)}%` : '—'}</span>
                              <span>Upside {row.upsideScore !== null ? `${(row.upsideScore * 100).toFixed(0)}%` : '—'}</span>
                              <span>
                                Range {fmt(row.floorPoints, 0)}–{fmt(row.ceilingPoints, 0)}
                              </span>
                            </div>
                            {o ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                  await clearBoardEntry(row.playerId);
                                  router.refresh();
                                }}
                              >
                                Clear my overrides
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
