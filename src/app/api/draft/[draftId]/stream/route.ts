import { NextRequest } from 'next/server';
import { syncDraftPicks } from '@/lib/sync/draft';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events stream for a live draft.
 *
 * The server polls Sleeper on an interval and pushes an event to the browser
 * only when something actually changed. Doing the polling server-side means:
 *   - one poller regardless of how many tabs are open
 *   - Sleeper never sees traffic from the browser, so no CORS or rate concerns
 *   - the database is always the source of truth the UI re-reads from
 *
 * The client re-fetches full state on a `picks` event rather than receiving it
 * over the wire, which keeps this route small and means the UI and the page
 * load share exactly one code path for building state.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const cfg = await getConfig();
  const intervalMs = Math.max(1000, cfg.draftPollMs || 2500);

  const encoder = new TextEncoder();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send('open', { draftId, intervalMs });

      let lastTotal = -1;
      let consecutiveErrors = 0;

      const tick = async () => {
        if (closed) return;
        try {
          const result = await syncDraftPicks(draftId);
          consecutiveErrors = 0;

          if (result.totalPicks !== lastTotal || result.newPickNos.length > 0) {
            lastTotal = result.totalPicks;
            send('picks', {
              totalPicks: result.totalPicks,
              newPickNos: result.newPickNos,
              status: result.status,
              at: Date.now(),
            });
          } else {
            // Heartbeat keeps proxies from closing an idle connection and lets
            // the UI show an honest "last checked" time.
            send('heartbeat', { at: Date.now(), status: result.status });
          }

          if (result.status === 'complete') {
            send('complete', { at: Date.now() });
          }
        } catch (error) {
          consecutiveErrors += 1;
          send('error', {
            message: error instanceof Error ? error.message : String(error),
            consecutiveErrors,
          });
          // Sleeper hiccups happen. Only give up after sustained failure so a
          // transient blip doesn't kill the room mid-draft.
          if (consecutiveErrors >= 20) {
            send('fatal', { message: 'Giving up after 20 consecutive failures. Reload to retry.' });
            closed = true;
            controller.close();
            return;
          }
        }

        if (!closed) timer = setTimeout(tick, intervalMs);
      };

      timer = setTimeout(tick, 250);

      request.signal.addEventListener('abort', () => {
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
