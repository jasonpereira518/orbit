"use server";

import { requireUserForSurface } from "@/lib/plan-guards";
import { loadKnowledgeBase } from "@/lib/knowledge-base";
import type { KnowledgeQuery } from "@/lib/knowledge-base";
import type { KnowledgeBasePayload } from "@/lib/knowledge-base-types";

export async function getKnowledgeBase(
  options?: KnowledgeQuery
): Promise<KnowledgeBasePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  return loadKnowledgeBase(userId, options);
}
