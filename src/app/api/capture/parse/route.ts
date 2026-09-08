import { NextResponse } from "next/server";
import type { CaptureParseHints } from "@/lib/ai";
import { runCaptureParse } from "@/lib/capture-parse";
import type { CaptureStreamEvent } from "@/lib/capture-stream-protocol";
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";
import { requireUserId } from "@/lib/auth";
import { isPaywallError } from "@/lib/entitlements";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { formatSse, sseComment, sseOpeningPad } from "@/lib/sse";

export const dynamic = "force-dynamic";

/**
 * NOT 60, and not the default.
 *
 * The server action this replaces inherited 300s from `(app)/(main)/layout.tsx`. A route
 * handler inherits nothing, and a two-pass parse of a long note is an identify call plus
 * one detail call per four people plus excerpt retries — each with its own 45s deadline.
 * At 60s the stream would be killed partway through a batch, which is strictly worse than
 * the blocking action it replaced.
 */
export const maxDuration = 300;

/** How often to push a comment frame through a quiet stream. Detail batches can run 45s. */
const HEARTBEAT_MS = 15_000;

/**
 * Streaming capture parse. The server action (`parseBulkCaptureNotes`) returned everything
 * at once behind a single "Parsing…" label, so the user watched a dead button through five
 * or more sequential model calls. This reports each stage, and on the two-pass path sends
 * the roster of names as soon as the identify call lands — a full detail pass before the
 * details exist. The pipeline itself is shared with the action (`runCaptureParse`), so the
 * two cannot drift.
 *
 * Errors before the stream starts are a JSON body with a real status; after it starts the
 * status line is gone, so they are an `error` event.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json(
      { error: toUserFacingError(err, "Sign in to capture notes").message },
      { status }
    );
  }

  try {
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  const body = (await request.json().catch(() => null)) as
    | { notes?: unknown; hints?: unknown }
    | null;
  const notes = typeof body?.notes === "string" ? body.notes : "";
  if (!notes.trim()) {
    return NextResponse.json({ error: "Notes are required" }, { status: 400 });
  }
  const hints = (body?.hints ?? null) as CaptureParseHints | null;

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away between the abort check and this write. Nothing to do.
          closed = true;
        }
      };
      const send = (event: CaptureStreamEvent) => write(formatSse(event));

      // Safari buffers a streaming response until 1024 bytes have arrived. The stage events
      // below are tens of bytes each, so without this pad the whole progress sequence would
      // paint in one go there — exactly the thing this route exists to fix.
      write(sseOpeningPad());
      heartbeat = setInterval(() => write(sseComment("keepalive")), HEARTBEAT_MS);

      try {
        const result = await runCaptureParse(userId, notes, hints, (event) => {
          // Stop feeding a stream nobody is reading. `runCaptureParse` still finishes its
          // in-flight model call — there is no way to unwind that — but nothing further is
          // enqueued and the reader is released.
          if (request.signal.aborted) return;
          send(event);
        });

        if (!result.ok) {
          send({ type: "error", message: result.error });
        } else {
          send({
            type: "result",
            result: {
              sharedNotes: result.sharedNotes,
              interactionDate: result.interactionDate,
              interactionType: result.interactionType,
              anchorIso: result.anchorIso,
              anchorBasis: result.anchorBasis,
              sourceText: result.sourceText,
              sourceHash: result.sourceHash,
              suggestedReminders: result.suggestedReminders,
              suggestionsSkipped: result.suggestionsSkipped,
              mentions: result.mentions,
            },
          });
        }
      } catch (err) {
        send({
          type: "error",
          message: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
        });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
    cancel() {
      // The browser navigated away, or the panel's AbortController fired.
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
