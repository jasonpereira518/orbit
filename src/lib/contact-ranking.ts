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
import { getQueryEmbedding, normalizeQuery } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import { shouldUseSemanticArm } from "@/lib/search-adapter";

/** Lexical results are never held hostage by the embedding API. */
const EMBED_SOFT_TIMEOUT_MS = 300;

/**
 * How long the contacts list's background enrichment waits for an embedding. Nothing is
 * painted behind it (the lexical page is already on screen), so it can afford to wait for a
 * cold embedding the synchronous path would have given up on — the semantic arm then lands
 * instead of being skipped until the next keystroke finds the embedding in the cache.
 */
export const ENRICHMENT_EMBED_TIMEOUT_MS = 1000;

async function embeddingWithSoftTimeout(
  userId: string,
  query: string,
  timeoutMs: number
): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
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
  limit: number,
  options: { embedTimeoutMs?: number } = {}
): Promise<RankedContact[]> {
  const q = query.trim();
  if (!q) return [];

  // Handed over pending, not awaited: the lexical arms run while the embedding is fetched,
  // and only the semantic arm waits for it (still bounded by the same soft timeout). Awaiting
  // it here put up to 300 ms in front of every search of 3+ characters.
  const embedding =
    q.length >= 3 && shouldUseSemanticArm(q)
      ? embeddingWithSoftTimeout(userId, q, options.embedTimeoutMs ?? EMBED_SOFT_TIMEOUT_MS)
      : null;

  return hybridSearchContacts(userId, { query: q, embedding, limit });
}

/**
 * `rankContacts`, remembered for a few seconds and shared while in flight.
 *
 * One search asks for the same ranking more than once: the background enrichment of the first
 * page, then every "load more" page of a name/closeness sort (each widens its WHERE with the
 * ranked ids), and the same query again after Back or a retype. Each of those used to run the
 * three retrieval arms again. Keyed by account + normalised query + limit + embedding wait,
 * so a result computed with the short wait never stands in for one that waited longer.
 *
 * Short on purpose (a contact written a moment ago must be rankable on the next search), and
 * bounded. A failure is not remembered.
 */
const RANK_TTL_MS = 15_000;
const RANK_MAX_ENTRIES = 200;
type RankEntry = { promise: Promise<RankedContact[]>; expiresAt: number; value?: RankedContact[] };
const globalForRank = globalThis as unknown as { orbitRankCache?: Map<string, RankEntry> };

function rankCache(): Map<string, RankEntry> {
  return (globalForRank.orbitRankCache ??= new Map());
}

export function rankContactsCached(
  userId: string,
  query: string,
  limit: number,
  options: { embedTimeoutMs?: number } = {}
): Promise<RankedContact[]> {
  const cache = rankCache();
  const now = Date.now();
  const key = `${userId}\n${normalizeQuery(query)}\n${limit}\n${options.embedTimeoutMs ?? EMBED_SOFT_TIMEOUT_MS}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  if (cache.size >= RANK_MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    // Still full of live entries: drop the oldest (Map keeps insertion order).
    if (cache.size >= RANK_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  const promise = rankContacts(userId, query, limit, options);
  const entry: RankEntry = { promise, expiresAt: now + RANK_TTL_MS };
  cache.set(key, entry);
  promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    }
  );
  return promise;
}

/**
 * The ranking `rankContactsCached` already finished for this search, or null if there is none
 * (never asked, still running, expired, failed). Never waits and never starts a search: the
 * contacts page uses it to skip the two-step path when the answer is already in hand — a
 * refresh, Back, or a retyped query then paints the final page, exact count included, at once.
 */
export function peekRankedContacts(
  userId: string,
  query: string,
  limit: number,
  options: { embedTimeoutMs?: number } = {}
): RankedContact[] | null {
  const key = `${userId}\n${normalizeQuery(query)}\n${limit}\n${options.embedTimeoutMs ?? EMBED_SOFT_TIMEOUT_MS}`;
  const hit = rankCache().get(key);
  return hit && hit.expiresAt > Date.now() && hit.value ? hit.value : null;
}

/** Test seam. */
export function resetRankCache() {
  rankCache().clear();
}
