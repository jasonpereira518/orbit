import { eq, and, ilike, inArray, sql } from "drizzle-orm";
import { getDb, isPgvectorAvailable, rowsOf } from "@/db";
import { contactEmbeddings, contacts } from "@/db/schema";
import { metContextLabel } from "@/lib/met-context";
import { createEmbedding, createEmbeddingsBatch, cosineSimilarity } from "@/lib/ai";
import { formatVectorLiteral } from "@/lib/pgvector";
import {
  ERROR_SOURCES,
  recordErrorEvent,
  shouldRecordThrottled,
} from "@/lib/error-events";

/**
 * Rows per statement. Unlike `closeness-materialize.ts`'s `WRITE_CHUNK` (500, for rows of
 * a few scalars each), a row here embeds a full 1,536-dim vector literal — roughly 18KB of
 * text — so 500 of them would build a multi-megabyte statement, well past what `neon-http`
 * will accept. 50 keeps a single statement in the ~1MB range regardless of caller size.
 */
const VECTOR_WRITE_CHUNK = 50;

/**
 * Copy embeddings into the pgvector column for many rows, chunked across statements.
 *
 * This used to be one `UPDATE` per row awaited in a loop, which on `neon-http` is one
 * HTTPS request each — the largest single cost in a bulk import, and entirely invisible
 * from the outside because the result is identical either way. It was later batched into
 * one `UPDATE ... FROM (VALUES ...)` per call, which was safe only because every caller at
 * the time pre-chunked upstream; chunking now happens here so no future caller can pass an
 * unbounded set and build an oversized statement.
 */
export async function persistEmbeddingVectors(
  rows: Array<{ id: string; embedding: number[] }>
) {
  if (!isPgvectorAvailable() || rows.length === 0) return;
  const db = await getDb();
  for (let i = 0; i < rows.length; i += VECTOR_WRITE_CHUNK) {
    const chunk = rows.slice(i, i + VECTOR_WRITE_CHUNK);
    const tuples = chunk.map(
      (row) => sql`(${row.id}::uuid, ${formatVectorLiteral(row.embedding)}::vector)`
    );
    await db.execute(sql`
      UPDATE contact_embeddings AS e
      SET embedding_vector = v.vec
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, vec)
      WHERE e.id = v.id
    `);
  }
}

async function persistEmbeddingVector(rowId: string, embedding: number[]) {
  await persistEmbeddingVectors([{ id: rowId, embedding }]);
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
/**
 * How many embedding rows to scan per requested contact.
 *
 * The ANN scan ranks rows, but several rows can belong to one contact, so a scan of exactly
 * `limit` rows could collapse to far fewer contacts. Four is comfortably above the number of
 * embeddings a single contact accumulates in practice.
 */
const OVERSCAN_FOR_DEDUPE = 4;

/** Below this cosine similarity a hit is noise rather than a weak match. */
const SEMANTIC_SIMILARITY_FLOOR = 0.25;

/**
 * Ceiling on the in-memory cosine fallback. Each row holds a 1,536-float array, so this is
 * about not materialising the entire embedding table in Node when pgvector is missing.
 */
const IN_MEMORY_EMBEDDING_SCAN_LIMIT = 2000;

/** Ceiling on embedding rows pulled for the literal-text boost. */
const CONTENT_BOOST_LIMIT = 200;

export async function pgvectorSearchContacts(
  userId: string,
  queryEmbedding: number[],
  limit = 12
): Promise<SemanticSearchRow[]> {
  if (!isPgvectorAvailable()) return [];

  const db = await getDb();
  const literal = formatVectorLiteral(queryEmbedding);

  // A contact can have several embeddings (profile, notes, interactions), and what we want
  // is the best one per contact. Expressing that as `GROUP BY contact_id HAVING MAX(...)`
  // reads naturally but defeats the HNSW index outright: an approximate-nearest-neighbour
  // scan can only be driven by an `ORDER BY <=> ... LIMIT` at the top of a scan, and
  // wrapping the distance in an aggregate hides it. The planner's only option was to read
  // every embedding row for the user and compute a distance for each — precisely the scan
  // the index exists to avoid.
  //
  // So the ANN scan happens first, in the inner query, over rows rather than contacts. It
  // over-fetches because those rows collapse into fewer contacts once deduplicated; the
  // multiplier is what keeps a full page of contacts available after the collapse.
  const scanLimit = Math.max(limit * OVERSCAN_FOR_DEDUPE, 50);

  const result = await db.execute<{
    contact_id: string;
    similarity: number;
  }>(sql`
    WITH nearest AS (
      SELECT contact_id, embedding_vector <=> ${literal}::vector AS distance
      FROM contact_embeddings
      WHERE user_id = ${userId}
        AND embedding_vector IS NOT NULL
      ORDER BY embedding_vector <=> ${literal}::vector
      LIMIT ${scanLimit}
    )
    SELECT contact_id, (1 - MIN(distance))::float8 AS similarity
    FROM nearest
    GROUP BY contact_id
    HAVING (1 - MIN(distance)) > ${SEMANTIC_SIMILARITY_FLOOR}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  const rows = rowsOf<{ contact_id: string; similarity: number }>(result);

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
      try {
        const pgHits = await pgvectorSearchContacts(
          userId,
          queryEmbedding,
          limit * 2
        );
        for (const hit of pgHits) {
          scoreByContact.set(hit.contactId, hit.similarity);
        }
      } catch (err) {
        // pgvector query can fail on Neon (extension/dim); fall back below.
        // Throttled: this fires per search, so a broken index would otherwise write a
        // row for every query.
        if (shouldRecordThrottled(ERROR_SOURCES.searchPgvector)) {
          await recordErrorEvent({
            source: ERROR_SOURCES.searchPgvector,
            kind: "query_failed",
            userId,
            message: err,
          });
        }
      }
    }

    // Prefer one embedding read for both vector scores (fallback) and content boost.
    let embeddingRows:
      | Array<{ contactId: string; embedding: number[]; content: string | null }>
      | null = null;

    if (scoreByContact.size === 0) {
      // The fallback for when pgvector is unavailable — always the case on PGlite, which
      // has no build of it. Every row carries a 1,536-float JSONB array, so this is capped:
      // uncapped, a 5,000-contact network materialises tens of millions of floats in Node
      // to score one query.
      embeddingRows = await db.query.contactEmbeddings.findMany({
        where: eq(contactEmbeddings.userId, userId),
        columns: { contactId: true, embedding: true, content: true },
        limit: IN_MEMORY_EMBEDDING_SCAN_LIMIT,
      });
      if (embeddingRows.length === IN_MEMORY_EMBEDDING_SCAN_LIMIT) {
        console.warn(
          `[search] in-memory vector fallback hit its ${IN_MEMORY_EMBEDDING_SCAN_LIMIT}-row cap; results are partial. Enable pgvector for complete semantic search.`
        );
      }
      const inMemory = inMemorySemanticScores(queryEmbedding, embeddingRows);
      for (const [contactId, sim] of inMemory) {
        scoreByContact.set(contactId, sim);
      }
    }

    // Also boost contacts whose stored embedding text mentions the query (covers LinkedIn
    // message chunks even when the vector score is middling).
    //
    // Matched in Postgres rather than by reading every embedding row and calling
    // `String.includes` on it. The old shape ran a second unconditional full read of
    // `contact_embeddings` even when the pgvector search above had already succeeded, purely
    // to find the handful of rows that mention the query.
    const contentRows =
      embeddingRows ??
      (await db.query.contactEmbeddings.findMany({
        where: and(
          eq(contactEmbeddings.userId, userId),
          ilike(contactEmbeddings.content, `%${query.trim()}%`)
        ),
        columns: { contactId: true, content: true },
        limit: CONTENT_BOOST_LIMIT,
      }));
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

type ContactEmbeddingSource = {
  fullName: string;
  preferredName?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  aiSummary?: string | null;
  notes?: string | null;
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
  keyFacts?: string[] | null;
  opportunities?: string[] | null;
  contactTags?: { tag: { name: string } }[];
};

export function buildContactEmbeddingContent(contact: ContactEmbeddingSource): string {
  return [
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
}

export async function rebuildContactEmbedding(userId: string, contactId: string) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return;

  const content = buildContactEmbeddingContent(contact);
  await upsertContactEmbedding(userId, contactId, "profile", content, contactId);
}

/** Rebuild "profile" embeddings for many contacts with one batched embedding API call. */
export async function rebuildContactEmbeddingsBatch(
  userId: string,
  contactIds: string[]
) {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return;

  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
    with: { contactTags: { with: { tag: true } } },
  });

  const entries = rows
    .map((contact) => ({ contactId: contact.id, content: buildContactEmbeddingContent(contact) }))
    .filter((entry) => entry.content.trim().length > 0);
  if (entries.length === 0) return;

  let embeddings: number[][];
  try {
    embeddings = await createEmbeddingsBatch(
      userId,
      entries.map((entry) => entry.content)
    );
  } catch {
    // AI key may be missing; skip embeddings silently, matching upsertContactEmbedding.
    return;
  }

  const existing = await db.query.contactEmbeddings.findMany({
    where: and(
      eq(contactEmbeddings.userId, userId),
      eq(contactEmbeddings.sourceType, "profile"),
      inArray(
        contactEmbeddings.contactId,
        entries.map((entry) => entry.contactId)
      )
    ),
  });
  const existingByContactId = new Map(existing.map((row) => [row.contactId, row]));

  const toInsert: Array<{
    userId: string;
    contactId: string;
    sourceType: string;
    sourceId: string;
    embedding: number[];
    content: string;
  }> = [];
  const toUpdate: Array<{ id: string; embedding: number[]; content: string }> = [];

  entries.forEach((entry, index) => {
    const embedding = embeddings[index];
    const found = existingByContactId.get(entry.contactId);
    if (found) {
      toUpdate.push({ id: found.id, embedding, content: entry.content });
    } else {
      toInsert.push({
        userId,
        contactId: entry.contactId,
        sourceType: "profile",
        sourceId: entry.contactId,
        embedding,
        content: entry.content,
      });
    }
  });

  let inserted: typeof contactEmbeddings.$inferSelect[] = [];
  if (toInsert.length > 0) {
    inserted = await db.insert(contactEmbeddings).values(toInsert).returning();
  }

  if (toUpdate.length > 0) {
    const tuples = toUpdate.map(
      (u) => sql`(${u.id}::uuid, ${JSON.stringify(u.embedding)}::jsonb, ${u.content}::text)`
    );
    await db.execute(sql`
      UPDATE contact_embeddings AS e
      SET embedding = v.embedding, content = v.content
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, embedding, content)
      WHERE e.id = v.id
    `);
  }

  await persistEmbeddingVectors([
    ...inserted.map((row) => ({ id: row.id, embedding: row.embedding as number[] })),
    ...toUpdate.map((u) => ({ id: u.id, embedding: u.embedding })),
  ]);
}
