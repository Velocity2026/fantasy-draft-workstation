'use client';

import * as React from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import type { ActionResult } from '@/app/actions';

/**
 * On-demand AI write-up. Deliberately not generated on page load: it costs an
 * API call, and during a draft the numbers matter more than the prose. You ask
 * for it when you want a second opinion.
 */
export function AiSummary({
  title,
  action,
  hint,
}: {
  title: string;
  action: () => Promise<ActionResult>;
  hint?: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cached, setCached] = React.useState(false);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      const data = result.data as { content?: string; cached?: boolean } | undefined;
      if (result.ok && data?.content) {
        setContent(data.content);
        setCached(data.cached ?? false);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <Button variant="outline" size="sm" onClick={run} disabled={pending}>
            {pending ? 'Thinking…' : content ? 'Regenerate' : 'Write it up'}
          </Button>
        </div>
        {hint && !content ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      {content || error ? (
        <CardContent>
          {error ? (
            <p className="text-sm text-amber-600 dark:text-amber-500">{error}</p>
          ) : (
            <>
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{content}</div>
              {cached ? <p className="pt-2 text-[10px] text-muted-foreground">cached — nothing has changed since this was written</p> : null}
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
