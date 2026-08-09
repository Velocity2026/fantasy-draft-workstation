'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { ActionForm } from '@/components/action-button';
import { saveSource, importCsv } from '../actions';
import type { ActionResult } from '../actions';

const KINDS: { value: string; label: string }[] = [
  { value: 'PROJECTIONS', label: 'Projections (points)' },
  { value: 'RANKINGS', label: 'Rankings (order)' },
  { value: 'ADP', label: 'ADP / draft market' },
  { value: 'ANALYST', label: 'Individual analyst' },
  { value: 'NEWS', label: 'News & reports' },
  { value: 'USAGE', label: 'Usage & snap data' },
  { value: 'MARKET', label: 'Roster % / add-drop' },
];

export function SourceForm({ existing }: { existing: { key: string; label: string }[] }) {
  const [key, setKey] = React.useState('');

  return (
    <ActionForm action={saveSource} submitLabel="Save source">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="src-key">Key</Label>
          <Input
            id="src-key"
            name="key"
            required
            list="existing-sources"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="mike-clay"
          />
          <datalist id="existing-sources">
            {existing.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">
            Short, no spaces. Reusing an existing key edits that source.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-label">Display name</Label>
          <Input id="src-label" name="label" required placeholder="Mike Clay" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-kind">Type</Label>
          <Select id="src-kind" name="kind" defaultValue="RANKINGS">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-adapter">How data arrives</Label>
          <Select id="src-adapter" name="adapter" defaultValue="CSV">
            <option value="CSV">CSV / spreadsheet upload</option>
            <option value="MANUAL">Typed in by hand</option>
            <option value="HTTP_JSON">HTTP JSON endpoint</option>
            <option value="SLEEPER">Sleeper API</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-weight">Weight</Label>
          <Input
            id="src-weight"
            name="weight"
            type="number"
            step="0.1"
            min={0}
            max={10}
            defaultValue={1}
            className="tabular"
          />
          <p className="text-xs text-muted-foreground">How much its numbers count. 0 = ignore.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-trust">Trust</Label>
          <Input
            id="src-trust"
            name="trust"
            type="number"
            step="0.05"
            min={0}
            max={1}
            defaultValue={0.5}
            className="tabular"
          />
          <p className="text-xs text-muted-foreground">0–1. Confidence given to their written notes.</p>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="src-url">Website (optional)</Label>
          <Input id="src-url" name="url" placeholder="https://…" />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="src-notes">Notes (optional)</Label>
          <Textarea
            id="src-notes"
            name="notes"
            rows={2}
            placeholder="Who they are and why you trust them. Shown here and used when generating written summaries."
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked className="h-4 w-4 rounded border-input" />
        Enabled
      </label>
    </ActionForm>
  );
}

export function ImportForm({ sources, season }: { sources: { key: string; label: string }[]; season: string }) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<(ActionResult & { data?: unknown }) | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setResult(null);
    try {
      setResult(await importCsv(formData));
      router.refresh();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  const detail = result?.data as
    | { unresolved?: { name: string; team?: string | null }[]; headersDetected?: string[] }
    | undefined;

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="imp-source">Source key</Label>
          <Input id="imp-source" name="source" required list="import-sources" placeholder="ftn" />
          <datalist id="import-sources">
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </datalist>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imp-type">What is this file?</Label>
          <Select id="imp-type" name="type" defaultValue="rankings">
            <option value="rankings">Rankings</option>
            <option value="projections">Projections</option>
            <option value="adp">ADP</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imp-format">Scoring</Label>
          <Select id="imp-format" name="format" defaultValue="PPR">
            <option value="PPR">Full PPR</option>
            <option value="HALF">Half PPR</option>
            <option value="STD">Standard</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imp-week">Week (blank = season)</Label>
          <Input id="imp-week" name="week" type="number" min={1} max={18} placeholder="" className="tabular" />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="imp-label">Display name if this key is new (optional)</Label>
          <Input id="imp-label" name="label" placeholder="FTN Fantasy" />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="imp-file">CSV file</Label>
          <Input id="imp-file" name="file" type="file" accept=".csv,text/csv" required />
          <p className="text-xs text-muted-foreground">Importing into season {season}.</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Importing…' : 'Import'}
        </Button>
        {result ? (
          <span className={result.ok ? 'text-xs text-emerald-600 dark:text-emerald-400' : 'text-xs text-rose-600 dark:text-rose-400'}>
            {result.message}
          </span>
        ) : null}
      </div>

      {detail?.headersDetected?.length ? (
        <p className="text-xs text-muted-foreground">
          Recognised columns: {detail.headersDetected.join(', ')}
        </p>
      ) : null}

      {detail?.unresolved?.length ? (
        <details className="rounded-md border bg-muted/40 p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            {detail.unresolved.length} unmatched names — click to review
          </summary>
          <p className="pt-2 text-muted-foreground">
            Usually retired players, team defences, or spelling differences. Anything here was <em>not</em> imported.
          </p>
          <ul className="max-h-48 overflow-y-auto pt-2 thin-scroll">
            {detail.unresolved.map((u, i) => (
              <li key={`${u.name}-${i}`} className="py-0.5">
                {u.name}
                {u.team ? ` (${u.team})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </form>
  );
}
