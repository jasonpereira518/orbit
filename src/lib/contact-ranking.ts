/**
 * Ranked contact search for a given user — server-only, and deliberately NOT a Server Action.
 *
 * This takes `userId` explicitly so callers that already have one (`listContactsPage`) can
 * pass it straight through instead of paying for a second auth lookup. That is only safe
 * because nothing here is exported from a `"use server"` module: an export of one of those
 * is a POST endpoint Next.js mints an action id for, so a `userId` parameter on it would be
 * a parameter an attacker fills in. `rankContacts` used to live in `src/actions/search.ts`
 * as `getRankedContacts`, which is exactly that hole — any signed-in user could rank another
 * account's contacts and learn who was in their network.
 *
 * The rule this file exists to keep: a function that needs an explicit user belongs under
 * `src/lib/`, and the action is a thin `requireUserId()` wrapper over it. Enforced by
 * `scripts/smoke-action-user-scope.ts`.
 */
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import { shouldUseSemanticArm } from "@/lib/search-adapter";

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

/**
 * Returns the full `RankedContact`, not just an id, so a caller that needs `matchedArms`
 * (to explain *why* something matched) doesn't have to ask twice.
 */
export async function rankContacts(
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
