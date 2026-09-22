/**
 * Rank a user's contacts for a typed query — the app's search, shared.
 *
 * Moved out of `src/actions/search.ts` (a "use server" file, which can only
 * export async actions) so the browser extension's search ranks exactly as the
 * dashboard does, rather than through a second copy that would drift.
 */
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import { shouldUseSemanticArm } from "@/actions/search-adapter";

/** Lexical results are never held hostage by the embedding API. */
const EMBED_SOFT_TIMEOUT_MS = 300;

async function embeddingWithSoftTimeout(
  userId: string,
  query: string
): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EMBED_SOFT_TIMEOUT_MS);
  });
  try {
    // On timeout the underlying promise keeps running and lands in the cache,
    // so the next keystroke gets the semantic arm for free.
    return await Promise.race([
      getQueryEmbedding(userId, query).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function rankContactsForQuery(
  userId: string,
  query: string,
  limit: number
): Promise<RankedContact[]> {
  const q = query.trim();
  if (!q) return [];

  const embedding =
    q.length >= 3 && shouldUseSemanticArm(q)
      ? await embeddingWithSoftTimeout(userId, q)
      : null;

  return hybridSearchContacts(userId, { query: q, embedding, limit });
}
