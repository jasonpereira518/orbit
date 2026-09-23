import { NextResponse } from "next/server";
import { MEETING_CHUNK_MAX_BYTES } from "@/lib/capture-limits";
import { friendlyError } from "@/lib/errors";
import { chunkFailureResponse } from "@/lib/meeting-chunk-errors";
import { reportedFailure } from "@/lib/report-error";
import { isPaywallError } from "@/lib/entitlements";
import { ingestMeetingChunk } from "@/lib/meeting-sessions";
import { requireMeetingsUser } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// One chunk is one transcription, whose own deadline is 90s (`TRANSCRIBE_TIMEOUT_MS`).
export const maxDuration = 120;

/**
 * One chunk of a live meeting: raw 16 kHz WAV in, its transcript out.
 *
 * A route handler rather than a server action, deliberately and unlike the rest of
 * capture. Next dispatches server actions one at a time per client, so a chunk upload
 * that takes ten seconds to transcribe would block every other action on the page — and
 * during a meeting one of these is in flight most of the time. It also takes the body as
 * raw bytes, where an action would need base64 and a third more of the 4.5MB Vercel allows.
 *
 *   POST /api/capture/meetings/:id/chunks?seq=N&startMs=A&endMs=B[&silent=1]
 *   x-orbit-recorder: <the recorder id the session was started or resumed with>
 *
 * The custom header is also the CSRF guard: a cross-site form cannot set it, and a
 * cross-site `fetch` that does is preflighted and refused.
 *
 * Responses the recorder acts on: 200 stored (possibly a repeat), 402 this month's meeting
 * hours are gone so recovery is refused too (stop retrying), 409 another tab owns the
 * session, 410 the meeting was saved or discarded, 413 too big, 422 no usable
 * transcription key — missing, rejected, out of credit or unknown model (stop retrying),
 * 429 with Retry-After, 502 transcription failed (retry).
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

  const url = new URL(request.url);
  const silent = url.searchParams.get("silent") === "1";
  const meta = {
    seq: Number(url.searchParams.get("seq")),
    startMs: Number(url.searchParams.get("startMs")),
    endMs: Number(url.searchParams.get("endMs")),
    recorderId,
  };

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MEETING_CHUNK_MAX_BYTES) {
    return NextResponse.json({ error: "That chunk is too large" }, { status: 413 });
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

  let wav: Uint8Array | null = null;
  if (!silent) {
    const body = new Uint8Array(await request.arrayBuffer());
    // Content-Length is advisory; the bytes are what count.
    if (body.byteLength > MEETING_CHUNK_MAX_BYTES) {
      return NextResponse.json({ error: "That chunk is too large" }, { status: 413 });
    }
    if (!isWav(body)) {
      return NextResponse.json({ error: "Expected a WAV chunk" }, { status: 400 });
    }
    wav = body;
  }

  const { id } = await ctx.params;
  try {
    const result = await ingestMeetingChunk(userId, id, meta, wav);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      seq: result.seq,
      text: result.text,
      engine: result.engine,
      duplicate: result.duplicate,
    });
  } catch (err) {
    // A key problem is terminal to the recorder: no key, one the provider refuses, an
    // empty balance or a model it does not have fail every later chunk identically.
    const refusal = chunkFailureResponse(err);
    if (refusal.status === 422) {
      return NextResponse.json(refusal.body, { status: 422 });
    }
    // Anything else is retried by the recorder; report it so a failing provider is visible.
    const failure = reportedFailure(err, "Couldn’t transcribe that part of the meeting", {
      where: "route.meeting-chunk",
      userId,
      extra: { sessionId: id },
    });
    return NextResponse.json({ error: failure.error, ref: failure.ref }, { status: 502 });
  }
}

/** `RIFF....WAVE` — enough to refuse something that is plainly not our recorder's output. */
function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false;
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}
