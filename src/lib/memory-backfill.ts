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
import {
  buildMemoryChunks,
  memorySourceHash,
  memorySourceHashSql,
  syncMemoryChunks,
  syncMemoryChunksMany,
  type MemoryChunkDraft,
} from "@/lib/memory-chunks";

/**
 * The one predicate for "an interaction whose passages are not what its text says they should
 * be". Shared by the claim and the count, so `remaining` can never report a row the claim
 * will not return — the drain's re-kick loop spins on exactly that disagreement.
 *
 * It reads as one NOT EXISTS and covers two cases: an interaction with no passages at all,
 * and one whose passages were built from text it no longer holds. Both are "no chunk of this
 * source carries the hash of the source as it stands now". That second case is why the column
 * exists — the claim used to be a bare anti-join, so a note was indexed once and never looked
 * at again, and an edit left its original passages quotable forever. Rows written before
 * v88 have a NULL `source_hash`, never match, and are re-chunked once.
 *
 * With a `userId`, the tenant is bound as a LITERAL inside the subquery as well as outside
 * it, and that is not decoration. A NOT EXISTS correlated only on `m.user_id = i.user_id`
 * reads as scoped, but once the table is ANALYZEd Postgres may rewrite it into a hashed
 * subplan evaluated once with no user predicate, scanning every tenant's chunks — the same
 * trap `experienceExists` in `@/lib/hybrid-search` documents. Without a `userId` (the
 * cross-user cron query) correlation is all there is, and that query runs once a day.
 */
function staleInteractions(userId?: string) {
  const outer = userId ? sql`and i.user_id = ${userId}` : sql``;
  const inner = userId ? sql`m.user_id = ${userId}` : sql`m.user_id = i.user_id`;
  return sql`
    from interactions i
    where (coalesce(i.raw_notes, '') <> '' or coalesce(i.ai_summary, '') <> '')
      ${outer}
      and not exists (
        select 1 from memory_chunks m
         where ${inner}
           and m.source_kind = 'interaction'
           and m.source_id = i.id
           and m.source_hash = ${memorySourceHashSql("i")}
      )
  `;
}

/** Interactions per pass. Each one is a delete-then-insert (written in groups, below), so this is the real write cost. */
const CLAIM_SIZE = 200;

/**
 * Interactions per write group. Each group is two round trips (the carry-over read and one
 * atomic delete+insert) however many rows it holds, which is what the sweep's cost is on
 * neon-http; small enough that a failed group's one-row retry stays well inside the budget.
 */
const SYNC_GROUP_SIZE = 50;

/**
 * Chunks per write group. A carried-over embedding travels in the insert, so this is what
 * bounds one request's size when a group is full of long, edited notes.
 */
const SYNC_GROUP_MAX_CHUNKS = 200;

/** Leaves room inside a 60s route or a cron slot for whatever else the caller is doing. */
const TIME_BUDGET_MS = 20_000;

export type MemoryBackfillResult = {
  scanned: number;
  indexed: number;
  chunks: number;
  /** Interactions still unindexed for this user. Non-zero means call again. */
  remaining: number;
};

/** Everything indexing one interaction needs, in the shape the claim query returns it. */
type IndexableInteraction = {
  id: string;
  contact_id: string | null;
  interaction_type: string;
  interaction_date: string | null;
  raw_notes: string | null;
  ai_summary: string | null;
  contact_name: string | null;
  mention_ids: string[] | null;
};

/** The columns the claim selects, reused verbatim by the single-row re-index below. */
const INDEXABLE_COLUMNS = (userId: string) => sql`
  i.id,
  i.contact_id,
  i.interaction_type,
  i.interaction_date,
  i.raw_notes,
  i.ai_summary,
  coalesce(c.preferred_name, c.full_name) as contact_name,
  -- Everyone else the note names. Loaded here, with the row, rather than in a query per
  -- interaction: the sweep claims hundreds at a time, and a note that names four people has
  -- to be findable from all four, not just from the one it was filed under.
  coalesce(
    (select array_agg(im.contact_id)
       from interaction_mentions im
      where im.user_id = ${userId} and im.interaction_id = i.id),
    '{}') as mention_ids
`;

/**
 * Turn one claimed row into passages. The chunker is pure; this is the part that knows how an
 * `interactions` row maps onto it, and it lives in one place so the sweep and the write-path
 * re-index cannot drift into indexing the same note two different ways.
 *
 * Pure: the write is the caller's, one source at a time or a group at once.
 */
function prepareClaimedInteraction(row: IndexableInteraction) {
  const occurredAt = row.interaction_date ? new Date(row.interaction_date) : null;
  const text = row.raw_notes || row.ai_summary;
  const drafts = buildMemoryChunks({
    text,
    occurredAt,
    kindLabel: interactionTypeLabel(row.interaction_type),
    contactId: row.contact_id,
    contactName: row.contact_name,
    contactIds: row.mention_ids ?? [],
  });
  const sourceHash = memorySourceHash({
    text,
    occurredAt,
    interactionType: row.interaction_type,
    contactId: row.contact_id,
  });
  return { drafts, sourceHash };
}

/** Index one claimed row. Returns the number of chunks written, or 0 for a row with nothing to index. */
async function indexClaimedInteraction(userId: string, row: IndexableInteraction): Promise<number> {
  const { drafts, sourceHash } = prepareClaimedInteraction(row);
  if (!drafts.length) return 0;
  const result = await syncMemoryChunks(userId, {
    sourceKind: "interaction",
    sourceId: row.id,
    drafts,
    sourceHash,
  });
  return result.written;
}

/**
 * Re-index one interaction right now, for the paths a person is waiting on.
 *
 * The sweep would get to it on its own — that is what the source hash is for — but not until
 * the daily cron runs, and "I fixed that note an hour ago" is exactly when someone asks about
 * it. Bulk paths deliberately do NOT call this; they leave their rows to the sweep.
 */
export async function reindexInteractionPassages(
  userId: string,
  interactionId: string
): Promise<number> {
  const db = await getDb();
  const [row] = rowsOf<IndexableInteraction>(
    await db.execute(sql`
      select ${INDEXABLE_COLUMNS(userId)}
        from interactions i
        left join contacts c on c.id = i.contact_id and c.user_id = ${userId}
       where i.id = ${interactionId}::uuid and i.user_id = ${userId}
    `)
  );
  if (!row) return 0;
  return indexClaimedInteraction(userId, row);
}

/**
 * Index interactions whose passages are missing or out of date.
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
    rowsOf<IndexableInteraction>(
      await db.execute(sql`
        select ${INDEXABLE_COLUMNS(userId)}
          from (select i.* ${staleInteractions(userId)}) i
          left join contacts c on c.id = i.contact_id and c.user_id = ${userId}
         order by i.interaction_date desc nulls last
         limit ${take}
      `)
    );

  let scanned = 0;
  let indexed = 0;
  let chunks = 0;

  /** The original one-row path, kept as the fallback when a group write fails. */
  const indexOne = async (row: IndexableInteraction) => {
    scanned++;
    try {
      const written = await indexClaimedInteraction(userId, row);
      if (!written) return;
      indexed++;
      chunks += written;
    } catch (err) {
      // One bad row must not stop the sweep — the next pass will try it again, and a row
      // that fails forever is one unindexed note rather than an unindexed account.
      console.warn("[memory-backfill] could not index interaction", row.id, err);
    }
  };

  const rows = await claim(limit);
  let next = 0;
  while (next < rows.length) {
    if (Date.now() - started > budget) break;

    // Chunked in memory first (pure), then written a group at a time: one carry-over read
    // and one atomic delete+insert per group instead of two round trips per interaction.
    const group: Array<{ row: IndexableInteraction; drafts: MemoryChunkDraft[]; sourceHash: string }> = [];
    let groupChunks = 0;
    while (next < rows.length && group.length < SYNC_GROUP_SIZE) {
      const row = rows[next];
      let prepared: ReturnType<typeof prepareClaimedInteraction>;
      try {
        prepared = prepareClaimedInteraction(row);
      } catch (err) {
        next++;
        scanned++;
        console.warn("[memory-backfill] could not index interaction", row.id, err);
        continue;
      }
      if (group.length && groupChunks + prepared.drafts.length > SYNC_GROUP_MAX_CHUNKS) break;
      next++;
      if (!prepared.drafts.length) {
        // Nothing to index, and — exactly as one row at a time — nothing written for it.
        scanned++;
        continue;
      }
      group.push({ row, ...prepared });
      groupChunks += prepared.drafts.length;
    }
    if (!group.length) continue;

    try {
      const counts = await syncMemoryChunksMany(
        userId,
        "interaction",
        group.map((g) => ({ sourceId: g.row.id, drafts: g.drafts, sourceHash: g.sourceHash }))
      );
      scanned += group.length;
      for (const { written } of counts) {
        if (!written) continue;
        indexed++;
        chunks += written;
      }
    } catch (err) {
      // The group is one atomic write, so nothing of it landed. Retry it a row at a time,
      // under the same budget, so one row that cannot be written costs only itself.
      console.warn("[memory-backfill] group write failed; retrying one at a time", err);
      for (const { row } of group) {
        if (Date.now() - started > budget) break;
        await indexOne(row);
      }
    }
  }

  return { scanned, indexed, chunks, remaining: await pendingMemorySourceCount(userId) };
}

/** Interactions with text and no passages yet. The same predicate the sweep claims with. */
export async function pendingMemorySourceCount(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n ${staleInteractions(userId)}`)
  );
  return Number(row?.n ?? 0);
}

/**
 * Users with passage work outstanding, for the daily cron's backstop.
 *
 * The cron used to pick users by `contacts.embedding_stale_at` alone, so an account whose
 * only pending work was passages — every existing account, on the day this ships — would
 * never have been swept unless it happened to import something. Two sources, both bounded:
 * chunks awaiting an embedding (served by the partial pending index, cheap), and
 * interactions whose passages are missing or stale (an anti-join over interactions; this one scans, and
 * once history is indexed it scans to find nothing, which at Orbit's size is a fraction of a
 * second a day and is the price of not needing a flag column to keep in sync).
 */
export async function usersWithPendingMemoryWork(
  limit: number,
  canEmbed: (userId: string) => Promise<boolean>
): Promise<string[]> {
  const db = await getDb();
  const [unindexed, unembedded] = await Promise.all([
    db.execute(sql`select distinct i.user_id ${staleInteractions()} limit ${limit}`),
    // Over-fetched, because some of these will be filtered out below.
    db.execute(sql`
      select distinct m.user_id from memory_chunks m
       where m.embedded_hash is distinct from m.content_hash
       limit ${limit * 4}
    `),
  ]);

  const picked = new Set(rowsOf<{ user_id: string }>(unindexed).map((r) => r.user_id));
  // An account with passages awaiting embedding but no embeddings backend — an Anthropic
  // key — has work that can never be done. Left in, those accounts would fill this list
  // every day and starve the ones that can make progress.
  for (const { user_id } of rowsOf<{ user_id: string }>(unembedded)) {
    if (picked.size >= limit) break;
    if (!picked.has(user_id) && (await canEmbed(user_id))) picked.add(user_id);
  }
  return [...picked].slice(0, limit);
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
