'use client';

import * as React from 'react';
import { Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { ActionForm } from '@/components/action-button';
import { EVIDENCE_TYPES, EVIDENCE_TYPE_LABELS } from '@/lib/enums';
import { addEvidence } from '../actions';

export function EvidenceForm({
  players,
  teams,
  sources,
  season,
}: {
  players: { id: string; name: string; position: string; team: string | null }[];
  teams: { id: string; name: string }[];
  sources: { key: string; label: string; trust: number }[];
  season: string;
}) {
  const [subject, setSubject] = React.useState<'player' | 'team'>('player');
  const [search, setSearch] = React.useState('');
  const [playerId, setPlayerId] = React.useState('');

  const matches = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || playerId) return [];
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [players, search, playerId]);

  const selected = players.find((p) => p.id === playerId);

  return (
    <ActionForm action={addEvidence} submitLabel="Save note" resetOnSuccess>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="ev-subject">About</Label>
          <Select
            id="ev-subject"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value as 'player' | 'team');
              setPlayerId('');
              setSearch('');
            }}
          >
            <option value="player">A player</option>
            <option value="team">A team</option>
          </Select>
        </div>

        {subject === 'player' ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-player">Player</Label>
            <Input
              id="ev-player"
              value={selected ? selected.name : search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPlayerId('');
              }}
              placeholder="Start typing…"
            />
            <input type="hidden" name="playerId" value={playerId} />
            {matches.length ? (
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
          </div>
        ) : (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-team">Team</Label>
            <Select id="ev-team" name="teamId" defaultValue="">
              <option value="">Choose…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} — {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="ev-type">Type</Label>
          <Select id="ev-type" name="evidenceType" defaultValue="CAMP_REPORT">
            {EVIDENCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVIDENCE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
          <Label htmlFor="ev-headline">Headline</Label>
          <Input
            id="ev-headline"
            name="headline"
            required
            placeholder="Working as the clear passing-down back through two weeks of camp"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
          <Label htmlFor="ev-body">Detail (optional)</Label>
          <Textarea id="ev-body" name="body" rows={2} placeholder="What exactly was reported, and by whom." />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-source">Source</Label>
          <Input id="ev-source" name="sourceName" list="ev-sources" placeholder="Beat writer, site, podcast…" />
          <datalist id="ev-sources">
            {sources.map((s) => (
              <option key={s.key} value={s.label} />
            ))}
          </datalist>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-url">Link (optional)</Label>
          <Input id="ev-url" name="sourceUrl" placeholder="https://…" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-impact">Impact</Label>
          <Select id="ev-impact" name="impact" defaultValue="MEDIUM">
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-sentiment">Direction</Label>
          <Select id="ev-sentiment" name="sentiment" defaultValue="0">
            <option value="1">Good for him</option>
            <option value="0">Neutral</option>
            <option value="-1">Bad for him</option>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Filed under season {season}.</p>
    </ActionForm>
  );
}
