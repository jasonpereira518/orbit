/**
 * Ported from src/lib/linkedin-messages.ts in the Orbit app, deliberately kept
 * behaviourally identical rather than rewritten — it already encodes what does
 * and doesn't look like a person's name in this data.
 */
export function isLikelyPersonName(value: string | null | undefined): boolean {
  const name = (value ?? "").trim();
  if (!name || name.length < 3 || name.length > 80) return false;
  if (/\d/.test(name)) return false;
  if (/[@#/\\|]/.test(name)) return false;
  if (/\b(inc|llc|ltd|gmbh|corp|company|team|group|solutions)\b/i.test(name)) {
    return false;
  }
  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => /^[\p{L}'’.-]+$/u.test(word));
}

/**
 * Site titles pass `isLikelyPersonName` far too easily — "Simon Willison's
 * Weblog" is three name-shaped words, and so is "About Simon Willison". Found
 * by running the generic adapter against a real personal site, where it would
 * otherwise have saved a blog title as a contact.
 */
const SITE_WORDS =
  /\b(blog|weblog|newsletter|portfolio|website|site|home|homepage|about|contact|team|careers|docs|documentation|shop|store|news|podcast|archive)\b/i;

export function looksLikeSiteName(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  if (SITE_WORDS.test(text)) return true;
  // "Simon Willison's Weblog" — a possessive is a title, not a name.
  if (/['’]s\b/i.test(text)) return true;
  return false;
}

/** Strip page-title framing so "About Simon Willison" yields the name. */
export function stripTitlePrefix(value: string): string {
  return value.replace(/^(about|contact|meet|hi,? i'?m|profile of)\s+/i, "").trim();
}
