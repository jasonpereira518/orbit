"use server";

import { requireUserId } from "@/lib/auth";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import { shouldUseSemanticArm, toKeywordHits } from "@/actions/search-adapter";
import type { KeywordSearchHit } from "@/lib/keyword-search";

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

async function rankContacts(
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

export async function searchDashboardContacts(
  query: string,
  options?: { limit?: number }
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = Math.min(Math.max(options?.limit ?? 12, 1), 80);
  const userId = await requireUserId();
  const ranked = await rankContacts(userId, q, limit);
  return toKeywordHits(ranked, q);
}

/**
 * Ranked contact IDs for a query, no `requireUserId()` of its own — callers that
 * already have a `userId` (e.g. `listContactsPage`) pass it straight through
 * rather than paying for a second auth lookup.
 */
export async function getRankedContactIds(
  userId: string,
  query: string,
  limit = 60
): Promise<string[]> {
  const ranked = await rankContacts(userId, query, limit);
  return ranked.map((r) => r.id);
}
