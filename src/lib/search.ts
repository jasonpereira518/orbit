import { eq, and, sql } from "drizzle-orm";
import { getDb, isPgvectorAvailable } from "@/db";
import { contactEmbeddings, contacts } from "@/db/schema";
import { metContextLabel } from "@/lib/met-context";
import { createEmbedding, cosineSimilarity } from "@/lib/ai";
import { formatVectorLiteral } from "@/lib/pgvector";

async function persistEmbeddingVector(rowId: string, embedding: number[]) {
  if (!isPgvectorAvailable()) return;
  const db = await getDb();
  const literal = formatVectorLiteral(embedding);
  await db.execute(
    sql`UPDATE contact_embeddings SET embedding_vector = ${literal}::vector WHERE id = ${rowId}`
  );
}

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

    if (sourceId) {
      const existing = await db.query.contactEmbeddings.findFirst({
        where: and(
          eq(contactEmbeddings.userId, userId),
          eq(contactEmbeddings.contactId, contactId),
          eq(contactEmbeddings.sourceType, sourceType),
          eq(contactEmbeddings.sourceId, sourceId)
        ),
      });
      if (existing) {
        await db
          .update(contactEmbeddings)
          .set({ embedding, content })
          .where(eq(contactEmbeddings.id, existing.id));
        await persistEmbeddingVector(existing.id, embedding);
        return;
      }
    }

    const [inserted] = await db
      .insert(contactEmbeddings)
      .values({
        userId,
        contactId,
        sourceType,
        sourceId,
        embedding,
        content,
      })
      .returning();

    if (inserted?.id) {
      await persistEmbeddingVector(inserted.id, embedding);
    }
  } catch {
    // AI key may be missing; skip embeddings silently
  }
}

export type SemanticSearchRow = {
  contactId: string;
  similarity: number;
};

/** DB cosine similarity via pgvector; returns empty when unavailable. */
export async function pgvectorSearchContacts(
  userId: string,
  queryEmbedding: number[],
  limit = 12
): Promise<SemanticSearchRow[]> {
  if (!isPgvectorAvailable()) return [];

  const db = await getDb();
  const literal = formatVectorLiteral(queryEmbedding);

  const result = await db.execute<{
    contact_id: string;
    similarity: number;
  }>(sql`
    SELECT
      contact_id,
      MAX(1 - (embedding_vector <=> ${literal}::vector))::float8 AS similarity
    FROM contact_embeddings
    WHERE user_id = ${userId}
      AND embedding_vector IS NOT NULL
    GROUP BY contact_id
    HAVING MAX(1 - (embedding_vector <=> ${literal}::vector)) > 0.25
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: { contact_id: string; similarity: number }[] }).rows ??
      []);

  return rows.map((row) => ({
    contactId: row.contact_id,
    similarity: Number(row.similarity) || 0,
  }));
}

function inMemorySemanticScores(
  queryEmbedding: number[],
  embeddings: Array<{ contactId: string; embedding: number[] }>
) {
  const scoreByContact = new Map<string, number>();
  for (const row of embeddings) {
    const sim = cosineSimilarity(queryEmbedding, row.embedding);
    const prev = scoreByContact.get(row.contactId) ?? 0;
    if (sim > prev) scoreByContact.set(row.contactId, sim);
  }
  return scoreByContact;
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

  const q = query.toLowerCase();
  const scoreByContact = new Map<string, number>();

  if (queryEmbedding) {
    if (isPgvectorAvailable()) {
      const pgHits = await pgvectorSearchContacts(userId, queryEmbedding, limit * 2);
      for (const hit of pgHits) {
        scoreByContact.set(hit.contactId, hit.similarity);
      }
    } else {
      const embeddings = await db.query.contactEmbeddings.findMany({
        where: eq(contactEmbeddings.userId, userId),
      });
      const inMemory = inMemorySemanticScores(queryEmbedding, embeddings);
      for (const [contactId, sim] of inMemory) {
        scoreByContact.set(contactId, sim);
      }
    }

    // Also boost contacts whose stored embedding text mentions the query
    // (covers LinkedIn message chunks even when vector score is middling).
    const contentRows = await db.query.contactEmbeddings.findMany({
      where: eq(contactEmbeddings.userId, userId),
      columns: { contactId: true, content: true },
    });
    for (const row of contentRows) {
      const hay = (row.content || "").toLowerCase();
      if (!hay) continue;
      let bump = 0;
      if (hay.includes(q)) bump = 0.35;
      else {
        for (const token of q.split(/\s+/).filter((t) => t.length > 2)) {
          if (hay.includes(token)) bump += 0.08;
        }
      }
      if (bump > 0) {
        scoreByContact.set(
          row.contactId,
          Math.max(scoreByContact.get(row.contactId) ?? 0, bump)
        );
      }
    }
  }
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
        c.metContext,
        c.howMet,
        ...(c.keyFacts || []),
        ...(c.opportunities || []),
        ...(c.sharedInterests || []),
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
    metContextLabel(contact.metContext),
    contact.dateMet
      ? new Date(contact.dateMet).toLocaleDateString()
      : null,
    contact.howMet,
    ...(contact.keyFacts || []),
    ...(contact.opportunities || []),
    ...(contact.contactTags?.map((ct) => ct.tag.name) || []),
  ]
    .filter(Boolean)
    .join("\n");

  await upsertContactEmbedding(userId, contactId, "profile", content, contactId);
}
