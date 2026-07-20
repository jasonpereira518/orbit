"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { chatWithNetwork } from "@/lib/ai";
import { semanticSearchContacts } from "@/lib/search";

async function loadKnowledgeSnippets(
  userId: string,
  contactIds: string[]
): Promise<Map<string, { recentMessages: string[] }>> {
  const result = new Map<string, { recentMessages: string[] }>();
  if (!contactIds.length) return result;

  const db = await getDb();
  const msgs = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      inArray(interactions.contactId, contactIds),
      eq(interactions.interactionType, "linkedin_message")
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: contactIds.length * 8,
  });

  const byContact = new Map<string, string[]>();
  for (const m of msgs) {
    const list = byContact.get(m.contactId) || [];
    if (list.length >= 6) continue;
    const text = (m.aiSummary || m.rawNotes || "").trim();
    if (!text) continue;
    list.push(text.slice(0, 280));
    byContact.set(m.contactId, list);
  }

  for (const id of contactIds) {
    result.set(id, {
      recentMessages: byContact.get(id) || [],
    });
  }
  return result;
}

export async function askNetwork(question: string) {
  const userId = await requireUserId();
  const retrieved = await semanticSearchContacts(userId, question, 12);
  const snippets = await loadKnowledgeSnippets(
    userId,
    retrieved.map((c) => c.id)
  );

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
      keyFacts: c.keyFacts || [],
      recentMessages: snippets.get(c.id)?.recentMessages || [],
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
