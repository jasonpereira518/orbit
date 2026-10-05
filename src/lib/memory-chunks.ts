/**
 * Cutting the user's own writing into passages that can be retrieved on their own.
 *
 * WHY. Notes were embedded as one blob per contact, capped at 8,000 characters, and a note
 * could only be found by first finding its contact. Two things follow from that and both are
 * user-visible: a long note ranks its contact on a sentence the prompt then cannot show (see
 * `@/lib/note-window`, which mitigates the second half of it), and a question with no person
 * in it — "what did I discuss about fundraising in March" — has no query plan at all, because
 * `interactions` had no full-text index and no embeddings outside LinkedIn messages.
 *
 * A chunk is the unit that fixes both: its own text, its own date, its own embedding, and its
 * own provenance triple `(source_kind, source_id, chunk_index)` so an answer can say where a
 * claim came from.
 *
 * The chunker is pure and the writer is not; `scripts/smoke-memory-chunks.ts` drives the
 * chunker directly, which is where the boundary rules are pinned.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, runAtomicWrite, type AtomicStatement } from "@/db";
import { memoryChunks } from "@/db/schema";
import { computeContentHash } from "@/lib/search";

export type MemorySourceKind = "interaction" | "note_batch" | "brief";

export type MemoryChunkDraft = {
  chunkIndex: number;
  content: string;
  contentHash: string;
  contactId: string | null;
  contactIds: string[];
  occurredAt: Date | null;
};

/**
 * Target size, in characters.
 *
 * ~900 is roughly a long paragraph: big enough that a sentence keeps the context that makes
 * it mean something ("she said yes" is useless on its own), small enough that one embedding
 * is about one topic. The old behaviour — one 8,000-character blob — is the failure this
 * number exists to avoid: a vector averaged over eight topics is close to none of them.
 */
const TARGET_CHARS = 900;

/**
 * Overlap between neighbours.
 *
 * A sentence that straddles a boundary would otherwise be half in each chunk and whole in
 * neither, so it matches weakly twice instead of strongly once.
 */
const OVERLAP_CHARS = 150;

/** Below this a note is one chunk. Most notes are one or two lines and splitting them helps nothing. */
const SINGLE_CHUNK_BELOW = 1_200;

/**
 * Hard ceiling per source. A pathological note must not be able to write hundreds of rows,
 * each of which is an embedding call the user pays for on their own key.
 */
const MAX_CHUNKS = 32;

/** Prefer a paragraph break, then a sentence end, then a space — never mid-word. */
function breakPoint(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > 0) return from + paragraph + 2;
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf(".\n")
  );
  if (sentence > 0) return from + sentence + 2;
  const space = window.lastIndexOf(" ");
  if (space > 0) return from + space + 1;
  return to;
}

/** Split prose into overlapping windows on natural boundaries. Pure. */
export function splitIntoPassages(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= SINGLE_CHUNK_BELOW) return [clean];

  const out: string[] = [];
  let cursor = 0;
  while (cursor < clean.length && out.length < MAX_CHUNKS) {
    const hardEnd = Math.min(cursor + TARGET_CHARS, clean.length);
    // The last window takes whatever is left rather than breaking and stranding a tail.
    const end =
      hardEnd >= clean.length
        ? clean.length
        : breakPoint(clean, cursor + Math.floor(TARGET_CHARS / 2), hardEnd);
    const piece = clean.slice(cursor, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    // Step back by the overlap — but land on a word boundary. Stepping back a fixed number
    // of characters puts the next chunk's first word in the middle of the previous chunk's
    // last one ("…qu|arter looks like"), which is a broken token at the head of an embedding
    // and a broken word at the head of whatever snippet a citation shows.
    //
    // Always at least one character forward, or a break point behind the overlap would walk
    // backwards forever. And never past `end`, or the snap would skip text that no chunk
    // then covers — a sentence that exists and cannot be found, which is the bug this whole
    // phase is about.
    const stepBack = Math.max(end - OVERLAP_CHARS, cursor + 1);
    const boundary = clean.indexOf(" ", stepBack);
    cursor = boundary >= 0 && boundary + 1 < end ? boundary + 1 : stepBack;
  }
  return out;
}

/**
 * A short, deterministic header on every chunk: the date, the kind and who it is about.
 *
 * It does two jobs at once. The embedding gets date and person signal it would otherwise
 * have to infer from prose that may not mention either, and the snippet a citation shows is
 * self-describing instead of a paragraph starting mid-thought.
 */
export function chunkHeader(input: {
  occurredAt: Date | null;
  kindLabel: string;
  contactName: string | null;
}): string {
  const parts = [
    input.occurredAt ? input.occurredAt.toISOString().slice(0, 10) : null,
    input.kindLabel,
    input.contactName,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" · ");
}

/**
 * What an interaction's passages were built FROM, as one md5.
 *
 * This is the staleness signal for content, and it is deliberately not the same thing as
 * `content_hash` (which is per chunk, over the rendered passage) or `embedded_hash` (which
 * asks whether the vector is current). It answers: does this chunk set still describe the row
 * as it stands now?
 *
 * It exists because the sweep's claim used to be a pure anti-join — an interaction with no
 * passages — so a note was indexed once and never looked at again. Editing it left the
 * original passages quotable forever. A hook on the write path could not fix that: three of
 * the five paths that change this text are bulk (the import upsert, the calendar ingest
 * upsert, and `events/connect.ts`), and per-row re-indexing is exactly what those paths pass
 * `skipEmbedding` to avoid. A hash the CLAIM can compute covers all five, including ones
 * nobody has written yet.
 *
 * Fixed-width fields first, free text last, so a `|` inside a note cannot shift the fields
 * around it. The date is epoch SECONDS rather than a formatted timestamp: no timezone, no
 * precision mismatch between `toISOString` and `to_char`. The raw interaction type is hashed
 * rather than its rendered label, because the label is derived from it and the SQL side
 * should not have to reproduce a TypeScript lookup table.
 */
export function memorySourceHash(input: {
  text: string | null | undefined;
  occurredAt: Date | null;
  interactionType: string | null;
  contactId: string | null;
}): string {
  const seconds =
    input.occurredAt && !Number.isNaN(input.occurredAt.getTime())
      ? String(Math.floor(input.occurredAt.getTime() / 1000))
      : "";
  const canonical = [
    seconds,
    input.interactionType ?? "",
    input.contactId ?? "",
    input.text ?? "",
  ].join("|");
  return createHash("md5").update(canonical, "utf8").digest("hex");
}

/**
 * The same hash, rendered in SQL over an `interactions` row.
 *
 * It MUST stay byte-for-byte equivalent to `memorySourceHash` above; the two are next to each
 * other so a change to one is an obvious omission in the other. Postgres `md5()` is core (not
 * pgcrypto, so PGlite has it too) and agrees with node's md5 on UTF-8 input, including
 * multi-byte characters and the empty string — `scripts/smoke-memory-search.ts` pins that,
 * and pins the consequence too: if the two ever disagree, the sweep re-chunks every
 * interaction on every run forever, which shows up there as a second sweep doing work.
 *
 * `nullif(raw_notes, '')` mirrors the TypeScript `raw_notes || ai_summary`: an empty string
 * falls through to the summary, exactly as a falsy value does in JavaScript.
 *
 * @param alias - the table alias the surrounding query gave `interactions`.
 */
export function memorySourceHashSql(alias = "i"): SQL {
  const t = sql.raw(alias);
  return sql`md5(
    coalesce(floor(extract(epoch from ${t}.interaction_date))::bigint::text, '')
    || '|' || coalesce(${t}.interaction_type, '')
    || '|' || coalesce(${t}.contact_id::text, '')
    || '|' || coalesce(nullif(${t}.raw_notes, ''), ${t}.ai_summary, '')
  )`;
}

/** Turn one piece of writing into drafts ready to store. Pure. */
export function buildMemoryChunks(input: {
  text: string | null | undefined;
  occurredAt: Date | null;
  kindLabel: string;
  contactId: string | null;
  contactName: string | null;
  /** Everyone named, including mentions. The primary subject is included if present. */
  contactIds: string[];
}): MemoryChunkDraft[] {
  const passages = splitIntoPassages(input.text ?? "");
  if (!passages.length) return [];
  const header = chunkHeader({
    occurredAt: input.occurredAt,
    kindLabel: input.kindLabel,
    contactName: input.contactName,
  });
  const ids = [...new Set([...(input.contactId ? [input.contactId] : []), ...input.contactIds])];

  return passages.map((passage, chunkIndex) => {
    const content = header ? `${header}\n${passage}` : passage;
    return {
      chunkIndex,
      content,
      contentHash: computeContentHash(content),
      contactId: input.contactId,
      contactIds: ids,
      occurredAt: input.occurredAt,
    };
  });
}

/**
 * Replace one source's chunks with these.
 *
 * Delete-then-insert rather than a diff, because chunk boundaries move when the middle of a
 * note is edited and matching old positions to new ones is guesswork. What IS carried across
 * is the embedding: any incoming chunk whose `content_hash` already exists for this source
 * keeps its `embedded_hash` and vector, so editing the third paragraph of a note does not
 * pay to re-embed the first two.
 *
 * Through `runAtomicWrite` because neon-http has no transactions — see `@/db`.
 */
export async function syncMemoryChunks(
  userId: string,
  input: {
    sourceKind: MemorySourceKind;
    sourceId: string;
    drafts: MemoryChunkDraft[];
    /** `memorySourceHash` of the row these drafts came from — the sweep's staleness signal. */
    sourceHash?: string | null;
  },
  options: { db?: Awaited<ReturnType<typeof getDb>> } = {}
): Promise<{ written: number; reused: number }> {
  const db = options.db ?? (await getDb());

  const existing = await db.query.memoryChunks.findMany({
    where: and(
      eq(memoryChunks.userId, userId),
      eq(memoryChunks.sourceKind, input.sourceKind),
      eq(memoryChunks.sourceId, input.sourceId)
    ),
    columns: { contentHash: true, embeddedHash: true, embedding: true },
  });
  const embedded = new Map(
    existing
      .filter((row) => row.embeddedHash && row.embeddedHash === row.contentHash && row.embedding)
      .map((row) => [row.contentHash, row] as const)
  );

  let reused = 0;
  const values = input.drafts.map((draft) => {
    const carried = embedded.get(draft.contentHash);
    if (carried) reused++;
    return {
      userId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      contactId: draft.contactId,
      contactIds: draft.contactIds,
      occurredAt: draft.occurredAt,
      chunkIndex: draft.chunkIndex,
      content: draft.content,
      contentHash: draft.contentHash,
      sourceHash: input.sourceHash ?? null,
      embeddedHash: carried?.embeddedHash ?? null,
      embedding: carried?.embedding ?? null,
    };
  });

  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [
      tx
        .delete(memoryChunks)
        .where(
          and(
            eq(memoryChunks.userId, userId),
            eq(memoryChunks.sourceKind, input.sourceKind),
            eq(memoryChunks.sourceId, input.sourceId)
          )
        ),
    ];
    if (values.length) statements.push(tx.insert(memoryChunks).values(values));
    return statements;
  });

  return { written: values.length, reused };
}

/**
 * `syncMemoryChunks` for many sources of one kind at once: one read, one atomic write.
 *
 * The sweep claims hundreds of interactions a pass, and on neon-http the single-source
 * version costs two round trips each (the carry-over read, then the delete+insert group), so
 * a 200-row claim was 400 sequential HTTPS requests. This is the same work in two.
 *
 * Carry-over is keyed exactly as above — per source, by `content_hash`, only from a chunk
 * whose `embedded_hash` matches and that holds a vector — so an edited note keeps its
 * untouched paragraphs' embeddings just as it would one source at a time. The read is
 * narrowed in SQL to chunks that could be carried (a hash some incoming draft has, already
 * embedded), because the vectors are the wide part of the row and the rest are about to be
 * deleted anyway; the same filter then runs in TypeScript so the rule stays byte-for-byte
 * the single version's.
 *
 * Every source's delete and insert travel in one `runAtomicWrite`, so the group lands or
 * fails whole. The caller keeps groups small (see the sweep) and falls back to the
 * one-source path when a group fails, so one bad row costs its group a retry, not the pass.
 *
 * Returns the per-source counts in `sources` order.
 */
export async function syncMemoryChunksMany(
  userId: string,
  sourceKind: MemorySourceKind,
  sources: Array<{ sourceId: string; drafts: MemoryChunkDraft[]; sourceHash?: string | null }>,
  options: { db?: Awaited<ReturnType<typeof getDb>> } = {}
): Promise<Array<{ written: number; reused: number }>> {
  if (!sources.length) return [];
  const db = options.db ?? (await getDb());
  const sourceIds = [...new Set(sources.map((s) => s.sourceId))];
  const hashes = [...new Set(sources.flatMap((s) => s.drafts.map((d) => d.contentHash)))];

  const existing = hashes.length
    ? await db
        .select({
          sourceId: memoryChunks.sourceId,
          contentHash: memoryChunks.contentHash,
          embeddedHash: memoryChunks.embeddedHash,
          embedding: memoryChunks.embedding,
        })
        .from(memoryChunks)
        .where(
          and(
            eq(memoryChunks.userId, userId),
            eq(memoryChunks.sourceKind, sourceKind),
            inArray(memoryChunks.sourceId, sourceIds),
            inArray(memoryChunks.contentHash, hashes),
            sql`${memoryChunks.embeddedHash} = ${memoryChunks.contentHash}`,
            sql`${memoryChunks.embedding} is not null`
          )
        )
    : [];
  const embeddedBySource = new Map<string, Map<string, (typeof existing)[number]>>();
  for (const row of existing) {
    if (!(row.embeddedHash && row.embeddedHash === row.contentHash && row.embedding)) continue;
    let bySource = embeddedBySource.get(row.sourceId);
    if (!bySource) embeddedBySource.set(row.sourceId, (bySource = new Map()));
    bySource.set(row.contentHash, row);
  }

  const counts: Array<{ written: number; reused: number }> = [];
  const values = sources.flatMap((source) => {
    const embedded = embeddedBySource.get(source.sourceId);
    let reused = 0;
    const rows = source.drafts.map((draft) => {
      const carried = embedded?.get(draft.contentHash);
      if (carried) reused++;
      return {
        userId,
        sourceKind,
        sourceId: source.sourceId,
        contactId: draft.contactId,
        contactIds: draft.contactIds,
        occurredAt: draft.occurredAt,
        chunkIndex: draft.chunkIndex,
        content: draft.content,
        contentHash: draft.contentHash,
        sourceHash: source.sourceHash ?? null,
        embeddedHash: carried?.embeddedHash ?? null,
        embedding: carried?.embedding ?? null,
      };
    });
    counts.push({ written: rows.length, reused });
    return rows;
  });

  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [
      tx
        .delete(memoryChunks)
        .where(
          and(
            eq(memoryChunks.userId, userId),
            eq(memoryChunks.sourceKind, sourceKind),
            inArray(memoryChunks.sourceId, sourceIds)
          )
        ),
    ];
    if (values.length) statements.push(tx.insert(memoryChunks).values(values));
    return statements;
  });

  return counts;
}

/** Drop everything indexed from one source — a deleted note, a merged-away contact. */
export async function deleteMemoryChunks(
  userId: string,
  input: { sourceKind: MemorySourceKind; sourceIds: string[] },
  options: { db?: Awaited<ReturnType<typeof getDb>> } = {}
): Promise<void> {
  if (!input.sourceIds.length) return;
  const db = options.db ?? (await getDb());
  await db
    .delete(memoryChunks)
    .where(
      and(
        eq(memoryChunks.userId, userId),
        eq(memoryChunks.sourceKind, input.sourceKind),
        inArray(memoryChunks.sourceId, input.sourceIds)
      )
    );
}

/**
 * Fold an interaction's mentions into its passages' `contact_ids`.
 *
 * `contact_ids` is what makes a note naming four people findable from any of them, but the
 * chunker cannot fill it on its own: `interaction_mentions` is written AFTER the interaction
 * row it hangs off (`note-batch-save.ts`), so at chunk time there is nothing to read. Without
 * this, a dinner note stays findable only from the person it happened to be filed under.
 *
 * Reads the mentions in SQL rather than taking rows, which makes it idempotent — it
 * recomputes the union instead of appending to it, so a re-saved batch cannot grow the array
 * with duplicates. Content is untouched, so nothing becomes stale and nothing is re-embedded.
 *
 * Raw SQL because this is one set-based UPDATE over a uuid[] with a correlated subquery;
 * expressing it through the builder would render the array functions by hand anyway.
 */
export async function syncMemoryChunkMentions(
  userId: string,
  interactionIds: string[],
  options: { db?: Awaited<ReturnType<typeof getDb>> } = {}
): Promise<void> {
  const ids = [...new Set(interactionIds)];
  if (!ids.length) return;
  const db = options.db ?? (await getDb());
  await db.execute(sql`
    UPDATE memory_chunks m
       SET contact_ids = (
             SELECT coalesce(array_agg(DISTINCT e), '{}')
               FROM unnest(
                      m.contact_ids || coalesce(
                        (SELECT array_agg(im.contact_id)
                           FROM interaction_mentions im
                          WHERE im.user_id = m.user_id
                            AND im.interaction_id = m.source_id),
                        '{}'::uuid[])
                    ) AS e
           )
     WHERE m.user_id = ${userId}
       AND m.source_kind = 'interaction'
       AND m.source_id = ANY(${sql`ARRAY[${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `
       )}]`})
  `);
}
