/**
 * Fills in embeddings for contacts flagged `embedding_stale_at`.
 *
 * Imports no longer embed inline: an embedding call is a network round trip to an AI
 * provider sitting in the middle of a write loop, which made a large import both slow and
 * hostage to that provider's availability. Imports flag rows instead, and this drains them
 * afterwards.
 *
 * Time-boxed and self-continuing, the same shape as the import engine — a user with
 * thousands of stale contacts must not need a single invocation to hold them all.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts } from "@/db/schema";
import { createEmbeddingsBatch } from "@/lib/ai";
import { buildContactEmbeddingContent, persistEmbeddingVectors } from "@/lib/search";

/** Contacts claimed per pass. */
const CLAIM_SIZE = 500;
/** Texts per provider call — well under OpenAI's input cap, small enough to retry cheaply. */
const EMBED_BATCH = 200;
/** Leaves room under the 300s ceiling for a self-continuation request. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * `embed` defaults to the real provider call; the smoke test overrides it with a
 * deterministic stub so the upsert, RETURNING mapping, chunked vector write, and flag
 * clear all run under test without needing a live AI key. Every real caller gets the
 * default, so this changes no production behavior.
 */
export async function runEmbeddingBackfill(
  userId: string,
  embed: typeof createEmbeddingsBatch = createEmbeddingsBatch
): Promise<{ embedded: number; remaining: number }> {
  const db = await getDb();
  const start = Date.now();
  let embedded = 0;

  while (Date.now() - start < TIME_BUDGET_MS) {
    const stale = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)),
      orderBy: [asc(contacts.embeddingStaleAt)],
      limit: CLAIM_SIZE,
      with: { contactTags: { with: { tag: true } } },
    });
    if (stale.length === 0) break;

    const entries = stale
      .map((contact) => ({
        contactId: contact.id,
        content: buildContactEmbeddingContent(contact),
      }))
      .filter((entry) => entry.content.trim().length > 0);

    const embeddable = new Set(entries.map((entry) => entry.contactId));
    // A contact with no embeddable text is not pending work — clear its flag so the loop
    // cannot spin on it forever, but write no embedding row.
    const emptyIds = stale.map((c) => c.id).filter((id) => !embeddable.has(id));

    for (let i = 0; i < entries.length; i += EMBED_BATCH) {
      const slice = entries.slice(i, i + EMBED_BATCH);
      // Deliberately not caught: a provider failure must leave `embedding_stale_at` set so
      // the next pass retries. Swallowing it here would silently drop the work.
      const vectors = await embed(
        userId,
        slice.map((entry) => entry.content)
      );

      const tuples = slice.map(
        (entry, j) => sql`(
          ${userId}::text, ${entry.contactId}::uuid, 'profile'::text,
          ${entry.contactId}::text, ${JSON.stringify(vectors[j])}::jsonb,
          ${entry.content}::text
        )`
      );

      const result = await db.execute(sql`
        INSERT INTO contact_embeddings
          (user_id, contact_id, source_type, source_id, embedding, content)
        VALUES ${sql.join(tuples, sql`, `)}
        ON CONFLICT (user_id, contact_id, source_type)
        DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
        RETURNING id, contact_id
      `);

      // `db.execute` returns an array on neon-http and `{ rows }` on PGlite; both drivers
      // are in play (production and local), so neither shape can be assumed. `rowsOf` is
      // the shared normalizer for this (see `src/db/index.ts`).
      const returned = rowsOf<{ id: string; contact_id: string }>(result);
      const idByContact = new Map(returned.map((r) => [r.contact_id, r.id]));

      await persistEmbeddingVectors(
        slice
          .map((entry, j) => ({
            id: idByContact.get(entry.contactId) ?? "",
            embedding: vectors[j],
          }))
          .filter((row) => row.id)
      );

      await db
        .update(contacts)
        .set({ embeddingStaleAt: null })
        .where(inArray(contacts.id, slice.map((entry) => entry.contactId)));

      embedded += slice.length;
    }

    if (emptyIds.length > 0) {
      await db
        .update(contacts)
        .set({ embeddingStaleAt: null })
        .where(inArray(contacts.id, emptyIds));
    }
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)));

  return { embedded, remaining: Number(row?.value ?? 0) };
}
