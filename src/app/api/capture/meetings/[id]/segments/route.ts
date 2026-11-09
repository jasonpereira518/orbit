import { authErrorResponse, rateLimitGuard, routeError } from "@/lib/api/route-error";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { NextResponse } from "next/server";
import { recordLiveSegments, validYouClaim, type LiveSegmentInput, type YouClaim } from "@/lib/meeting-sessions";
import { requireMeetingsUser } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";

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
    return authErrorResponse(err, "Sign in to record a meeting");
  }

  const refused = sameOriginGuard(request, { message: "Cross-origin upload refused", json: true });
  if (refused) return refused;

  const recorderId = request.headers.get("x-orbit-recorder");
  if (!recorderId) {
    return NextResponse.json({ error: "Missing recorder id" }, { status: 400 });
  }

  const limited = await rateLimitGuard(() => consumeBucket("meetingChunk", userId, RATE_LIMITS.meetingChunk));
  if (limited) return limited;

  let segments: LiveSegmentInput[];
  let you: YouClaim | null = null;
  try {
    const body = (await request.json()) as { segments?: unknown; you?: unknown };
    if (!Array.isArray(body.segments)) {
      return NextResponse.json({ error: "Bad segment batch" }, { status: 400 });
    }
    segments = body.segments as LiveSegmentInput[];
    // Which speaker label is the user, once the browser knows (`claimedYou`). A malformed
    // claim is dropped rather than refusing the sentences it rode with.
    you = validYouClaim(body.you);
  } catch {
    return NextResponse.json({ error: "Bad segment batch" }, { status: 400 });
  }

  const { id } = await ctx.params;
  try {
    const result = await recordLiveSegments(userId, id, { recorderId, segments, you });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ written: result.written, durationMs: result.durationMs });
  } catch (err) {
    // 502 for a fault, as before: the recorder re-queues the batch and retries.
    return routeError(err, {
      fallback: "Couldn’t save that part of the meeting",
      where: "route.meeting-segments",
      userId,
      extra: { sessionId: id },
      faultStatus: 502,
    });
  }
}
