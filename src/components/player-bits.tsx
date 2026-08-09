import { cn } from '@/lib/utils';
import { POSITION_BG } from '@/lib/enums';
import { Badge } from '@/components/ui/primitives';

/**
 * Shared player-display atoms. Position colour is used consistently everywhere
 * so a glance at the board, the pick feed and the roster panels all read the
 * same way.
 */

export function PosBadge({ position, rank, className }: { position: string; rank?: number | null; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[2.75rem] justify-center rounded border px-1.5 py-0.5 text-[11px] font-semibold tabular',
        POSITION_BG[position] ?? 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {position}
      {rank ?? ''}
    </span>
  );
}

export function TierChip({ tier }: { tier: number }) {
  return (
    <span className="inline-flex min-w-[1.75rem] justify-center rounded bg-secondary px-1 py-0.5 text-[11px] font-medium tabular text-secondary-foreground">
      T{tier}
    </span>
  );
}

/** Injury designation, shown only when there is something to say. */
export function InjuryTag({ status }: { status?: string | null }) {
  if (!status) return null;
  const s = status.toLowerCase();
  const variant = s.includes('out') || s.includes('ir') || s.includes('pup') ? 'destructive' : 'warning';
  return (
    <Badge variant={variant} className="px-1 py-0 text-[10px] uppercase">
      {status.slice(0, 3)}
    </Badge>
  );
}

/**
 * ADP delta, shown as picks of value.
 *
 * Stored as `overallRank - adp`, so a NEGATIVE stored delta is the good case:
 * we rank him ahead of where the market drafts him. Displaying that raw means
 * showing a green "−20", which reads wrong at a glance under time pressure.
 * So the sign is flipped for display: **positive means picks of value**, and
 * the colour follows the displayed number.
 */
export function ValueDelta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) return <span className="text-muted-foreground">—</span>;
  const value = Math.round(-delta);
  if (Math.abs(value) < 5) return <span className="text-muted-foreground tabular">±{Math.abs(value)}</span>;
  return (
    <span
      className={cn(
        'tabular font-medium',
        value > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
      )}
      title={
        value > 0
          ? `We rank him ${value} picks ahead of where the market drafts him`
          : `Market drafts him ${Math.abs(value)} picks ahead of our board`
      }
    >
      {value > 0 ? `+${value}` : value}
    </span>
  );
}

/**
 * Flags a player whose points were discounted because a trusted analyst
 * explicitly listed him as "do not draft." The discount is real and visible
 * on the number, not a silent adjustment — hover to see which source(s)
 * flagged him.
 */
export function AvoidFlag({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return (
    <span
      title={`Flagged "do not draft" by ${sources.join(', ')} — points discounted accordingly.`}
      className="cursor-help rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] font-semibold uppercase text-rose-600 dark:text-rose-400"
    >
      avoid
    </span>
  );
}

/** Flags a number that came from the fallback curve rather than a real source. */
export function BaselineFlag({ isBaseline }: { isBaseline: boolean }) {
  if (!isBaseline) return null;
  return (
    <span
      title="No imported projection for this player — value derived from the fallback rank curve. Import projections on the Sources page."
      className="cursor-help text-[10px] font-medium text-amber-600 dark:text-amber-500"
    >
      est
    </span>
  );
}

export function TeamTag({ teamId }: { teamId: string | null | undefined }) {
  if (!teamId) return <span className="text-xs text-muted-foreground">FA</span>;
  return <span className="text-xs text-muted-foreground">{teamId}</span>;
}
