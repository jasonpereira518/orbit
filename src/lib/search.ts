import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { contactEmbeddings, contacts } from "@/db/schema";
import { createEmbedding, cosineSimilarity } from "@/lib/ai";

export async function upsertContactEmbedding(
  userId: string,
  contactId: string,
  sourceType: string,
  content: string,
  sourceId?: string
) {
  if (!content.trim()) return;

  try {
    const embedding = await createEmbedding(userId, content);
    const db = await getDb();
    await db.insert(contactEmbeddings).values({
      userId,
      contactId,
      sourceType,
      sourceId,
      embedding,
      content,
    });
  } catch {
    // AI key may be missing; skip embeddings silently
  }
}

export async function semanticSearchContacts(
  userId: string,
  query: string,
  limit = 12
) {
  const db = await getDb();
  const allContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: {
      contactTags: { with: { tag: true } },
    },
  });

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await createEmbedding(userId, query);
  } catch {
    // fall through to keyword search
  }

  const embeddings = queryEmbedding
    ? await db.query.contactEmbeddings.findMany({
        where: eq(contactEmbeddings.userId, userId),
      })
    : [];

  const scoreByContact = new Map<string, number>();

  if (queryEmbedding) {
    for (const row of embeddings) {
      const sim = cosineSimilarity(queryEmbedding, row.embedding);
      const prev = scoreByContact.get(row.contactId) ?? 0;
      if (sim > prev) scoreByContact.set(row.contactId, sim);
    }
  }

  const q = query.toLowerCase();
  const results = allContacts
    .map((c) => {
      let score = scoreByContact.get(c.id) ?? 0;
      const haystack = [
        c.fullName,
        c.preferredName,
        c.company,
        c.title,
        c.location,
        c.email,
        c.phone,
        c.website,
        c.aiSummary,
        c.notes,
        c.industry,
        c.howMet,
        ...(c.contactTags?.map((ct) => ct.tag.name) || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (haystack.includes(q)) score = Math.max(score, 0.55);
      for (const token of q.split(/\s+/).filter((t) => t.length > 2)) {
        if (haystack.includes(token)) score += 0.08;
      }

      score += (c.relationshipScore || 0) * 0.03;
      score += (c.priorityLevel || 0) * 0.02;

      return {
        ...c,
        tags: c.contactTags?.map((ct) => ct.tag.name) || [],
        relevance: Math.min(score, 1),
      };
    })
    .filter((c) => c.relevance > 0.05)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  return results;
}

export async function rebuildContactEmbedding(userId: string, contactId: string) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return;

  const content = [
    contact.fullName,
    contact.preferredName,
    contact.title,
    contact.company,
    contact.location,
    contact.email,
    contact.phone,
    contact.linkedinUrl,
    contact.website,
    contact.aiSummary,
    contact.notes,
    contact.howMet,
    ...(contact.keyFacts || []),
    ...(contact.opportunities || []),
    ...(contact.contactTags?.map((ct) => ct.tag.name) || []),
  ]
    .filter(Boolean)
    .join("\n");

  await upsertContactEmbedding(userId, contactId, "profile", content, contactId);
}
