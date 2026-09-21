/**
 * Indexing the notes that were already there.
 *
 * `logInteractionForUser` indexes a note as it is written, which covers the path a person is
 * waiting on. This covers the other two cases, and both are large: every interaction that
 * predates `memory_chunks`, and the bulk paths (imports, calendar sync, timeline backfills)
 * that deliberately skip per-row work because they write thousands of rows at a time.
 *
 * Bounded the same way `runEmbeddingBackfill` is, and for the same reason: it runs inside a
 * request or a cron invocation with a real deadline, so it claims a slice, does what it can,
 * and reports what is left rather than trying to finish.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interactionTypeLabel } from "@/lib/interaction-types";
import { buildMemoryChunks, syncMemoryChunks } from "@/lib/memory-chunks";

/** Interactions per pass. Each one is a delete-then-insert, so this is the real write cost. */
const CLAIM_SIZE = 200;

/** Leaves room inside a 60s route or a cron slot for whatever else the caller is doing. */
const TIME_BUDGET_MS = 20_000;

export type MemoryBackfillResult = {
  scanned: number;
  indexed: number;
  chunks: number;
  /** Interactions still unindexed for this user. Non-zero means call again. */
  remaining: number;
};

/**
 * Index interactions that have no chunks yet.
 *
 * The claim is a NOT EXISTS against `memory_chunks`, not a flag on `interactions`: a flag
 * would need its own column, its own migration and its own reconciliation when a chunk row
 * is deleted, and the anti-join is exact by construction. It is indexed on the
 * `memory_chunks` side by the unique `(user_id, source_kind, source_id, chunk_index)`.
 */
export async function backfillMemoryChunks(
  userId: string,
  options: { limit?: number; budgetMs?: number } = {}
): Promise<MemoryBackfillResult> {
  const db = await getDb();
  const started = Date.now();
  const budget = options.budgetMs ?? TIME_BUDGET_MS;
  const limit = options.limit ?? CLAIM_SIZE;

  const claim = async (take: number) =>
    rowsOf<{
      id: string;
      contact_id: string | null;
      interaction_type: string;
      interaction_date: string | null;
      raw_notes: string | null;
      ai_summary: string | null;
      contact_name: string | null;
    }>(
      await db.execute(sql`
        select i.id,
               i.contact_id,
               i.interaction_type,
               i.interaction_date,
               i.raw_notes,
               i.ai_summary,
               coalesce(c.preferred_name, c.full_name) as contact_name
          from interactions i
          left join contacts c on c.id = i.contact_id and c.user_id = ${userId}
         where i.user_id = ${userId}
           and (coalesce(i.raw_notes, '') <> '' or coalesce(i.ai_summary, '') <> '')
           and not exists (
             select 1 from memory_chunks m
              where m.user_id = ${userId}
                and m.source_kind = 'interaction'
                and m.source_id = i.id
           )
         order by i.interaction_date desc nulls last
         limit ${take}
      `)
    );

  let scanned = 0;
  let indexed = 0;
  let chunks = 0;

  const rows = await claim(limit);
  for (const row of rows) {
    if (Date.now() - started > budget) break;
    scanned++;
    const drafts = buildMemoryChunks({
      text: row.raw_notes || row.ai_summary,
      occurredAt: row.interaction_date ? new Date(row.interaction_date) : null,
      kindLabel: interactionTypeLabel(row.interaction_type),
      contactId: row.contact_id,
      contactName: row.contact_name,
      contactIds: [],
    });
    if (!drafts.length) continue;
    try {
      const result = await syncMemoryChunks(userId, {
        sourceKind: "interaction",
        sourceId: row.id,
        drafts,
      });
      indexed++;
      chunks += result.written;
    } catch (err) {
      // One bad row must not stop the sweep — the next pass will try it again, and a row
      // that fails forever is one unindexed note rather than an unindexed account.
      console.warn("[memory-backfill] could not index interaction", row.id, err);
    }
  }

  const [{ count: remaining }] = rowsOf<{ count: number }>(
    await db.execute(sql`
      select count(*)::int as count
        from interactions i
       where i.user_id = ${userId}
         and (coalesce(i.raw_notes, '') <> '' or coalesce(i.ai_summary, '') <> '')
         and not exists (
           select 1 from memory_chunks m
            where m.user_id = ${userId}
              and m.source_kind = 'interaction'
              and m.source_id = i.id
         )
    `)
  );

  return { scanned, indexed, chunks, remaining: remaining ?? 0 };
}

/**
 * Drop chunks whose interaction is gone.
 *
 * `memory_chunks.contact_id` cascades, so deleting a contact takes their passages with them.
 * A deleted INTERACTION does not cascade — `source_id` is a plain uuid, deliberately, so the
 * table can index things that are not interactions — which would otherwise leave a passage
 * quoting a note the user deleted. That is the one kind of staleness here that is a privacy
 * problem rather than a quality one.
 */
export async function pruneOrphanedMemoryChunks(userId: string): Promise<number> {
  const db = await getDb();
  // RETURNING so the count is the rows actually removed — a driver's `rowCount` is not
  // uniformly available across neon-http and PGlite, and guessing it from an empty result
  // set would report zero deletions every time.
  const removed = rowsOf<{ id: string }>(
    await db.execute(sql`
      delete from memory_chunks m
       where m.user_id = ${userId}
         and m.source_kind = 'interaction'
         and not exists (
           select 1 from interactions i where i.id = m.source_id and i.user_id = ${userId}
         )
      returning m.id
    `)
  );
  return removed.length;
}
