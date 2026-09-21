/**
 * Retrieval over passages of the user's own writing.
 *
 * A separate function from `hybridSearchContacts`, not a fifth arm inside it, for two
 * reasons. The result type is different — a passage, with a date and a snippet and the people
 * it names, not a contact — and folding passages into the contact fusion would move a recall
 * floor that is currently measured and passing, for reasons unrelated to passages.
 *
 * WHAT THIS MAKES POSSIBLE. "What did I discuss about fundraising in March" had no query plan
 * before: `interactions` carried no full-text index and no embeddings outside LinkedIn
 * messages, so a note could only be found by first finding its contact. Here the date is a
 * range predicate and the words are a tsquery, and neither needs a person named in the
 * question.
 *
 * DEGRADATION IS A REAL PATH, NOT A FALLBACK. Accounts on an Anthropic key get no embeddings
 * at all — `resolveAiAccess().embedding()` throws, there is no Anthropic embeddings API — and
 * local PGlite has no pgvector. Both run the lexical arm alone, which is why that arm does
 * the date scoping and the snippets rather than leaning on the vector side for either.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, isPgvectorAvailable, rowsOf } from "@/db";
import { memoryChunks } from "@/db/schema";
import { cosineSimilarity } from "@/lib/ai";
import { RRF_K, SEMANTIC_SIMILARITY_FLOOR } from "@/lib/hybrid-search";
import { formatVectorLiteral } from "@/lib/pgvector";
import { contentTokens } from "@/lib/search-tokens";

export type MemoryArmName = "lexical" | "semantic";

export type RankedMemory = {
  chunkId: string;
  sourceKind: string;
  sourceId: string;
  chunkIndex: number;
  contactId: string | null;
  contactIds: string[];
  occurredAt: Date | null;
  /** The passage, or a `ts_headline` excerpt of it when the lexical arm found it. */
  snippet: string;
  score: number;
  matchedArms: MemoryArmName[];
};

export type MemorySearchOptions = {
  query: string;
  embedding?: number[] | null;
  /** Only passages naming at least one of these people. */
  contactIds?: string[] | null;
  /** Date scoping — this is what answers "in March" without any AI at all. */
  after?: Date | null;
  before?: Date | null;
  limit?: number;
};

const DEFAULT_LIMIT = 8;
/** Per-arm fetch, so fusion has something to fuse before the caller's limit applies. */
const ARM_MULTIPLIER = 4;
/** Ceiling on the JS cosine fallback scan, matching the contact-side fallback's caution. */
const IN_MEMORY_SCAN_LIMIT = 2000;
/** Snippet length when there is no `ts_headline` to lean on. */
const PLAIN_SNIPPET_CHARS = 240;

/** Scoping shared by both arms: tenant, people, dates. */
function scope(userId: string, options: MemorySearchOptions): SQL {
  const parts: SQL[] = [sql`memory_chunks.user_id = ${userId}`];
  const ids = (options.contactIds ?? []).filter(Boolean);
  if (ids.length) {
    parts.push(
      sql`memory_chunks.contact_ids && array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      )}]::uuid[]`
    );
  }
  if (options.after) parts.push(sql`memory_chunks.occurred_at >= ${options.after.toISOString()}`);
  if (options.before) parts.push(sql`memory_chunks.occurred_at <= ${options.before.toISOString()}`);
  return sql.join(parts, sql` and `);
}

/**
 * The words arm.
 *
 * OR-expanded the same way `ftsArm` expands a contact query, with the same token list from
 * `@/lib/search-tokens` — a question that finds a contact by a word must find that word's
 * passage too, or retrieval and grounding disagree about what the question was about.
 */
async function lexicalArm(
  userId: string,
  options: MemorySearchOptions,
  armLimit: number
): Promise<Array<{ id: string; snippet: string }>> {
  const db = await getDb();
  const tokens = contentTokens(options.query);
  // `websearch_to_tsquery` handles the phrase as written; the OR-expansion is what rescues a
  // question whose exact phrasing appears nowhere ("payments infrastructure" vs "payments").
  const tsquery = tokens.length
    ? sql`(websearch_to_tsquery('simple', ${options.query}) || to_tsquery('simple', ${tokens.join(" | ")}))`
    : sql`websearch_to_tsquery('simple', ${options.query})`;

  const result = await db.execute(sql`
    select id,
           ts_headline('simple', content, ${tsquery},
                       'MaxFragments=2, MaxWords=28, MinWords=8, StartSel="", StopSel=""') as snippet
      from memory_chunks
     where ${scope(userId, options)}
       and search_tsv @@ ${tsquery}
     order by ts_rank_cd(search_tsv, ${tsquery}) desc
     limit ${armLimit}
  `);
  return rowsOf<{ id: string; snippet: string }>(result).map((r) => ({
    id: r.id,
    snippet: (r.snippet || "").trim(),
  }));
}

/** The meaning arm. Absent entirely without an embedding — see the file comment. */
async function semanticArm(
  userId: string,
  embedding: number[],
  options: MemorySearchOptions,
  armLimit: number
): Promise<string[]> {
  const db = await getDb();

  if (isPgvectorAvailable()) {
    const literal = formatVectorLiteral(embedding);
    // The ANN scan must be a bare ORDER BY <=> LIMIT in the innermost query or HNSW is
    // unusable. Unlike the contact-side arm there is no dedupe overscan to pay for: a chunk
    // is already the unit being ranked, so one row in is one result out.
    const result = await db.execute(sql`
      select id from (
        select id, embedding_vector <=> ${literal}::vector as distance
          from memory_chunks
         where ${scope(userId, options)}
           and embedding_vector is not null
         order by embedding_vector <=> ${literal}::vector
         limit ${armLimit}
      ) nearest
      where 1 - distance > ${SEMANTIC_SIMILARITY_FLOOR}
      order by distance asc
    `);
    return rowsOf<{ id: string }>(result).map((r) => r.id);
  }

  // No pgvector: cosine in JS over a bounded scan. The scope predicate above usually makes
  // this far smaller than the contact-side equivalent, because a date or a person narrows it
  // before the cap applies.
  const rows = rowsOf<{ id: string; embedding: number[] | null }>(
    await db.execute(sql`
      select id, embedding from memory_chunks
       where ${scope(userId, options)} and embedding is not null
       limit ${IN_MEMORY_SCAN_LIMIT}
    `)
  );
  if (rows.length === IN_MEMORY_SCAN_LIMIT) {
    console.warn(
      `[memory-search] in-memory vector fallback hit its ${IN_MEMORY_SCAN_LIMIT}-row cap; semantic passages are partial.`
    );
  }
  return rows
    .map((row) => ({
      id: row.id,
      sim: row.embedding ? cosineSimilarity(embedding, row.embedding) : 0,
    }))
    .filter((r) => r.sim > SEMANTIC_SIMILARITY_FLOOR)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, armLimit)
    .map((r) => r.id);
}

/** Passages of the user's own writing, most relevant first. */
export async function searchMemories(
  userId: string,
  options: MemorySearchOptions
): Promise<RankedMemory[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!options.query.trim()) return [];
  const armLimit = Math.max(limit * ARM_MULTIPLIER, 20);

  const [lexical, semantic] = await Promise.all([
    lexicalArm(userId, options, armLimit).catch(() => []),
    options.embedding
      ? semanticArm(userId, options.embedding, options, armLimit).catch(() => [])
      : Promise.resolve<string[]>([]),
  ]);

  // The same unweighted RRF as the contact side, with the same constant, imported rather
  // than copied — see `RRF_K` in `@/lib/hybrid-search`.
  const fused = new Map<string, { score: number; arms: MemoryArmName[] }>();
  const add = (ids: string[], arm: MemoryArmName) => {
    ids.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, arms: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.arms.push(arm);
      fused.set(id, entry);
    });
  };
  add(lexical.map((l) => l.id), "lexical");
  add(semantic, "semantic");
  if (!fused.size) return [];

  const headlines = new Map(lexical.map((l) => [l.id, l.snippet]));
  const top = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  const db = await getDb();
  const rows = await db.query.memoryChunks.findMany({
    where: and(
      eq(memoryChunks.userId, userId),
      sql`${memoryChunks.id} in (${sql.join(top.map(([id]) => sql`${id}::uuid`), sql`, `)})`
    ),
    columns: {
      id: true,
      sourceKind: true,
      sourceId: true,
      chunkIndex: true,
      contactId: true,
      contactIds: true,
      occurredAt: true,
      content: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Ordered by the fusion, not by the hydration query — an `in (...)` returns whatever order
  // the planner likes, and silently losing the ranking is the kind of bug that shows up as
  // "retrieval got worse" months later.
  return top.flatMap(([id, entry]) => {
    const row = byId.get(id);
    if (!row) return [];
    const headline = headlines.get(id);
    return [
      {
        chunkId: row.id,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        chunkIndex: row.chunkIndex,
        contactId: row.contactId,
        contactIds: row.contactIds ?? [],
        occurredAt: row.occurredAt,
        snippet: headline || row.content.slice(0, PLAIN_SNIPPET_CHARS),
        score: entry.score,
        matchedArms: entry.arms,
      },
    ];
  });
}
