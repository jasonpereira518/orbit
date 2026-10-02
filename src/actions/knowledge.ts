"use server";

import { requireUserForSurface } from "@/lib/plan-guards";
import { loadKnowledgeBase } from "@/lib/knowledge-base";
import type { KnowledgeBasePayload } from "@/lib/knowledge-base-types";
import { loadKnowledgePeople } from "@/lib/knowledge-people";
import type { KnowledgePeoplePayload } from "@/lib/knowledge-people-types";

export async function getKnowledgeBase(): Promise<KnowledgeBasePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  return loadKnowledgeBase(userId);
}

export async function getKnowledgePeople(): Promise<KnowledgePeoplePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  return loadKnowledgePeople(userId);
}
