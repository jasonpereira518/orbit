import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { requireUserId } from "@/lib/auth";
import { authErrorResponse } from "@/lib/api/route-error";
import { loadThread, markThreadRead, type FeedbackThread } from "@/lib/feedback-thread";

/**
 * A feedback conversation, live: server-sent events carrying the whole thread every time it
 * changes, so a reply shows up on the other side within about a second.
 *
 * Reuses `maxDuration = 60` on purpose. Vercel Hobby caps a deployment at 12 functions and
 * every DISTINCT maxDuration value is its own function; 60 already exists, so this route costs
 * none. The stream ends a few seconds before that ceiling and `retry:` tells EventSource to
 * reconnect at once — to the person reading, it is one continuous connection.
 *
 * ponytail: the server checks the thread once a second per open connection (two indexed
 * reads). Fine at a founder's feedback volume; move to Postgres LISTEN/NOTIFY or a pub/sub
 * channel if many conversations are ever open at once.
 */
export const maxDuration = 60;

const STREAM_MS = 55_000;
const TICK_MS = 1_000;
const HEARTBEAT_MS = 15_000;

/** What, if it differs, is worth sending: new messages, a status change, the gift opened. */
function signature(thread: FeedbackThread): string {
  return JSON.stringify([
    thread.messages.map((m) => m.id),
    thread.status,
    thread.thanksCredits,
    thread.thanksSeen,
  ]);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ feedbackId: string }> }
) {
  const { feedbackId } = await params;

  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    return authErrorResponse(err, "Sign in to see this conversation");
  }

  // `?as=operator` is the admin console's side; anyone else only ever sees their own report.
  // `isAdminUser` alone — the console's own rule (`requireAdminUserId`) — so a local dev server
  // streams to the console it already lets in.
  const asOperator = new URL(request.url).searchParams.get("as") === "operator";
  if (asOperator && !isAdminUser(userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const viewer = asOperator ? ("operator" as const) : { userId };

  const first = await loadThread(feedbackId, viewer);
  if (!first) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader went away mid-write; the loop below notices the abort and stops.
        }
      };
      const send = async (thread: FeedbackThread) => {
        // Reading it live counts as reading it — the same rule as opening the thread. The
        // reporter only "reads" once there is something of the operator's to have seen.
        if (asOperator) await markThreadRead(feedbackId, "operator");
        else if (thread.open) await markThreadRead(feedbackId, "user", userId);
        write(`event: thread\ndata: ${JSON.stringify(thread)}\n\n`);
      };

      write("retry: 1000\n\n");
      let last = signature(first);
      await send(first);

      const started = Date.now();
      let quietSince = Date.now();
      try {
        while (!request.signal.aborted && Date.now() - started < STREAM_MS) {
          await sleep(TICK_MS, request.signal);
          if (request.signal.aborted) break;
          const thread = await loadThread(feedbackId, viewer);
          if (!thread) {
            write("event: gone\ndata: {}\n\n");
            break;
          }
          const next = signature(thread);
          if (next !== last) {
            last = next;
            quietSince = Date.now();
            await send(thread);
          } else if (Date.now() - quietSince > HEARTBEAT_MS) {
            // A comment line keeps proxies from closing an idle connection.
            quietSince = Date.now();
            write(": ping\n\n");
          }
        }
      } catch {
        // A failed read ends this connection; EventSource reconnects and the next one starts
        // with a fresh copy of the thread.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the reader going away.
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
