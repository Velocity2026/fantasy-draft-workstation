import { listSources, sourceUsageStats, SOURCE_KIND_LABELS, SOURCE_ADAPTER_LABELS, type SourceKind, type SourceAdapter } from '@/lib/sources';
import { getConfig } from '@/lib/config';
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
import { removeSource, seedDefaultSources, toggleSource, runValuationNow } from '../actions';
import { SourceForm, ImportForm } from './source-forms';

export const dynamic = 'force-dynamic';

/**
 * Source management.
 *
 * The design promise: swapping FantasyPros for somewhere else, or adding one
 * writer you rate, is a row in this table — never a code change. Weight
 * controls how much a source moves the projections; trust controls how much
 * weight its written notes carry as evidence.
 */
export default async function SourcesPage() {
  const cfg = await getConfig();
  const [sources, usage] = await Promise.all([listSources(), sourceUsageStats()]);

  const numeric = sources.filter((s) => ['PROJECTIONS', 'RANKINGS', 'ADP'].includes(s.kind));
  const totalWeight = numeric.filter((s) => s.enabled).reduce((sum, s) => sum + s.weight, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Everything the analysis engine reads from. Add a site, add an individual writer, change how much each one
            counts, or turn one off — no code changes, and disabling a source keeps its history so you can always see
            what it used to say.
          </p>
        </div>
        <div className="flex gap-2">
          {sources.length === 0 ? (
            <ActionButton action={seedDefaultSources} variant="outline">
              Add default sources
            </ActionButton>
          ) : null}
          <ActionButton action={runValuationNow}>Rebuild board</ActionButton>
        </div>
      </div>

      {/* --- Current sources ---------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Registered sources</CardTitle>
          <CardDescription>
            Weight is relative — a source at 2 counts twice as much as one at 1. Enabled numeric sources currently
            total {totalWeight.toFixed(1)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sources.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Source</th>
                    <th className="pb-2 pr-3 font-medium">Type</th>
                    <th className="pb-2 pr-3 font-medium">How it arrives</th>
                    <th className="pb-2 pr-3 text-right font-medium">Weight</th>
                    <th className="pb-2 pr-3 text-right font-medium">Trust</th>
                    <th className="pb-2 pr-3 text-right font-medium">Data held</th>
                    <th className="pb-2 pr-3 font-medium">Last import</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => {
                    const stats = usage[s.key];
                    const held =
                      (stats?.projections ?? 0) + (stats?.rankings ?? 0) + (stats?.adp ?? 0) + (stats?.evidence ?? 0);
                    return (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            <span className={s.enabled ? 'font-medium' : 'font-medium text-muted-foreground line-through'}>
                              {s.label}
                            </span>
                            {s.isBuiltIn ? <Badge variant="outline">built in</Badge> : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <code>{s.key}</code>
                            {s.notes ? <span className="ml-2">{s.notes}</span> : null}
                          </div>
                        </td>
                        <td className="pr-3 text-xs text-muted-foreground">
                          {SOURCE_KIND_LABELS[s.kind as SourceKind] ?? s.kind}
                        </td>
                        <td className="pr-3 text-xs text-muted-foreground">
                          {SOURCE_ADAPTER_LABELS[s.adapter as SourceAdapter] ?? s.adapter}
                        </td>
                        <td className="pr-3 text-right tabular">{s.weight.toFixed(1)}</td>
                        <td className="pr-3 text-right tabular">{(s.trust * 100).toFixed(0)}%</td>
                        <td className="pr-3 text-right tabular text-muted-foreground">
                          {held ? held.toLocaleString() : <span className="text-amber-600 dark:text-amber-500">none</span>}
                        </td>
                        <td className="pr-3 text-xs text-muted-foreground">
                          {s.lastImportedAt ? relativeTime(s.lastImportedAt) : '—'}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <ActionButton
                              action={() => toggleSource(s.key, !s.enabled)}
                              variant="ghost"
                              size="sm"
                              messageClassName="hidden"
                            >
                              {s.enabled ? 'Disable' : 'Enable'}
                            </ActionButton>
                            {!s.isBuiltIn ? (
                              <ActionButton
                                action={() => removeSource(s.key)}
                                variant="ghost"
                                size="sm"
                                confirm={`Remove "${s.label}"? Its imported data is kept, it just stops counting.`}
                                messageClassName="hidden"
                              >
                                Remove
                              </ActionButton>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No sources registered"
              description="Add the defaults to get started, then import a CSV or add your own writer."
              action={
                <ActionButton action={seedDefaultSources} variant="outline">
                  Add default sources
                </ActionButton>
              }
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Add / edit ------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Add or edit a source</CardTitle>
            <CardDescription>
              Use the same key to edit an existing source. For an individual writer, choose type
              &ldquo;Individual analyst&rdquo; — their rankings blend in by weight and their notes carry their trust
              score as confidence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SourceForm existing={sources.map((s) => ({ key: s.key, label: s.label }))} />
          </CardContent>
        </Card>

        {/* --- Import ------------------------------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>Import a CSV</CardTitle>
            <CardDescription>
              Works with FantasyPros, FTN and most exports — column names are matched loosely. Rows that can&apos;t be
              matched to a player are reported, never dropped silently.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ImportForm sources={sources.map((s) => ({ key: s.key, label: s.label }))} season={cfg.season} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How weighting works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Weight</strong> blends numbers. If FTN is 1.2 and FantasyPros is 1.0,
            a player projected 250 by FTN and 220 by FantasyPros lands at about 236 — closer to FTN.
          </p>
          <p>
            <strong className="text-foreground">Trust</strong> applies to words, not numbers. When you log a note from
            a source, its trust becomes the default confidence on that piece of evidence, which is what recommendation
            scoring reads. A writer you rate at 90% moves the needle; a rumour account at 20% barely registers.
          </p>
          <p>
            Players with no projection from any enabled source fall back to an internal rank curve and are marked{' '}
            <span className="font-medium text-amber-600 dark:text-amber-500">est</span> on the board, so you always know
            which numbers are real.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
