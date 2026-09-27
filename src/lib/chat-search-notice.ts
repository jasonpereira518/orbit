import { isMissingAiApiKeyError } from "@/lib/errors";

/** Shown once, under the answer, when retrieval had to fall back to keywords. */
export const KEYWORD_ONLY_SEARCH_NOTICE =
  "Search used keywords only — Orbit couldn’t reach your embedding provider";

/**
 * Having no embedding key is a setup fact, not an outage: an Anthropic-only account simply
 * has no semantic arm (`resolveEmbeddingBackend` in ai.ts throws these messages). If the
 * wording of those throws changes, match the new wording here.
 */
const NO_EMBEDDING_KEY = /configured for embeddings|has no embeddings api/i;

export function embeddingFailureNotice(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (isMissingAiApiKeyError(message) || NO_EMBEDDING_KEY.test(message)) return null;
  return KEYWORD_ONLY_SEARCH_NOTICE;
}
