'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select } from '@/components/ui/primitives';
import { saveKeeper } from '../actions';

export function KeeperForm({
  players,
  rosters,
  existing,
}: {
  players: { id: string; name: string; position: string; team: string | null }[];
  rosters: { rosterId: number; name: string; isMe: boolean }[];
  existing: { playerId: string; name: string; rosterId: number | null; costRound: number | null; costPickNo: number | null }[];
}) {
  const router = useRouter();
  const [playerId, setPlayerId] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [rosterId, setRosterId] = React.useState<string>(String(rosters.find((r) => r.isMe)?.rosterId ?? ''));
  const [costRound, setCostRound] = React.useState('');
  const [costPickNo, setCostPickNo] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const matches = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [players, search]);

  const selected = players.find((p) => p.id === playerId);
  const alreadyKept = existing.find((e) => e.playerId === playerId);

  async function submit() {
    if (!playerId) {
      setMessage({ ok: false, text: 'Pick a player first.' });
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await saveKeeper({
      playerId,
      rosterId: rosterId ? Number(rosterId) : null,
      costRound: costRound ? Number(costRound) : null,
      costPickNo: costPickNo ? Number(costPickNo) : null,
    });
    setMessage({ ok: result.ok, text: result.message });
    setPending(false);
    if (result.ok) {
      setPlayerId('');
      setSearch('');
      setCostRound('');
      setCostPickNo('');
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="keeper-search">Player</Label>
          <Input
            id="keeper-search"
            value={selected ? `${selected.name} (${selected.position}${selected.team ? ` · ${selected.team}` : ''})` : search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPlayerId('');
            }}
            placeholder="Start typing a name…"
          />
          {matches.length && !playerId ? (
            <div className="rounded-md border bg-popover shadow-sm">
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setPlayerId(p.id);
                    setSearch(p.name);
                  }}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.position}
                    {p.team ? ` · ${p.team}` : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {alreadyKept ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Already declared — saving will update the existing entry.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="keeper-roster">Team</Label>
          <Select id="keeper-roster" value={rosterId} onChange={(e) => setRosterId(e.target.value)}>
            <option value="">—</option>
            {rosters.map((r) => (
              <option key={r.rosterId} value={r.rosterId}>
                {r.name}
                {r.isMe ? ' (you)' : ''}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="keeper-round">Cost round</Label>
            <Input
              id="keeper-round"
              type="number"
              min={1}
              max={30}
              value={costRound}
              onChange={(e) => setCostRound(e.target.value)}
              className="tabular"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="keeper-pick">or pick #</Label>
            <Input
              id="keeper-pick"
              type="number"
              min={1}
              value={costPickNo}
              onChange={(e) => setCostPickNo(e.target.value)}
              className="tabular"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save keeper'}
        </Button>
        {message ? (
          <span
            className={
              message.ok ? 'text-xs text-emerald-600 dark:text-emerald-400' : 'text-xs text-rose-600 dark:text-rose-400'
            }
          >
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
