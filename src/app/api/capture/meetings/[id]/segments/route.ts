import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/errors";
import { reportedFailure } from "@/lib/report-error";
import { isPaywallError } from "@/lib/entitlements";
import { recordLiveSegments, type LiveSegmentInput } from "@/lib/meeting-sessions";
import { requireMeetingsUser } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A batch of live segments from a meeting streaming straight to Deepgram in the browser:
 * finished sentences in, stored (and metered) out.
 *
 *   POST /api/capture/meetings/:id/segments
 *   x-orbit-recorder: <the recorder id the session was started or resumed with>
 *   body: { segments: { seq, startMs, endMs, speaker, text }[] }
 *
 * The custom header is also the CSRF guard, same as the chunk route: a cross-site form
 * cannot set it, and a cross-site `fetch` that does is preflighted and refused.
 *
 * Responses the recorder acts on: 200 stored (possibly a partial no-op repeat), 400 a bad
 * batch, 404 the meeting isn't this user's, 409 another tab owns the session, 410 the
 * meeting was saved or discarded, 429 with Retry-After.
 */
type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Params) {
  let userId: string;
  try {
    userId = await requireMeetingsUser();
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json({ error: friendlyError(err, "Sign in to record a meeting") }, { status });
  }

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Cross-origin upload refused" }, { status: 403 });
  }

  const recorderId = request.headers.get("x-orbit-recorder");
  if (!recorderId) {
    return NextResponse.json({ error: "Missing recorder id" }, { status: 400 });
  }

  try {
    await consumeBucket("meetingChunk", userId, RATE_LIMITS.meetingChunk);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  let segments: LiveSegmentInput[];
  try {
    const body = (await request.json()) as { segments?: unknown };
    if (!Array.isArray(body.segments)) {
      return NextResponse.json({ error: "Bad segment batch" }, { status: 400 });
    }
    segments = body.segments as LiveSegmentInput[];
  } catch {
    return NextResponse.json({ error: "Bad segment batch" }, { status: 400 });
  }

  const { id } = await ctx.params;
  try {
    const result = await recordLiveSegments(userId, id, { recorderId, segments });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ written: result.written, durationMs: result.durationMs });
  } catch (err) {
    const failure = reportedFailure(err, "Couldn’t save that part of the meeting", {
      where: "route.meeting-segments",
      userId,
      extra: { sessionId: id },
    });
    return NextResponse.json({ error: failure.error, ref: failure.ref }, { status: 502 });
  }
}
