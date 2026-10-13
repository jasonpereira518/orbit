import { NextResponse } from "next/server";
import { getMeetingCandidates } from "@/actions/meetings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The calendar nudge's read, over plain `fetch` instead of a Server Action.
 *
 * The nudge store polls this from every app page (3 s after load, then every ten minutes),
 * and each call is a live Google Calendar request. Next dispatches Server Actions one at a
 * time per tab, so as an action it held that queue while Google answered, and whatever the
 * person clicked meanwhile waited behind it — the same reason the avatar backfill moved to
 * a route. Same function, same auth, rate limit and cache, same result shape. A read, so a
 * GET: a cross-site page cannot read the JSON it returns.
 */
export async function GET() {
  return NextResponse.json(await getMeetingCandidates(), { headers: { "Cache-Control": "no-store" } });
}
