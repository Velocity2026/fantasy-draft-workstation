import { NextRequest, NextResponse } from 'next/server';
import { loadDraftRoomState } from '@/lib/draft/state';

export const dynamic = 'force-dynamic';

/**
 * Full draft-room state as JSON. The live room re-fetches this whenever the SSE
 * stream reports a change, so the initial server render and every live update
 * are produced by the same function — there is no second, drifting code path.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  try {
    const state = await loadDraftRoomState(draftId);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
