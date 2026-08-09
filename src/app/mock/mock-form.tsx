'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select } from '@/components/ui/primitives';
import { DRAFT_STRATEGIES, DRAFT_STRATEGY_LABELS } from '@/lib/enums';
import { pickLabel, snakePickNo } from '@/lib/utils';
import { runMock } from '../mock-actions';

export function MockForm({
  defaultSlot,
  teams,
  defaultRounds,
}: {
  defaultSlot: number;
  teams: number;
  defaultRounds: number;
}) {
  const router = useRouter();
  const [slot, setSlot] = React.useState(defaultSlot);
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const firstPicks = [1, 2, 3].map((round) => pickLabel(snakePickNo(round, slot, teams), teams));

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    try {
      const result = await runMock(formData);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5">
          <Label htmlFor="mock-slot">Your draft slot</Label>
          <Input
            id="mock-slot"
            name="slot"
            type="number"
            min={1}
            max={teams}
            value={slot}
            onChange={(e) => setSlot(Number(e.target.value))}
            className="tabular"
          />
          <p className="text-xs text-muted-foreground">Picks {firstPicks.join(', ')}…</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mock-strategy">Strategy</Label>
          <Select id="mock-strategy" name="strategy" defaultValue="BALANCED">
            {DRAFT_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {DRAFT_STRATEGY_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mock-rounds">Rounds</Label>
          <Input
            id="mock-rounds"
            name="rounds"
            type="number"
            min={1}
            max={30}
            defaultValue={defaultRounds}
            className="tabular"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mock-iterations">Iterations</Label>
          <Select id="mock-iterations" name="iterations" defaultValue="200">
            <option value="50">50 (quick)</option>
            <option value="200">200 (balanced)</option>
            <option value="500">500 (precise)</option>
            <option value="1000">1000 (slow)</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mock-name">Name (optional)</Label>
          <Input id="mock-name" name="name" placeholder="Zero RB from 4" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Simulating…' : 'Run simulation'}
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
    </form>
  );
}
