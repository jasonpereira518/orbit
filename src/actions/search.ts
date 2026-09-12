"use server";

import { requireUserId } from "@/lib/auth";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts } from "@/lib/hybrid-search";
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

export async function searchDashboardContacts(
  query: string,
  options?: { limit?: number }
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = Math.min(Math.max(options?.limit ?? 12, 1), 80);
  const userId = await requireUserId();

  const embedding =
    q.length >= 3 && shouldUseSemanticArm(q)
      ? await embeddingWithSoftTimeout(userId, q)
      : null;

  const ranked = await hybridSearchContacts(userId, { query: q, embedding, limit });
  return toKeywordHits(ranked, q);
}
