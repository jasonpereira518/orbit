/**
 * What a draft on a recommendation card is allowed to be — pure, so both the parser that first
 * receives the model's `draft_message` and the rewrite that later replaces it can share it
 * without importing the AI layer.
 */

/** The most a draft may be. Matches the send path's body cap, so an edit can always be sent. */
export const DRAFT_MAX_CHARS = 5000;


function isStripped(code: number): boolean {
  if (code < 32) return code !== 9 && code !== 10 && code !== 13;
  return (
    code === 127 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * A draft, cleaned for display and editing: control characters and text that renders as
 * nothing (zero-width, bidirectional overrides) removed, line endings folded, runs of blank
 * lines collapsed, capped. Returns null for anything empty. Plain text stays plain — this does
 * not rewrite the prose, only removes what a reader could not see.
 */
export function sanitizeDraft(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let kept = "";
  for (const ch of raw) {
    if (!isStripped(ch.codePointAt(0)!)) kept += ch;
  }
  const cleaned = kept.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return (chars.length > DRAFT_MAX_CHARS ? chars.slice(0, DRAFT_MAX_CHARS).join("").trim() : cleaned) || null;
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Every link-shaped or address-shaped thing in `text`, lower-cased. */
function reach(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_LIKE)) found.add(m[0].toLowerCase().replace(/[.,;:!?]+$/, ""));
  for (const m of text.matchAll(EMAIL_LIKE)) found.add(m[0].toLowerCase());
  return found;
}

/** Whether `after` contains a URL or email address that `before` did not. */
export function gainedReach(before: string, after: string): boolean {
  const had = reach(before);
  for (const item of reach(after)) if (!had.has(item)) return true;
  return false;
}
