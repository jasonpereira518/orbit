"use server";

import { eq } from "drizzle-orm";
import { getDb, isPgvectorAvailable } from "@/db";
import { contacts, contactEmbeddings } from "@/db/schema";
import { createEmbedding, cosineSimilarity } from "@/lib/ai";
import {
  mergeSearchHits,
  rankKeywordSearch,
  type KeywordSearchHit,
  type SearchableContact,
} from "@/lib/keyword-search";
import { requireUserId } from "@/lib/auth";
import { pgvectorSearchContacts } from "@/lib/search";

function toSearchable(
  c: Awaited<ReturnType<typeof loadContacts>>[number]
): SearchableContact {
  return {
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company,
    title: c.title,
    location: c.location,
    email: c.email,
    phone: c.phone,
    linkedinUrl: c.linkedinUrl,
    website: c.website,
    howMet: c.howMet,
    metContext: c.metContext,
    aiSummary: c.aiSummary,
    notes: c.notes,
    industry: c.industry,
    relationshipScore: c.relationshipScore,
    priorityLevel: c.priorityLevel,
    tags: c.contactTags.map((ct) => ct.tag.name),
  };
}

async function loadContacts(userId: string) {
  const db = await getDb();
  return db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: { contactTags: { with: { tag: true } } },
  });
}

async function semanticHitsForQuery(
  userId: string,
  query: string,
  contactsById: Map<string, SearchableContact>
): Promise<
  Array<{ contactId: string; similarity: number; contact: SearchableContact }>
> {
  let queryEmbedding: number[];
  try {
    queryEmbedding = await createEmbedding(userId, query);
  } catch {
    return [];
  }

  const scores = new Map<string, number>();

  if (isPgvectorAvailable()) {
    const rows = await pgvectorSearchContacts(userId, queryEmbedding, 24);
    for (const row of rows) {
      scores.set(row.contactId, row.similarity);
    }
  } else {
    const db = await getDb();
    const embeddings = await db.query.contactEmbeddings.findMany({
      where: eq(contactEmbeddings.userId, userId),
    });
    for (const row of embeddings) {
      const sim = cosineSimilarity(queryEmbedding, row.embedding);
      const prev = scores.get(row.contactId) ?? 0;
      if (sim > prev) scores.set(row.contactId, sim);
    }
  }

  return [...scores.entries()]
    .map(([contactId, similarity]) => {
      const contact = contactsById.get(contactId);
      if (!contact) return null;
      return { contactId, similarity, contact };
    })
    .filter(Boolean) as Array<{
    contactId: string;
    similarity: number;
    contact: SearchableContact;
  }>;
}

export async function searchDashboardContacts(
  query: string
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q || q.length < 1) return [];

  const userId = await requireUserId();
  const rows = await loadContacts(userId);
  const searchable = rows.map(toSearchable);
  const contactsById = new Map(searchable.map((c) => [c.id, c]));

  const keywordHits = rankKeywordSearch(searchable, q, 12);

  // Semantic path needs a longer query or no strong keyword hits
  const useSemantic = q.length >= 3;
  if (!useSemantic) return keywordHits;

  const semanticHits = await semanticHitsForQuery(userId, q, contactsById);
  if (semanticHits.length === 0) return keywordHits;

  return mergeSearchHits(keywordHits, semanticHits, 12);
}
