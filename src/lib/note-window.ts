/**
 * Which part of a long note the model gets to read.
 *
 * THE BUG THIS EXISTS FOR. Retrieval scores a contact over their WHOLE note — the semantic
 * arm embeds it, the FTS arm indexes it — but the prompt then took `notes.slice(0, 1200)`.
 * So a note whose only mention of "Series A" sits 3,000 characters in would rank the contact
 * first and then hand the model 1,200 characters that never say "Series A". The model, doing
 * exactly as it is told, answers that it has nothing on that — about the person it just
 * surfaced BECAUSE of that sentence. The retrieval was right and the answer was wrong, which
 * is the worst shape a grounding bug can take: it reads as the model being stupid.
 *
 * So: score fixed windows by how many of the question's content words they contain, and send
 * the best one. No model call, no embedding, no schema — the tokens come from
 * `@/lib/search-tokens`, the same list the FTS arm OR-expands with, so the window can never
 * trim away the word that did the finding.
 *
 * Pure: no DB, no React, no AI. `scripts/smoke-note-window.ts` drives it directly.
 */
import { contentTokens } from "@/lib/search-tokens";

/**
 * How far the window slides each step, as a fraction of its own length.
 *
 * Quarter-steps, so a match near a window's edge still lands mid-window in one of its
 * neighbours. Whole-window steps would let a sentence straddling a boundary score half its
 * weight in each of two windows and lose to a worse-but-centred one.
 */
const STRIDE_FRACTION = 0.25;

/** Beyond this, scoring every window of a pathological note costs more than it returns. */
const MAX_WINDOWS = 64;

export type NoteWindow = {
  /** The chosen text, already trimmed to `budget` and marked if it is not the head. */
  text: string;
  /** Where it started in the original note. 0 means the head, i.e. the old behaviour. */
  offset: number;
  /** How many distinct query terms it carries. 0 means nothing matched and we took the head. */
  matched: number;
};

/**
 * The most relevant `budget` characters of `notes` for `query`.
 *
 * Falls back to the head — the old behaviour — when the note is short enough to send whole,
 * when the query has no content words, or when nothing matches. Never returns more than
 * `budget` characters plus the ellipsis marker.
 */
export function pickNoteWindow(
  notes: string | null | undefined,
  query: string,
  budget: number
): NoteWindow {
  const text = (notes ?? "").trim();
  if (!text || budget <= 0) return { text: "", offset: 0, matched: 0 };
  if (text.length <= budget) return { text, offset: 0, matched: 0 };

  const terms = contentTokens(query);
  if (!terms.length) return { text: text.slice(0, budget), offset: 0, matched: 0 };

  const haystack = text.toLowerCase();
  const stride = Math.max(1, Math.floor(budget * STRIDE_FRACTION));
  const lastStart = text.length - budget;

  let bestStart = 0;
  let bestScore = 0;
  let steps = 0;
  for (let start = 0; start <= lastStart && steps < MAX_WINDOWS; start += stride, steps++) {
    const window = haystack.slice(start, start + budget);
    let score = 0;
    for (const term of terms) if (window.includes(term)) score++;
    // Strictly greater, so ties keep the EARLIEST window. Notes are written newest-last by
    // some paths and newest-first by others; with no way to tell which, the head is the
    // least surprising tie-break and matches what callers saw before this existed.
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  if (bestScore === 0) return { text: text.slice(0, budget), offset: 0, matched: 0 };
  if (bestStart === 0) return { text: text.slice(0, budget), offset: 0, matched: bestScore };

  // Start on a word boundary so the window does not open mid-word, but never search so far
  // forward that we walk past a match: a fifth of the stride is enough for a space.
  const nudge = haystack.indexOf(" ", bestStart);
  const start =
    nudge > bestStart && nudge - bestStart <= Math.max(1, Math.floor(stride / 5))
      ? nudge + 1
      : bestStart;

  // The marker counts against the budget rather than being added on top of it, so the result
  // is never longer than the caller asked for. `buildChatPrompt` re-slices notes to the same
  // cap for callers that skip the budgeting layer; overshooting here would let that second
  // slice silently eat the last character of every windowed note.
  const body = text.slice(start, start + budget - 1).trim();
  return { text: `…${body}`, offset: start, matched: bestScore };
}
