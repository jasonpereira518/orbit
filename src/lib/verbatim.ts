/**
 * Verbatim containment: does this snippet actually appear in the text the model was given?
 *
 * This is the one guard that carries real weight in every extraction path Orbit runs. The
 * prompt is only a filter — a model asked for a date, an opportunity or an implied next step
 * will occasionally produce a plausible one that nobody said. Requiring it to also hand back
 * the sentence it came from, and checking that sentence against the source here in
 * TypeScript, is what makes the behaviour identical across all three providers.
 *
 * Extracted from `date-commitment-extract.ts`, which had the only copy, once opportunity and
 * implied-step extraction needed the same rule. Two implementations of "did they really say
 * this" is how one extractor quietly becomes more credulous than another.
 *
 * Normalisation is whitespace and case only. Deliberately NOT punctuation-insensitive: an
 * excerpt that differs from the source by more than spacing is a paraphrase, and a paraphrase
 * is exactly what this exists to reject.
 */

/** Collapse runs of whitespace and lowercase. The only normalisation containment applies. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether `snippet` appears in `haystack`, both already normalised by `normalizeForMatch`.
 *
 * Takes a pre-normalised haystack because callers check many snippets against one document
 * and normalising it per snippet is the difference between one pass over the note and N.
 *
 * An empty snippet is NOT contained. A model that omitted the excerpt has given no evidence,
 * and `"".includes` would otherwise wave every such item straight through — which is the
 * precise failure this function exists to prevent.
 */
export function containsVerbatim(normalizedHaystack: string, snippet: string): boolean {
  const needle = normalizeForMatch(snippet);
  if (!needle) return false;
  return normalizedHaystack.includes(needle);
}
