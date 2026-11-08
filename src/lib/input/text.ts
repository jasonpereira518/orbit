/**
 * Free text that arrives from a client or an integration, made storable.
 *
 * Two defects this exists for (audit M-05):
 *   - `\u0000` is valid JavaScript and invalid in a Postgres `text` column; one NUL anywhere
 *     in a note, a title or a name failed the whole write with an opaque 500.
 *   - nothing capped the free-text columns, so a server action body (up to 32 MB) could
 *     store a 1 MB reminder title, and a multi-megabyte note pushed the generated `search_tsv`
 *     past Postgres' 1 MB tsvector limit and failed the contact save outright.
 *
 * Deliberately NOT a sanitiser in the `sanitizeAgentText` sense: it does not strip HTML,
 * links or invisible characters a person typed on purpose. It removes the control
 * characters no text column should hold (keeping tab and newline), normalises to NFC so
 * the same name typed two ways compares equal, and truncates to a cap.
 *
 * Pure and dependency-free.
 */

/** C0 controls except \t (09) and \n (0A); \r (0D) is folded into \n below. Plus DEL. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Caps per field kind. Chosen well above anything a person types, and below the point where
 * a single row starts costing real money to scan or index. Capture's own input ceiling is
 * 100k characters, so a note written from a capture always fits.
 */
export const TEXT_LIMITS = {
  /** A contact's free-form notes. */
  notes: 50_000,
  /** One interaction's raw notes (a pasted transcript or email thread). */
  rawNotes: 100_000,
  /** A model-written or hand-written summary. */
  summary: 10_000,
  /** "How we met" and similar one-paragraph fields. */
  shortParagraph: 2_000,
  /** A reminder or event title. */
  title: 500,
  /** A reminder or event description. */
  description: 10_000,
  /** One entry in a list field (a key fact, a topic, an action item). */
  listItem: 500,
  /** One tag name. */
  tag: 60,
} as const;

/** Most entries any list field (key facts, topics, tags…) keeps. */
export const MAX_LIST_ITEMS = 100;
export const MAX_TAGS = 50;

/** Storable text: controls stripped, line endings normalised, NFC, truncated to `max`. */
export function cleanText(value: string, max: number): string {
  let out = value.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  try {
    out = out.normalize("NFC");
  } catch {
    // Lone surrogates make normalize throw in some engines; the stripped text is still fine.
  }
  // Truncate by code point, so a cap never splits an emoji into a lone surrogate.
  if (out.length > max) out = Array.from(out).slice(0, max).join("");
  return out;
}

/** `cleanText` for optional values: null/undefined pass through untouched. */
export function cleanOptionalText<T extends string | null | undefined>(value: T, max: number): T {
  return (typeof value === "string" ? cleanText(value, max) : value) as T;
}

/** A list field: each entry cleaned and capped, blanks dropped, at most `maxItems` kept. */
export function cleanTextList(values: readonly string[] | null | undefined, maxItem: number, maxItems = MAX_LIST_ITEMS): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const c = cleanText(v, maxItem).trim();
    if (c) out.push(c);
    if (out.length >= maxItems) break;
  }
  return out;
}
