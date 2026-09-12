/**
 * The wire protocol for a streamed chat answer.
 *
 * A streamed answer cannot be a JSON object — the prose has to reach the browser as the
 * model produces it, and JSON is unreadable until it closes. So the model is asked to
 * write the answer as prose, then a marker line, then the recommendations as JSON. Two
 * halves live here, both pure and both pinned by `scripts/smoke-chat-stream.ts`:
 *
 *   - `createAnswerSplitter()` turns raw model deltas into prose deltas to forward, holding
 *     back only the few characters that might be the start of the marker, and parses what
 *     follows the marker once the stream ends.
 *   - `formatSse` / `parseSseChunk` frame the events the route sends and re-assemble them
 *     in the browser across arbitrary chunk boundaries.
 */

export const RECOMMENDATIONS_MARKER = "---RECOMMENDATIONS---";

export type RawRecommendation = {
  contact_id?: string | null;
  recruiter_id?: string | null;
  name: string;
  reason: string;
  suggested_action: string;
  draft_message: string | null;
};

export type SplitResult = {
  answer: string;
  recommendations: RawRecommendation[];
  parseError?: string;
};

/** How much prose to hold back: anything that could still turn out to be the marker. */
function markerPrefixLength(tail: string): number {
  const max = Math.min(tail.length, RECOMMENDATIONS_MARKER.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (RECOMMENDATIONS_MARKER.startsWith(tail.slice(-n))) return n;
  }
  return 0;
}

export function createAnswerSplitter() {
  let prose = "";
  let pending = "";
  let afterMarker: string | null = null;

  return {
    /** Feed one raw delta; returns the prose delta safe to forward now ("" if none). */
    push(delta: string): string {
      if (afterMarker !== null) {
        afterMarker += delta;
        return "";
      }
      pending += delta;
      const at = pending.indexOf(RECOMMENDATIONS_MARKER);
      if (at >= 0) {
        const out = pending.slice(0, at);
        afterMarker = pending.slice(at + RECOMMENDATIONS_MARKER.length);
        pending = "";
        prose += out;
        return out;
      }
      const hold = markerPrefixLength(pending);
      const out = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      prose += out;
      return out;
    },
    /** Flush whatever was held back and parse the recommendations. */
    finish(): SplitResult {
      if (afterMarker === null) {
        prose += pending;
        pending = "";
        return { answer: prose.trim(), recommendations: [] };
      }
      const parsed = parseRecommendations(afterMarker);
      return { answer: prose.trim(), ...parsed };
    },
  };
}

function parseRecommendations(raw: string): Pick<SplitResult, "recommendations" | "parseError"> {
  let text = raw.trim();
  // Tolerate a fenced block, and an object wrapping the array.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text) return { recommendations: [] };
  try {
    const value: unknown = JSON.parse(text);
    const list = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { recommendations?: unknown }).recommendations)
        ? (value as { recommendations: unknown[] }).recommendations
        : null;
    if (!list) return { recommendations: [], parseError: "recommendations is not an array" };
    return {
      recommendations: list.filter(
        (r): r is RawRecommendation => Boolean(r) && typeof r === "object" && typeof (r as RawRecommendation).name === "string"
      ),
    };
  } catch (err) {
    return { recommendations: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Server-sent events                                                          */
/* -------------------------------------------------------------------------- */

export type ChatStreamEvent =
  | { type: "answer"; delta: string }
  | { type: "recommendations"; items: unknown[] }
  | {
      type: "done";
      messageId: string | null;
      threadId: string | null;
      title: string | null;
      /** The relevance-ranked contacts the answer was grounded in (the ask bar shows them). */
      retrieved: Array<{
        id: string;
        fullName: string;
        company: string | null;
        title: string | null;
        relevance: number;
      }>;
    }
  | { type: "error"; message: string };

/** One event, as the `data:` line the browser's parser expects. JSON never contains a raw newline. */
export function formatSse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Re-assemble events from a chunk of the stream, carrying any incomplete tail forward. */
export function parseSseChunk(chunk: string, carry: string): { events: ChatStreamEvent[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ChatStreamEvent[] = [];
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
      } catch {
        // A malformed frame is dropped rather than poisoning the rest of the stream.
      }
    }
  }
  return { events, carry: rest };
}
