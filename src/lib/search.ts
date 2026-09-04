import { createHash } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { getDb, isPgvectorAvailable, rowsOf } from "@/db";
import { contactEmbeddings, contacts } from "@/db/schema";
import { careerLine, type ExperienceEntry } from "@/lib/contact-profile-format";
import { metContextLabel } from "@/lib/met-context";
import { createEmbedding, createEmbeddingsBatch } from "@/lib/ai";
import { formatVectorLiteral } from "@/lib/pgvector";

export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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

/**
 * Returns true only when an embedding row was actually written or updated. A missing key,
 * a provider failure, or unchanged content (the stored embedding is still correct) all
 * return false — but for different reasons callers must not treat alike. Callers that mark
 * a contact `embedding_stale_at` must NOT clear the marker on a swallowed failure (the
 * backfill has to get another go); they SHOULD clear it on a same-content skip (there is
 * nothing left to redo).
 */
export async function upsertContactEmbedding(
  userId: string,
  contactId: string,
  sourceType: string,
  content: string,
  sourceId?: string
): Promise<boolean> {
  if (!content.trim()) return false;

  try {
    const db = await getDb();
    const contentHash = computeContentHash(content);

    const existing = sourceId
      ? await db.query.contactEmbeddings.findFirst({
          where: and(
            eq(contactEmbeddings.userId, userId),
            eq(contactEmbeddings.contactId, contactId),
            eq(contactEmbeddings.sourceType, sourceType),
            eq(contactEmbeddings.sourceId, sourceId)
          ),
        })
      : undefined;

    // Unchanged content: the stored embedding is still correct — skip the API call.
    if (existing?.contentHash === contentHash) return false;

    const embedding = await createEmbedding(userId, content);

    if (existing) {
      await db
        .update(contactEmbeddings)
        .set({ embedding, content, contentHash })
        .where(eq(contactEmbeddings.id, existing.id));
      await persistEmbeddingVectors([{ id: existing.id, embedding }]);
      return true;
    }

    const [inserted] = await db
      .insert(contactEmbeddings)
      .values({ userId, contactId, sourceType, sourceId, embedding, content, contentHash })
      .returning();
    if (inserted?.id) {
      await persistEmbeddingVectors([{ id: inserted.id, embedding }]);
    }
    return Boolean(inserted?.id);
  } catch {
    // AI key may be missing; skip embeddings silently
    return false;
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
  /**
   * A captured LinkedIn profile, when the contact has one. Its `about` and the career
   * line are what make "who came out of a hardware company" work semantically, rather
   * than only through the keyword arm's exists-subquery.
   */
  profile?: { about?: string | null; headline?: string | null } | null;
  experiences?: ExperienceEntry[];
};

/**
 * Embedding-content audit (spec §3), re-checked in Task 6:
 *
 * 1. This function never absorbs content that has its own source row. LinkedIn messages
 *    (`src/lib/message-enrichment.ts`) and meeting/interaction notes
 *    (`src/actions/imports.ts`, `src/lib/calendar-sync.ts`) call `upsertContactEmbedding`
 *    directly with their own `sourceType`/`sourceId` ("linkedin_message", "meeting") and
 *    never flow through here — no split needed on that front.
 * 2. This function's own output CAN exceed the 8,000-char truncation in
 *    `createEmbedding`/`createEmbeddingsBatch` (`src/lib/ai.ts:1165`) when `notes` is long,
 *    since `notes` is the one open-ended free-text field folded in below. `notes` is split
 *    into its own `sourceType: "notes"` row by `rebuildContactEmbedding` /
 *    `rebuildContactEmbeddingsBatch` whenever the combined content would overflow — see
 *    `PROFILE_CONTENT_TRUNCATION_LIMIT` below.
 */
export function buildContactEmbeddingContent(
  contact: ContactEmbeddingSource,
  options: { includeNotes?: boolean } = {}
): string {
  const includeNotes = options.includeNotes ?? true;
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
    includeNotes ? contact.notes : null,
    metContextLabel(contact.metContext),
    contact.dateMet
      ? new Date(contact.dateMet).toLocaleDateString()
      : null,
    contact.howMet,
    contact.profile?.headline,
    contact.profile?.about,
    careerLine(contact.experiences ?? []),
    ...(contact.keyFacts || []),
    ...(contact.opportunities || []),
    ...(contact.contactTags?.map((ct) => ct.tag.name) || []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Matches the embedding-input truncation in `createEmbedding`/`createEmbeddingsBatch`. */
const PROFILE_CONTENT_TRUNCATION_LIMIT = 8000;

/**
 * Splits a contact's profile embedding content into a `notes`-free profile chunk plus a
 * separate `notes` chunk when the combined content would otherwise overflow the 8,000-char
 * embedding truncation and silently lose its tail. Small contacts keep the single row they
 * had before, so this doesn't double the row count for the common case.
 */
function splitProfileEmbeddingContent(
  contact: ContactEmbeddingSource
): { profile: string; notes: string | null } {
  const full = buildContactEmbeddingContent(contact);
  if (full.length <= PROFILE_CONTENT_TRUNCATION_LIMIT || !contact.notes?.trim()) {
    return { profile: full, notes: null };
  }
  return {
    profile: buildContactEmbeddingContent(contact, { includeNotes: false }),
    notes: contact.notes,
  };
}

/** True only when a row was actually written; see `upsertContactEmbedding`. */
export async function rebuildContactEmbedding(userId: string, contactId: string): Promise<boolean> {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return false;

  const { profile, notes } = splitProfileEmbeddingContent(contact);
  const profileWritten = await upsertContactEmbedding(userId, contactId, "profile", profile, contactId);
  if (notes) {
    const notesWritten = await upsertContactEmbedding(userId, contactId, "notes", notes, contactId);
    return profileWritten || notesWritten;
  }
  // Content shrank back under the split threshold — drop the now-stale "notes" row so it
  // doesn't keep contributing to semantic search / content-boost matching forever.
  await db
    .delete(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, userId),
        eq(contactEmbeddings.contactId, contactId),
        eq(contactEmbeddings.sourceType, "notes"),
        eq(contactEmbeddings.sourceId, contactId)
      )
    );
  return profileWritten;
}

/** Rebuild "profile" (and, when content overflows, "notes") embeddings for many contacts
 *  with one batched embedding API call. `embedFn` is injectable for tests; it defaults to
 *  the real batched embedder. */
export async function rebuildContactEmbeddingsBatch(
  userId: string,
  contactIds: string[],
  embedFn: (userId: string, texts: string[]) => Promise<number[][]> = createEmbeddingsBatch
) {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return;

  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
    with: { contactTags: { with: { tag: true } } },
  });

  const existing = await db.query.contactEmbeddings.findMany({
    where: and(
      eq(contactEmbeddings.userId, userId),
      inArray(contactEmbeddings.sourceType, ["profile", "notes"]),
      inArray(contactEmbeddings.contactId, ids)
    ),
    columns: { id: true, contactId: true, sourceType: true, contentHash: true },
  });
  const existingByKey = new Map(
    existing.map((row) => [`${row.contactId}:${row.sourceType}`, row])
  );

  type Entry = { contactId: string; sourceType: "profile" | "notes"; content: string; contentHash: string };
  const candidates: Entry[] = [];
  for (const contact of rows) {
    const { profile, notes } = splitProfileEmbeddingContent(contact);
    if (profile.trim().length > 0) {
      candidates.push({ contactId: contact.id, sourceType: "profile", content: profile, contentHash: computeContentHash(profile) });
    }
    if (notes && notes.trim().length > 0) {
      candidates.push({ contactId: contact.id, sourceType: "notes", content: notes, contentHash: computeContentHash(notes) });
    }
  }

  // Content that shrank back under the split threshold stops producing a "notes" candidate
  // this run — drop any stored "notes" row for that contact so stale text doesn't keep
  // contributing to semantic search / content-boost matching. Driven by the candidate set,
  // not by hash comparison, so this fires even when nothing else changed this run.
  const notesCandidateContactIds = new Set(
    candidates.filter((entry) => entry.sourceType === "notes").map((entry) => entry.contactId)
  );
  const orphanedNotesRows = existing.filter(
    (row) => row.sourceType === "notes" && !notesCandidateContactIds.has(row.contactId)
  );
  if (orphanedNotesRows.length > 0) {
    await db.delete(contactEmbeddings).where(
      inArray(contactEmbeddings.id, orphanedNotesRows.map((row) => row.id))
    );
  }

  // Unchanged content keeps its stored embedding — no API call, no write.
  const entries = candidates.filter(
    (entry) => existingByKey.get(`${entry.contactId}:${entry.sourceType}`)?.contentHash !== entry.contentHash
  );
  if (entries.length === 0) return;

  let embeddings: number[][];
  try {
    embeddings = await embedFn(userId, entries.map((entry) => entry.content));
  } catch {
    return; // AI key may be missing; skip silently, matching upsertContactEmbedding.
  }

  const toInsert: Array<typeof contactEmbeddings.$inferInsert> = [];
  const toUpdate: Array<{ id: string; embedding: number[]; content: string; contentHash: string }> = [];

  entries.forEach((entry, index) => {
    const embedding = embeddings[index];
    const found = existingByKey.get(`${entry.contactId}:${entry.sourceType}`);
    if (found) {
      toUpdate.push({ id: found.id, embedding, content: entry.content, contentHash: entry.contentHash });
    } else {
      toInsert.push({
        userId,
        contactId: entry.contactId,
        sourceType: entry.sourceType,
        sourceId: entry.contactId,
        embedding,
        content: entry.content,
        contentHash: entry.contentHash,
      });
    }
  });

  const vectorRows: Array<{ id: string; embedding: number[] }> = [];

  if (toInsert.length > 0) {
    const inserted = await db.insert(contactEmbeddings).values(toInsert).returning();
    for (const row of inserted) {
      vectorRows.push({ id: row.id, embedding: row.embedding as number[] });
    }
  }

  if (toUpdate.length > 0) {
    const values = sql.join(
      toUpdate.map(
        (u) =>
          sql`(${u.id}::uuid, ${JSON.stringify(u.embedding)}::jsonb, ${u.content}, ${u.contentHash})`
      ),
      sql`, `
    );
    await db.execute(sql`
      UPDATE contact_embeddings AS ce
      SET embedding = v.embedding, content = v.content, content_hash = v.content_hash
      FROM (VALUES ${values}) AS v(id, embedding, content, content_hash)
      WHERE ce.id = v.id
    `);
    for (const u of toUpdate) vectorRows.push({ id: u.id, embedding: u.embedding });
  }

  await persistEmbeddingVectors(vectorRows);
}
