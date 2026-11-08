"use server";

import { requireUserForSurface } from "@/lib/plan-guards";
import { loadKnowledgePeople } from "@/lib/knowledge-people";
import type { KnowledgePeoplePayload, KnowledgeSearchHit } from "@/lib/knowledge-people-types";
import { searchKnowledgeContent as searchContent } from "@/lib/knowledge-search";

export async function getKnowledgePeople(): Promise<KnowledgePeoplePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  return loadKnowledgePeople(userId);
}

/** Who mentions `query` in their notes, messages or facts. Empty below the minimum length. */
export async function searchKnowledgeContent(query: string): Promise<KnowledgeSearchHit[]> {
  const userId = await requireUserForSurface("page.knowledge");
  if (typeof query !== "string") return [];
  return searchContent(userId, query);
}
