/**
 * Browser side of `/api/capture/parse`.
 *
 * A plain `fetch` + stream reader rather than an SSE library, matching
 * `chat-stream-client.ts`: the protocol is five event types and the panel already owns its
 * own review state.
 *
 * Two things this does that the chat client does not.
 *
 * It takes an `AbortSignal` and its caller actually passes one. `streamChat` accepts a
 * signal that neither of its callers supplies, so an abandoned chat runs to completion
 * server-side; capture's parse is far more expensive, and "Start over" should stop it.
 *
 * It insists on a terminal event. `parseSseChunk` drops malformed frames rather than
 * poisoning the stream, which is right for prose deltas but means a consumer cannot read
 * "the stream ended" as success — a mangled `result` frame would otherwise leave the panel
 * spinning forever with no error and no way back.
 */

import type { CaptureStreamEvent } from "@/lib/capture-stream-protocol";
import { readSseStream } from "@/lib/sse";

export type CaptureStreamHandlers = {
  onEvent: (event: CaptureStreamEvent) => void;
  onError: (message: string) => void;
};

export async function streamCaptureParse(
  input: { notes: string; hints?: unknown },
  handlers: CaptureStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/capture/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: input.notes, hints: input.hints ?? null }),
      signal,
    });
  } catch (err) {
    // An abort is the user's own doing — "Start over", or leaving the page. Silent.
    if (isAbort(err)) return;
    handlers.onError("Could not reach the server");
    return;
  }

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    handlers.onError(body?.error || `Extraction failed (${res.status})`);
    return;
  }

  let sawTerminal = false;
  try {
    await readSseStream<CaptureStreamEvent>(res.body, (event) => {
      if (event.type === "result" || event.type === "error") sawTerminal = true;
      handlers.onEvent(event);
    });
  } catch (err) {
    if (isAbort(err)) return;
    handlers.onError("The connection dropped");
    return;
  }

  if (!sawTerminal && !signal?.aborted) {
    handlers.onError("Extraction ended without finishing — try again");
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
