/**
 * Server-sent event framing, shared by every stream in the app.
 *
 * This is a deliberately minimal subset of SSE: `data:` lines only, one JSON object per
 * event. No `event:`, no `id:`, no `retry:`. It was written for `/api/chat` and lifted here
 * unchanged when capture needed the same wire format — the two protocols differ only in
 * their event union, which is what the type parameter carries.
 *
 * Both halves are pure, and pinned by `scripts/smoke-chat-stream.ts` and
 * `scripts/smoke-capture-stream.ts`.
 */

/** One event, as the `data:` line the browser's parser expects. JSON never contains a raw newline. */
export function formatSse<T>(event: T): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * A comment frame. Carries no event — `parseSseChunk` ignores any line that isn't `data:` —
 * so it is free to interleave with real events. Two uses:
 *
 *   - Keepalive. A stream that goes quiet for tens of seconds (capture's detail batches run
 *     up to 45s each) can be dropped by an intermediary that sees an idle connection.
 *   - Opening pad. Safari buffers a streaming response until 1024 bytes have arrived, so a
 *     stream whose first events are a handful of small JSON objects paints all of them at
 *     once, defeating the point. `sseOpeningPad()` pushes past that threshold immediately.
 */
export function sseComment(text = ""): string {
  return `: ${text}\n\n`;
}

/** Enough bytes to clear Safari's 1024-byte streaming buffer on the first flush. */
export function sseOpeningPad(): string {
  return sseComment(" ".repeat(1024));
}

/**
 * Re-assemble events from a chunk of the stream, carrying any incomplete tail forward.
 *
 * A malformed frame is dropped rather than poisoning the rest of the stream. That is the
 * right trade for prose deltas, but it means a consumer performing a mutation cannot infer
 * success from "the stream ended" — it has to see its own terminal event. See
 * `readSseStream`'s callers.
 */
export function parseSseChunk<T>(
  chunk: string,
  carry: string
): { events: T[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: T[] = [];
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()) as T);
      } catch {
        // A malformed frame is dropped rather than poisoning the rest of the stream.
      }
    }
  }
  return { events, carry: rest };
}

/**
 * Read a `fetch` response body as a stream of events, dispatching each as it arrives.
 *
 * Factored out of `chat-stream-client.ts` because capture needs the identical reader,
 * including its one subtlety: a server that closes without a trailing blank line leaves a
 * complete frame sitting in `carry`, so the final decode feeds a synthetic `"\n\n"` to
 * flush it rather than silently dropping the last event.
 */
export async function readSseStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";

  for (;;) {
    const { done, value } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    const parsed = parseSseChunk<T>(done ? chunk + "\n\n" : chunk, carry);
    carry = done ? "" : parsed.carry;
    for (const event of parsed.events) onEvent(event);
    if (done) return;
  }
}
