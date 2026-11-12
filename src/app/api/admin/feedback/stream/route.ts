import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { feedbackInboxPulse, type FeedbackInboxPulse } from "@/lib/admin-feedback";
import { requireUserId } from "@/lib/auth";

/**
 * The feedback inbox, live: a server-sent event whenever a new report lands or someone
 * replies in a conversation, so `/admin/feedback` refreshes itself instead of waiting for a
 * reload. Same shape and cost reasoning as `/api/feedback/[feedbackId]/stream` — one cheap
 * count a second, a rolled connection, and `maxDuration = 60` (an existing value, so no new
 * Vercel function under the Hobby cap).
 */
export const maxDuration = 60;

const STREAM_MS = 55_000;
const TICK_MS = 1_000;
const HEARTBEAT_MS = 15_000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function GET(request: Request) {
  let userId: string | null = null;
  try {
    userId = await requireUserId();
  } catch {
    userId = null;
  }
  // The console's own rule. A 404, like every admin surface, rather than saying it exists.
  if (!isAdminUser(userId)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader went away; the loop notices the abort.
        }
      };
      write("retry: 1000\n\n");

      let last: FeedbackInboxPulse | null = null;
      const started = Date.now();
      let quietSince = Date.now();
      try {
        while (!request.signal.aborted && Date.now() - started < STREAM_MS) {
          const now = await feedbackInboxPulse();
          // The first reading is the baseline: only a CHANGE is news. Each reconnect takes a
          // fresh baseline; the page is already current when it connects.
          if (last && (now.reports !== last.reports || now.replies !== last.replies)) {
            write(
              `event: inbox\ndata: ${JSON.stringify({
                newReports: Math.max(0, now.reports - last.reports),
                newReplies: Math.max(0, now.replies - last.replies),
              })}\n\n`
            );
            quietSince = Date.now();
          } else if (Date.now() - quietSince > HEARTBEAT_MS) {
            quietSince = Date.now();
            write(": ping\n\n");
          }
          last = now;
          await sleep(TICK_MS, request.signal);
        }
      } catch {
        // EventSource reconnects and takes a new baseline.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
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
