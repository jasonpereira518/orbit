"use server";

import { rankContacts } from "@/lib/contact-ranking";
import { toKeywordHits } from "@/lib/search-adapter";
import type { KeywordSearchHit } from "@/lib/keyword-search";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";
import { anyNumber } from "@/lib/input/schemas";

export const searchDashboardContacts = defineAction(
  { schema: z.tuple([z.string(), z.looseObject({ limit: anyNumber.optional() }).optional()]) },
  async (userId, query: string, options?: { limit?: number }): Promise<KeywordSearchHit[]> => {
    const q = query.trim();
    if (!q) return [];

    const limit = Math.min(Math.max(options?.limit ?? 12, 1), 80);
    const ranked = await rankContacts(userId, q, limit);
    return toKeywordHits(ranked, q);
  }
);
