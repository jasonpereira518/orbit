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
import { and, eq, inArray, sql } from "drizzle-orm";
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
 * Repoint chunks when two contacts merge.
 *
 * `contact_id` moves by foreign key, but `contact_ids` is an array the database will not
 * rewrite on its own — leave it and a merged-away id stays in the index forever, so the
 * dinner note stops being findable from the surviving contact.
 */
export async function repointMemoryChunks(
  userId: string,
  fromContactId: string,
  toContactId: string,
  options: { db?: Awaited<ReturnType<typeof getDb>> } = {}
): Promise<void> {
  const db = options.db ?? (await getDb());
  await db
    .update(memoryChunks)
    .set({
      contactId: sql`case when ${memoryChunks.contactId} = ${fromContactId}::uuid then ${toContactId}::uuid else ${memoryChunks.contactId} end`,
      contactIds: sql`(
        select coalesce(array_agg(distinct elem), '{}')
        from unnest(array_replace(${memoryChunks.contactIds}, ${fromContactId}::uuid, ${toContactId}::uuid)) as elem
      )`,
    })
    .where(
      and(
        eq(memoryChunks.userId, userId),
        sql`${fromContactId}::uuid = any(${memoryChunks.contactIds}) or ${memoryChunks.contactId} = ${fromContactId}::uuid`
      )
    );
}
