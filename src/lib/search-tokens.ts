/**
 * The content-bearing words of a natural-language question.
 *
 * A leaf on purpose, for the same reason `chat-attention-match.ts` and `chat-roster-match.ts`
 * are: two sides now need the same answer and a second copy of this list would drift. The
 * search arms in `hybrid-search.ts` use it to OR-expand a `tsquery`; `note-window.ts` uses it
 * to decide which part of a long note the model actually gets to read. If those two disagreed
 * about what a query is "about", retrieval would find a note by a word the prompt then
 * trimmed away — which is precisely the bug the window was added to fix.
 *
 * Nothing here may import anything that reaches the database: `hybrid-search.ts` imports
 * `@/db`, and a client component pulling this in through a pure sibling would fail the build
 * with a `node:fs` chunking error that names neither file.
 */

/**
 * Words too common to narrow anything, plus the ones people spend a networking question on
 * ("who do I know…") that say nothing about the subject.
 */
export const FTS_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from",
  "who", "whom", "whose", "what", "which", "where", "when", "why", "how",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "i", "me", "my", "we", "our", "you", "your", "they", "them", "their", "it", "its",
  "know", "knows", "anyone", "someone", "somebody", "people", "person", "contact", "contacts",
  "can", "could", "would", "should", "have", "has", "had", "that", "this", "these", "those",
]);

/** Content-bearing tokens from a natural-language query, for OR-expansion. */
export function contentTokens(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !FTS_STOPWORDS.has(t))
  )].slice(0, 8);
}
