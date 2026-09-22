import type { ChatRecommendation } from "@/db/schema";
import { parseSseChunk, type ChatStep, type ChatStreamEvent } from "@/lib/chat-stream-protocol";

/**
 * Browser side of `/api/chat`: POST the question, read the event stream, dispatch.
 *
 * A plain `fetch` + `ReadableStream` reader rather than a chat SDK: the protocol is a
 * handful of event types and the app already owns its message state. Errors before the
 * stream starts (no key, paywall, bad input) arrive as a JSON body with a non-2xx status;
 * errors from retrieval onwards arrive as an `error` event, since the status line has
 * already been sent.
 */
export type DoneInfo = Extract<ChatStreamEvent, { type: "done" }>;

export type ChatStreamHandlers = {
  onAnswer: (delta: string) => void;
  onRecommendations: (items: ChatRecommendation[]) => void;
  /**
   * A stage of the work starting or finishing. Steps are keyed by `step.id`, and a later
   * step with the same id replaces the earlier one rather than being appended.
   */
  onStep?: (step: ChatStep) => void;
  onDone: (info: DoneInfo) => void;
  onError: (message: string) => void;
};

export const CHAT_SIGNED_OUT_MESSAGE = "You’re signed out — sign in again to keep chatting";

export type ChatResponseKind = "stream" | "signed_out" | "error";

/**
 * What came back from `/api/chat`, before a byte of it is parsed. A 200 that is not an
 * event stream is the sign-in page reached through a followed redirect — the one way a
 * signed-out request used to look like success.
 */
export function classifyChatResponse(res: {
  status: number;
  ok: boolean;
  contentType: string | null;
}): ChatResponseKind {
  if (res.status === 401) return "signed_out";
  if (!res.ok) return "error";
  return (res.contentType ?? "").toLowerCase().includes("text/event-stream")
    ? "stream"
    : "signed_out";
}

export async function streamChat(
  body: {
    question: string;
    threadId?: string | null;
    contactId?: string | null;
    /** Contact ids the composer's `@Name` chips resolved to. */
    contextContactIds?: string[];
  },
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
    handlers.onError(err instanceof Error ? err.message : "Could not reach Orbit");
    return;
  }

  const kind = classifyChatResponse({
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
  });
  if (kind === "signed_out") {
    handlers.onError(CHAT_SIGNED_OUT_MESSAGE);
    return;
  }
  if (kind === "error" || !res.body) {
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
    case "step":
      handlers.onStep?.(event.step);
      return;
    case "done":
      handlers.onDone(event);
      return;
    case "error":
      handlers.onError(event.message);
      return;
  }
}
