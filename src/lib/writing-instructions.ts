/**
 * The user's own notes on how they like answers and drafts written — "shorter than you
 * think", "no exclamation marks", "sign off with Jason".
 *
 * Pure: cleaning, capping and rendering live here, and nothing in this file reads the
 * database. That is deliberate. The text is loaded by the action or route that owns the
 * request and PASSED into the prompt builders, never fetched inside them, so a surface that
 * has no business applying it — the MCP tools, `chat.title`, embeddings, an agent's send —
 * cannot inherit it by calling a function that happens to be shared.
 *
 * Three rules keep it safe to add to prompts that are tuned and have no eval:
 *
 *   EMPTY MEANS ABSENT. `renderWritingPreferences` returns "" for null, empty and
 *   whitespace-only input, and every call site appends the block only when it is non-empty,
 *   so a user with no preferences gets prompts byte-identical to before this existed.
 *   `smoke-writing-instructions` proves that against `scripts/fixtures/draft-prompt-goldens.json`.
 *
 *   STYLE ONLY, AND SAYS SO. Length limits, output format, JSON shape and the no-invention
 *   rules in each system prompt outrank it. The block states that itself, because the text
 *   is free-form: "be detailed" would otherwise fight a 160-character SMS limit.
 *
 *   IT IS THE USER'S OWN TEXT, BUT NOT A TRUSTED PROMPT. It sits in the user message beside
 *   the goals, unfenced. Every line is prefixed, so a line that reads `Prospect:` or `Contact:`
 *   cannot pass for a section header of the prompt around it.
 */

export const MAX_WRITING_INSTRUCTIONS = 1500;

/**
 * The learned style's cap (`@/lib/writing-style-profile`). Here, not there, because the
 * settings box (a client component) needs it and that module reads mail. It shares the
 * 1500-character preferences block with the user's own notes (`withStyleProfile`).
 */
export const STYLE_PROFILE_MAX = 600;

/** Zero-width and bidirectional-control code points: text that renders as nothing. */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Control characters other than tab, line feed and carriage return. */
function isStrippedControl(code: number): boolean {
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
}

/**
 * Clean what was typed for storage: strip control and invisible characters and HTML tags,
 * fold line endings, collapse runs of blank lines, trim, and cap by characters (never
 * splitting a surrogate pair). Returns null when nothing is left, which is how "none" is
 * stored.
 */
export function sanitizeWritingInstructions(input: string | null | undefined): string | null {
  if (!input) return null;
  let kept = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (isStrippedControl(code) || isInvisible(code)) continue;
    kept += ch;
  }
  const cleaned = kept
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return (chars.length > MAX_WRITING_INSTRUCTIONS
    ? chars.slice(0, MAX_WRITING_INSTRUCTIONS).join("").trim()
    : cleaned) || null;
}

/**
 * The user's own notes with the style Orbit learned from their sent mail
 * (`@/lib/writing-style-profile`) appended below them, as one block: their notes come first and
 * say so, so they win where the two disagree. Either alone when the other is empty.
 */
export function withStyleProfile(own: string | null | undefined, profile: string | null | undefined): string | null {
  const notes = sanitizeWritingInstructions(own);
  const learned = profile?.trim();
  if (!learned) return notes;
  const block = `How they write, learned from their own sent mail (their notes above win where they differ):\n${learned}`;
  return sanitizeWritingInstructions(notes ? `${notes}\n\n${block}` : block);
}

const HEADING =
  "Writing preferences from the sender, in their own words. Style only: tone, phrasing, sign-off. Length limits, output format, JSON shape and every rule above still win.";

/**
 * The block to append to a prompt, or "" when there is nothing to say. Idempotent over
 * `sanitizeWritingInstructions`, so a raw column value is safe to pass straight in.
 */
export function renderWritingPreferences(text: string | null | undefined): string {
  const cleaned = sanitizeWritingInstructions(text);
  if (!cleaned) return "";
  const lines = cleaned
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `| ${line}`);
  return `${HEADING}\n${lines.join("\n")}`;
}

/**
 * `prompt` with the block on the end, separated by a blank line — or `prompt` itself, the
 * very same string, when there is no block. The one place the "empty is byte-identical"
 * rule is written down so call sites cannot each get it slightly wrong.
 */
export function withWritingPreferences(prompt: string, text: string | null | undefined): string {
  const block = renderWritingPreferences(text);
  return block ? `${prompt}\n\n${block}` : prompt;
}
