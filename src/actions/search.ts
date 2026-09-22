"use server";

import { requireUserId } from "@/lib/auth";
import { rankContactsForQuery } from "@/lib/contact-ranking";
import type { RankedContact } from "@/lib/hybrid-search";
import { toKeywordHits } from "@/actions/search-adapter";
import type { KeywordSearchHit } from "@/lib/keyword-search";

// Ranking lives in `@/lib/contact-ranking`, shared with the browser extension's
// search so the two rank identically.

export async function searchDashboardContacts(
  query: string,
  options?: { limit?: number }
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = Math.min(Math.max(options?.limit ?? 12, 1), 80);
  const userId = await requireUserId();
  const ranked = await rankContactsForQuery(userId, q, limit);
  return toKeywordHits(ranked, q);
}

/**
 * Ranked contacts for a query, no `requireUserId()` of its own — callers that already
 * have a `userId` (e.g. `listContactsPage`) pass it straight through rather than paying
 * for a second auth lookup. Returns the full `RankedContact`, not just an id, so a caller
 * that needs `matchedArms` (to explain *why* something matched) doesn't have to ask twice.
 */
export async function getRankedContacts(
  userId: string,
  query: string,
  limit = 60
): Promise<RankedContact[]> {
  return rankContactsForQuery(userId, query, limit);
}
