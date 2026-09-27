"use server";

import { requireUserId } from "@/lib/auth";
import { rankContacts } from "@/lib/contact-ranking";
import { toKeywordHits } from "@/lib/search-adapter";
import type { KeywordSearchHit } from "@/lib/keyword-search";

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
