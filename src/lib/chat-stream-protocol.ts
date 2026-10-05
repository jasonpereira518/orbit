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

import type { EvidenceSource } from "@/lib/chat-evidence";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";

export const RECOMMENDATIONS_MARKER = "---RECOMMENDATIONS---";

export type RawRecommendation = {
  contact_id?: string | null;
  recruiter_id?: string | null;
  name: string;
  reason: string;
  suggested_action: string;
  draft_message: string | null;
};

/** The model's own shape for a proposal — validated and re-typed by `validateProposedActions`. */
export type RawProposedAction = unknown;

export type SplitResult = {
  answer: string;
  recommendations: RawRecommendation[];
  /** Present when the model proposed an action. Unvalidated — see `@/lib/chat-proposed-actions`. */
  proposedActions: RawProposedAction[];
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
        return { answer: prose.trim(), recommendations: [], proposedActions: [] };
      }
      const parsed = parseRecommendations(afterMarker);
      return { answer: prose.trim(), ...parsed };
    },
  };
}

function parseRecommendations(raw: string): Pick<SplitResult, "recommendations" | "proposedActions" | "parseError"> {
  let text = raw.trim();
  // Tolerate a fenced block, and an object wrapping the array.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text) return { recommendations: [], proposedActions: [] };
  try {
    const value: unknown = JSON.parse(text);
    // Both the bare array (recommendations only, the original shape) and the wrapper object
    // (recommendations plus proposed_actions) are tolerated — a model that has not been asked
    // for proposals, or answers a question with none, still parses the same way it always did.
    const list = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { recommendations?: unknown }).recommendations)
        ? (value as { recommendations: unknown[] }).recommendations
        : null;
    if (!list) return { recommendations: [], proposedActions: [], parseError: "recommendations is not an array" };
    const proposedActions =
      value && typeof value === "object" && Array.isArray((value as { proposed_actions?: unknown }).proposed_actions)
        ? (value as { proposed_actions: unknown[] }).proposed_actions
        : [];
    return {
      recommendations: list.filter(
        (r): r is RawRecommendation => Boolean(r) && typeof r === "object" && typeof (r as RawRecommendation).name === "string"
      ),
      proposedActions,
    };
  } catch (err) {
    return { recommendations: [], proposedActions: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Server-sent events                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One stage of the work behind an answer, as the user sees it.
 *
 * Every step describes work that actually ran: the labels and counts are written on the
 * server from real results, and a stage that does not run (no org in the question, no
 * overdue follow-ups) emits nothing at all rather than a "skipped" step. Nothing here is
 * scripted on a timer — if the wire says "Searched 412 contacts", 412 rows were searched.
 */
export type ChatStepKind =
  | "understand"
  | "search"
  | "rank"
  | "roster"
  | "attention"
  | "recruiters"
  | "attached"
  | "read"
  /** The research loop before a multi-step answer — one step, relabelled per lookup. */
  | "gather"
  | "answer"
  | "verify";

/** A record a step touched, so the expanded view can link to the thing itself. */
export type ChatStepRef = {
  id: string;
  name: string;
  kind: "contact" | "recruiter" | "org";
  /**
   * The contact's photo, when they have a stored one — a short browser-safe URL from
   * `clientAvatarUrlSql`, never image bytes. Resolved off the critical path and patched onto
   * the step a moment after it is first sent, so a ref can arrive without it and gain it
   * later; absent means "no known photo", and the avatar shows its illustration.
   */
  photoUrl?: string | null;
};

export type ChatStep = {
  /** Stable within one answer, so a later update replaces a step rather than appending. */
  id: string;
  kind: ChatStepKind;
  /** A finished sentence, written server-side: "Searching 412 contacts". */
  label: string;
  /** The secondary line: which arms ran, which filters were parsed. */
  detail?: string;
  status: "active" | "done";
  /** Wall-clock for the stage, set when it finishes. */
  ms?: number;
  refs?: ChatStepRef[];
};

export type ChatStreamEvent =
  | { type: "answer"; delta: string }
  | { type: "recommendations"; items: unknown[] }
  | { type: "step"; step: ChatStep }
  /**
   * The sources actually cited in the answer — see `@/lib/chat-evidence`. Sent once, after
   * `recommendations` and before `done`, only when at least one citation survived. `items`
   * is keyed by the `[eN]` id, ids only, no snippet text: the popover that shows one fetches
   * it live and user-scoped (`getEvidenceSnippet`), so nothing extra sits in the wire payload
   * or the row this later persists into.
   */
  | { type: "evidence"; items: Record<string, EvidenceSource> }
  /** Actions this answer proposed, already validated — see `@/lib/chat-proposed-actions`. */
  | { type: "actions"; items: StoredProposedAction[] }
  | {
      type: "done";
      messageId: string | null;
      /** The user row this turn persisted, so the client can address it — pencil-edit, versions. */
      userMessageId: string | null;
      threadId: string | null;
      title: string | null;
      /** Present when this turn was a version of an earlier one. See `@/lib/chat-versions`. */
      version?: { slot: string; version: number } | null;
      /** The relevance-ranked contacts the answer was grounded in (the ask bar shows them). */
      retrieved: Array<{
        id: string;
        fullName: string;
        company: string | null;
        title: string | null;
        relevance: number;
      }>;
      /** One line of context about how the answer was found, e.g. keywords-only search. */
      notice?: string | null;
      /** Rule-derived next questions — see `deriveFollowUps`. Never model-generated. */
      followUps?: string[];
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
