import { NextResponse } from "next/server";
import { requireMeetingsUser } from "@/lib/plan-guards";
import { isPaywallError } from "@/lib/entitlements";
import { friendlyError } from "@/lib/errors";
import { deepgramEnabled, mintStreamToken } from "@/lib/deepgram";
import { keytermsFor } from "@/lib/deepgram-params";
import { loadNetworkVocabulary } from "@/lib/transcription-vocabulary";
import { ACCEPTS_CHUNKS, getMeetingSession } from "@/lib/meeting-sessions";
import { speechAllowance } from "@/lib/speech-quota";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportedFailure } from "@/lib/report-error";

export const dynamic = "force-dynamic";

/**
 * A 30-second Deepgram token for a meeting recording. The browser opens its own connection
 * with it, so Orbit's key never reaches a client and a leaked token buys one short session
 * — same promise as `/api/speech/token`, but scoped to a specific meeting: Pro/Lifetime
 * only, the session must be this user's, and a browser that isn't the session's current
 * recorder is refused.
 *
 *   POST /api/capture/meetings/:id/stream-token
 *   x-orbit-recorder: <the recorder id the session was started or resumed with>
 *
 * Responses: 200 {accessToken, expiresIn, keyterms, remainingSeconds, warn}, 401/403 not
 * signed in or not on a meetings plan, 404 the meeting isn't this user's, 410 it's already
 * analyzed/saved/discarded (same `ACCEPTS_CHUNKS` list `ingestMeetingChunk` and
 * `recordLiveSegments` check, so a stale tab can't keep buying tokens for audio nothing
 * will ever store), 409 another tab is recording it, 402 this month's meeting allowance is
 * gone, 429 with Retry-After, 503 Deepgram itself is off, 502 the grant call failed.
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
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  try {
    await consumeBucket("speechToken", userId, RATE_LIMITS.speechToken);
  } catch (err) {
    if (isRateLimitedError(err)) {
      // Matches every other rate-limited route (see meetings/[id]/chunks): the error's own
      // message already carries the bucket's label and the wait, and friendlyError would
      // just discard both in favor of a generic fallback since RateLimitedError isn't one
      // of its recognized "own words".
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } },
      );
    }
    throw err;
  }

  const { id } = await ctx.params;
  const session = await getMeetingSession(userId, id);
  if (!session) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  if (!ACCEPTS_CHUNKS.includes(session.status)) {
    return NextResponse.json({ error: "This meeting is no longer recording" }, { status: 410 });
  }
  const recorderId = request.headers.get("x-orbit-recorder");
  if (session.status === "recording" && session.recorderId && recorderId !== session.recorderId) {
    return NextResponse.json({ error: "Another tab is recording this meeting" }, { status: 409 });
  }

  if (!deepgramEnabled()) {
    return NextResponse.json({ error: "Live transcription is unavailable right now" }, { status: 503 });
  }

  const allowance = await speechAllowance(userId, "meeting");
  if (allowance.exhausted) {
    return NextResponse.json(
      { error: "You’ve used this month’s meeting transcription minutes" },
      { status: 402 },
    );
  }

  try {
    const [{ accessToken, expiresIn }, vocabulary] = await Promise.all([
      mintStreamToken(),
      loadNetworkVocabulary(userId),
    ]);
    return NextResponse.json(
      {
        accessToken,
        expiresIn,
        keyterms: keytermsFor(vocabulary),
        remainingSeconds: allowance.remaining,
        warn: allowance.warn,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const failure = reportedFailure(err, "Couldn’t start meeting transcription", {
      where: "route.meeting-stream-token",
      userId,
      extra: { sessionId: id },
    });
    return NextResponse.json({ error: failure.error, ref: failure.ref }, { status: 502 });
  }
}
