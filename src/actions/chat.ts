"use server";

import { requireUserId } from "@/lib/auth";
import { chatWithNetwork } from "@/lib/ai";
import { semanticSearchContacts } from "@/lib/search";

export async function askNetwork(question: string) {
  const userId = await requireUserId();
  const retrieved = await semanticSearchContacts(userId, question, 12);

  const result = await chatWithNetwork(
    userId,
    question,
    retrieved.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      aiSummary: c.aiSummary,
      notes: c.notes,
      tags: c.tags,
      relevance: c.relevance,
    }))
  );

  // Guard: only keep recommendations that exist in retrieval set
  const allowed = new Set(retrieved.map((c) => c.id));
  const recommendations = (result.recommendations || []).filter((r) =>
    allowed.has(r.contact_id)
  );

  return {
    answer: result.answer,
    recommendations,
    retrieved: retrieved.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relevance: c.relevance,
    })),
  };
}
