import type { ChatRecommendation } from "@/db/schema";
import { parseSseChunk, type ChatStreamEvent } from "@/lib/chat-stream-protocol";

/**
 * Browser side of `/api/chat`: POST the question, read the event stream, dispatch.
 *
 * A plain `fetch` + `ReadableStream` reader rather than a chat SDK: the protocol is three
 * event types and the app already owns its message state. Errors before the stream starts
 * (no key, paywall, bad input) arrive as a JSON body with a non-2xx status; errors after
 * it starts arrive as an `error` event, since the status line has already been sent.
 */
export type DoneInfo = Extract<ChatStreamEvent, { type: "done" }>;

export type ChatStreamHandlers = {
  onAnswer: (delta: string) => void;
  onRecommendations: (items: ChatRecommendation[]) => void;
  onDone: (info: DoneInfo) => void;
  onError: (message: string) => void;
};

/**
 * Whether this failure is the caller's own Stop button rather than something going wrong.
 *
 * Aborting a fetch rejects, and the rejection reached `onError` like any other — so pressing
 * Stop showed a red toast reading "BodyStreamBuffer was aborted" and, because the panel's
 * error path clears the turn, deleted the question and the partial answer along with it.
 * Stopping a reply you asked for is not an error, and it certainly is not a reason to throw
 * away what the person typed.
 *
 * Both the DOMException name and the signal are checked: the name is what the platform
 * throws for `fetch`, and the signal covers a reader rejecting with something else after the
 * abort has already landed.
 */
function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof DOMException && err.name === "AbortError";
}

export async function streamChat(
  body: { question: string; threadId?: string | null; contactId?: string | null },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err, signal)) return;
    handlers.onError(err instanceof Error ? err.message : "Could not reach Orbit");
    return;
  }

  if (!res.ok || !res.body) {
    let message = `Chat failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Not JSON; keep the status message.
    }
    handlers.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let done = false;
  try {
    while (!done) {
      const { value, done: finished } = await reader.read();
      done = finished;
      const chunk = value ? decoder.decode(value, { stream: !finished }) : "";
      const parsed = parseSseChunk(chunk, carry);
      carry = parsed.carry;
      for (const event of parsed.events) dispatch(event, handlers);
    }
    // A final frame without a trailing blank line.
    if (carry.trim()) {
      const parsed = parseSseChunk("\n\n", carry);
      for (const event of parsed.events) dispatch(event, handlers);
    }
  } catch (err) {
    // Whatever streamed before the stop stays on screen; the caller asked for it to end.
    if (isAbort(err, signal)) return;
    handlers.onError(err instanceof Error ? err.message : "The connection dropped");
  }
}

function dispatch(event: ChatStreamEvent, handlers: ChatStreamHandlers) {
  switch (event.type) {
    case "answer":
      handlers.onAnswer(event.delta);
      return;
    case "recommendations":
      handlers.onRecommendations(event.items as ChatRecommendation[]);
      return;
    case "done":
      handlers.onDone(event);
      return;
    case "error":
      handlers.onError(event.message);
      return;
  }
}
