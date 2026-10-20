"use server";

import { loadKnowledgeBase } from "@/lib/knowledge-base";
import type { KnowledgeQuery } from "@/lib/knowledge-base";
import type { KnowledgeBasePayload } from "@/lib/knowledge-base-types";
import { loadKnowledgePeople } from "@/lib/knowledge-people";
import type { KnowledgePeoplePayload } from "@/lib/knowledge-people-types";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

// Argument shapes, generated from the handlers' parameter types.
const KnowledgeQuerySchema = z.looseObject({ q: z.string().optional(), kind: z.enum(["note", "meeting", "summary", "message", "all", "key_fact"]).optional() });

export const getKnowledgeBase = defineAction(
  { auth: { surface: "page.knowledge" }, schema: z.tuple([KnowledgeQuerySchema.optional()]) },
  async (userId, options?: KnowledgeQuery): Promise<KnowledgeBasePayload> => {
    return loadKnowledgeBase(userId, options);
  }
);

export const getKnowledgePeople = defineAction(
  { auth: { surface: "page.knowledge" } },
  async (userId): Promise<KnowledgePeoplePayload> => {
    return loadKnowledgePeople(userId);
  }
);
