import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  isPgvectorAvailable,
  isTrigramAvailable,
  rowsOf,
} from "@/db";
import { contacts, contactEmbeddings } from "@/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";
import { formatVectorLiteral } from "@/lib/pgvector";
import { cosineSimilarity } from "@/lib/ai";

export type SearchFilters = {
  companies?: string[];
  industries?: string[];
  schools?: string[];
  locations?: string[];
  tags?: string[];
  closenessTiers?: Array<"inner" | "mid" | "outer">;
};

export type HybridSearchOptions = {
  query: string;
  embedding?: number[] | null;
  filters?: SearchFilters | null;
  expansionTerms?: string[];
  limit?: number;
};

/**
 * One retrieval arm. `experience` reads `contact_experiences` — the only arm that can
 * produce a contact whose match lives in her history rather than on her contact row.
 */
export type ArmName = "fts" | "trigram" | "semantic" | "experience";

export type RankedContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  school: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  industry: string | null;
  notes: string | null;
  aiSummary: string | null;
  keyFacts: string[];
  relationshipScore: number;
  priorityLevel: number;
  closenessTier: string | null;
  tags: string[];
  rrfScore: number;
  relevance: number;
  matchedArms: ArmName[];
  /**
   * True for every row produced by a run whose filters this row satisfied
   * (including all rows when no filters were given at all). False only for
   * recall-guard backfill rows — hits pulled in from the unfiltered fallback
   * because the real filter was too narrow to fill a page on its own.
   */
  filterMatched: boolean;
};

/** Standard RRF constant: dampens the gap between adjacent ranks. */
const RRF_K = 60;
/** Below this cosine similarity a semantic hit is noise (matches pgvectorSearchContacts). */
const SEMANTIC_SIMILARITY_FLOOR = 0.25;
/** ANN over-fetch multiplier: several embedding rows collapse into one contact. */
const OVERSCAN_FOR_DEDUPE = 4;
/** Ceiling on the JS cosine fallback scan (1,536 floats per row). */
const IN_MEMORY_EMBEDDING_SCAN_LIMIT = 2000;
/** A filtered result set smaller than limit/4 triggers the unfiltered recall guard. */
const RECALL_GUARD_DIVISOR = 4;

type ArmResult = { arm: ArmName; ids: string[] };

/**
 * Escapes LIKE metacharacters (`\`, `%`, `_`) in a value that is about to be
 * embedded inside a `%...%` pattern, so a literal underscore or percent sign
 * in user input (e.g. a company name like "A_B Corp") is matched literally
 * instead of acting as a single-character or any-length wildcard. Postgres's
 * default LIKE escape character is backslash, so no explicit ESCAPE clause
 * is needed.
 */
function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function anyLike(column: SQL, values: string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${column} like ${`%${escapeLikeValue(v.toLowerCase())}%`}`),
    sql` or `
  )})`;
}

/**
 * Match a stored LinkedIn experience. Companion to `experienceArm` — the arm finds these
 * contacts, this keeps a filter from throwing them away again.
 *
 * An `exists` subquery rather than a term in `search_tsv`: that column is GENERATED, and a
 * generated column may only read its own row. Mirrors the tag subquery below.
 *
 * `userId` is passed in as a BOUND LITERAL and is not decoration — it is the only thing
 * keeping this subquery tenant-scoped. Correlating on `ce.user_id = contacts.user_id`
 * alone reads as scoped but is not: once the table is ANALYZEd, Postgres rewrites the
 * correlated EXISTS into a hashed SubPlan and evaluates it ONCE with no user predicate at
 * all, seq-scanning every tenant's rows and applying the correlation afterwards against
 * the hash. Measured at 60k rows across 120 tenants: 60,000 rows scanned without the
 * literal, 500 with it (and the plan flips to a bitmap index scan on
 * `contact_experiences_org_idx`). The cost otherwise scales with total system-wide rows
 * rather than the querying user's — and because the rewrite only appears after ANALYZE, a
 * small local database never shows it and production always does.
 *
 * The correlation is kept alongside the literal: belt and braces, and it stays correct if
 * a caller ever passes a userId that disagrees with the row.
 */
function experienceExists(userId: string, values: string[], kinds: readonly string[]): SQL {
  return sql`exists (
    select 1 from contact_experiences ce
    where ce.contact_id = contacts.id
      and ce.user_id = ${userId}
      and ce.user_id = contacts.user_id
      and ce.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
      and (${sql.join(
        values.map(
          (v) =>
            sql`ce.organization_normalized like ${`%${escapeLikeValue(v.toLowerCase())}%`}`
        ),
        sql` or `
      )})
  )`;
}

/**
 * WHERE fragment over the contacts table; null when no filters are set.
 *
 * Takes `userId` solely so `experienceExists` can bind it as a literal — see the note
 * there. Every arm already constrains `contacts.user_id`, so this adds no new scoping to
 * the outer query.
 */
function filterCondition(
  userId: string,
  filters: SearchFilters | null | undefined
): SQL | null {
  if (!filters) return null;
  const parts: SQL[] = [];
  const clean = (xs?: string[]) =>
    (xs ?? []).map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 4);

  const companies = clean(filters.companies);
  if (companies.length) {
    parts.push(
      sql`(${anyLike(sql`lower(coalesce(contacts.company, ''))`, companies)} or ${experienceExists(
        userId,
        companies,
        ["role"]
      )})`
    );
  }
  const industries = clean(filters.industries);
  if (industries.length) parts.push(anyLike(sql`lower(coalesce(contacts.industry, ''))`, industries));
  const schools = clean(filters.schools);
  if (schools.length) {
    parts.push(
      sql`(${anyLike(sql`lower(coalesce(contacts.school, ''))`, schools)} or ${experienceExists(
        userId,
        schools,
        ["education"]
      )})`
    );
  }
  const locations = clean(filters.locations);
  if (locations.length) parts.push(anyLike(sql`lower(coalesce(contacts.location, ''))`, locations));

  const tagNames = clean(filters.tags);
  if (tagNames.length) {
    parts.push(sql`exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = contacts.id
        and (${sql.join(
          tagNames.map((t) => sql`lower(t.name) like ${`%${escapeLikeValue(t.toLowerCase())}%`}`),
          sql` or `
        )})
    )`);
  }

  const tiers = (filters.closenessTiers ?? []).filter((t) =>
    ["inner", "mid", "outer"].includes(t)
  );
  if (tiers.length) {
    parts.push(sql`contacts.closeness_tier in (${sql.join(tiers.map((t) => sql`${t}`), sql`, `)})`);
  }

  if (!parts.length) return null;
  return sql`(${sql.join(parts, sql` and `)})`;
}

const FTS_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from",
  "who", "whom", "whose", "what", "which", "where", "when", "why", "how",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "i", "me", "my", "we", "our", "you", "your", "they", "them", "their", "it", "its",
  "know", "knows", "anyone", "someone", "somebody", "people", "person", "contact", "contacts",
  "can", "could", "would", "should", "have", "has", "had", "that", "this", "these", "those",
]);

/** Content-bearing tokens from a natural-language query, for OR-expansion. */
function contentTokens(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !FTS_STOPWORDS.has(t))
  )].slice(0, 8);
}

async function ftsArm(
  userId: string,
  query: string,
  expansionTerms: string[],
  filter: SQL | null,
  armLimit: number
): Promise<string[]> {
  const db = await getDb();
  // websearch_to_tsquery understands OR; expansion terms widen recall without
  // touching precision (RRF ranks the primary-term matches higher anyway).
  //
  // websearch_to_tsquery ANDs every word within a single alternative, and the
  // generated search_tsv column intentionally uses the 'simple' config (see
  // SCALE_DDL) so names/companies aren't stemmed — but 'simple' also carries no
  // stopword dictionary. A full-sentence question ("who do I know at Stripe?")
  // therefore requires the row to contain "who", "do", "i", "know" and "at" as
  // literal lexemes, which it almost never does, so the raw-query alternative is
  // effectively dead for anything but a name typed verbatim. For queries with 3+
  // tokens, OR in each individual content-bearing token (stopwords stripped) as
  // its own alternative so the query becomes lexically reachable again; ts_rank_cd
  // still ranks the fuller (raw-query) match higher when it does hit, and RRF
  // fusion bounds how much noise the loosened single-token alternatives can add.
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const extraTerms = tokens.length >= 3 ? contentTokens(query) : [];
  const tsQuery = [query, ...expansionTerms.slice(0, 4), ...extraTerms]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" OR ");
  if (!tsQuery) return [];
  const result = await db.execute(sql`
    select contacts.id
    from contacts
    where contacts.user_id = ${userId}
      and contacts.search_tsv @@ websearch_to_tsquery('simple', ${tsQuery})
      ${filter ? sql`and ${filter}` : sql``}
    order by ts_rank_cd(contacts.search_tsv, websearch_to_tsquery('simple', ${tsQuery})) desc
    limit ${armLimit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/**
 * Fuzzy arm: spec mandates trigram similarity PLUS prefix LIKE. Prefix-LIKE
 * runs for any non-empty query (served by the lower() trigram GIN index, or a
 * plain seq scan bounded by user_id + armLimit when the extension is absent)
 * so the ask-bar's per-keystroke typing ("ad", "ada") gets partial-word
 * matches immediately. Trigram similarity only kicks in at 3+ chars (below
 * that, similarity scores are too noisy to be useful) and only when the
 * extension is installed; it exists to catch typos that prefix matching can't
 * ("Ada Lovelase").
 */
async function trigramArm(
  userId: string,
  query: string,
  filter: SQL | null,
  armLimit: number
): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const trigramActive = q.length >= 3 && isTrigramAvailable();
  const prefixPattern = `${escapeLikeValue(q)}%`;
  const db = await getDb();
  const predicate = trigramActive
    ? sql`(lower(contacts.full_name) like ${prefixPattern}
        or lower(coalesce(contacts.company, '')) like ${prefixPattern}
        or lower(contacts.full_name) % ${q}
        or lower(coalesce(contacts.company, '')) % ${q})`
    : sql`(lower(contacts.full_name) like ${prefixPattern}
        or lower(coalesce(contacts.company, '')) like ${prefixPattern})`;
  const orderBy = trigramActive
    ? sql`greatest(
        similarity(lower(contacts.full_name), ${q}),
        similarity(lower(coalesce(contacts.company, '')), ${q})
      ) desc, lower(contacts.full_name) asc`
    : sql`lower(contacts.full_name) asc`;
  const result = await db.execute(sql`
    select contacts.id
    from contacts
    where contacts.user_id = ${userId}
      and ${predicate}
      ${filter ? sql`and ${filter}` : sql``}
    order by ${orderBy}
    limit ${armLimit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/**
 * Candidates whose stored LinkedIn history names the query.
 *
 * This is an ARM, not a filter, and the distinction is the whole point. `filterCondition`
 * narrows what the other arms already found; a contact who left Google in 2019 has no
 * "google" in `search_tsv`, in her name, or in `contacts.company`, so no filter can reach
 * her. Only a query that reads `contact_experiences` can put her in the candidate set.
 *
 * Terms are matched against `organization_normalized` (see `normalizeCompanyKey`), which is
 * lowercased and stripped of punctuation to single spaces — so "Google, LLC" is stored as
 * `google llc` and the term `google` reaches it by prefix. Query terms go through the SAME
 * function before they are compared, which is why it was hoisted into `@/lib/company-name`
 * in the first place: lowercasing alone left `AT&T` looking for `at&t` in a column that
 * stores `at t`, so the punctuated employers this arm exists to find — AT&T, L'Oréal,
 * Ernst & Young, Procter & Gamble — were reachable only by typing the mangled form.
 *
 * Matching is word-anchored in four tiers (whole value / first word / interior word / last
 * word), scored exact 3 > prefix 2 > word-boundary 1. There is deliberately no `%term%`
 * tier: an unanchored substring made the term "art" match "startup ventures", and eight
 * unrelated contacts flooded positions 2-9 of every "art" search, displacing real lexical
 * hits. Note the prefix tier is a prefix of the *value*, not of a word, so "meta" still
 * reaches "metabase" at the same tier as "meta platforms inc"; only a value stored exactly
 * as "meta" outranks it.
 *
 * Indexing, measured with EXPLAIN against 60k experience rows across 120 tenants rather
 * than assumed — `contact_experiences_org_idx` is `(user_id, organization_normalized)`:
 *   - This query uses it for its LEADING COLUMN ONLY. The plan is a bitmap index scan with
 *     `Index Cond: (user_id = ...)`, which scopes 60k rows down to the tenant's 500, and
 *     all four patterns are then applied as a post-index `Filter`.
 *   - Each of the exact and prefix tiers *is* independently index-servable (in isolation
 *     the planner emits a BitmapOr of two index scans on the second column). OR-ing them
 *     with the two word-boundary patterns, which have leading wildcards and cannot be
 *     indexed, is what collapses the whole disjunction to a filter.
 *   - The prefix tier's range rewrite (`>= 'google' AND < 'googlf'`) additionally requires
 *     a C-collation database. Verified both ways on one table: a C-collation column uses
 *     the index for `like 'google%'`, an `en_US.utf8` column seq-scans it. Local PGlite is
 *     C; a managed Postgres usually is not, so on Neon even the isolated prefix tier would
 *     need a `text_pattern_ops` index. Equality is collation-independent either way.
 * Tenant scoping is therefore the only indexing this arm can currently rely on. That is
 * bounded and fine at present sizes; `gin_trgm_ops` on `organization_normalized` is the
 * fix if it ever stops being.
 */
/**
 * Legal-entity suffixes, which every company ending in one shares. As a whole search term
 * such a word carries no signal — "inc" matched every "… Inc" in the table through the
 * arm's word-boundary tier, which is precise but not selective.
 *
 * Applied per TERM, not per query: "Acme Inc" still searches `acme`, and only the bare
 * `inc` component is dropped. A query that is nothing BUT a legal suffix therefore yields
 * no terms and no candidates, which is the correct answer.
 *
 * Deliberately NOT folded into `normalizeCompanyKey`: `organization_normalized` is already
 * written for every stored row by `saveContactProfile`, so changing normalization would
 * require re-normalizing the table. This is a query-time concern only.
 */
const LEGAL_SUFFIXES = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "gmbh", "plc",
  "sa", "ag", "bv", "nv", "pty", "llp",
]);

async function experienceArm(
  userId: string,
  query: string,
  expansionTerms: string[],
  filter: SQL | null,
  armLimit: number
): Promise<string[]> {
  // Single-word queries are used whole; longer ones contribute their content tokens, the
  // same widening `ftsArm` does and for the same reason — "who did I meet from Google"
  // must reach `google`.
  const raw = query.trim().toLowerCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const terms = [
    ...(raw ? [raw] : []),
    ...(tokens.length >= 2 ? contentTokens(query).map((t) => t.toLowerCase()) : []),
    ...expansionTerms.slice(0, 4).map((t) => t.trim().toLowerCase()),
  ]
    // Normalize BEFORE the filters below, not after: `normalizeCompanyKey` is what turns
    // "AT&T" into the stored `at t`, and both the length floor and the stoplist have to
    // judge the string that will actually be compared. (It can also empty a term out
    // entirely — "&" normalizes to "" — which the length floor then drops.)
    .map((t) => normalizeCompanyKey(t))
    // Two characters is the floor because the tiers below are word-anchored: "ge" can
    // only match the whole value, a whole first word, or a whole interior word, never
    // the "ge" inside "Regeneron". A single character is still too little to mean
    // anything, and "3M"/"GE"/"HP"/"BP" are real employers.
    .filter((t) => t.length >= 2)
    .filter((t) => !LEGAL_SUFFIXES.has(t));
  const unique = [...new Set(terms)].slice(0, 6);
  if (!unique.length) return [];

  const db = await getDb();
  // Word-anchored tiers, never a bare `%term%`. An unanchored substring made "art"
  // match "startup ventures" and flood the fused ranking with unrelated contacts,
  // displacing real lexical hits — the tiers below can only match whole words.
  //
  // `organization_normalized` is punctuation-stripped to single spaces, so word
  // boundaries are exactly spaces and these four patterns are total: the value itself,
  // its first word, an interior word, its last word.
  const tiers = (t: string) => {
    const e = escapeLikeValue(t);
    return {
      // Not escaped: `=` is not a pattern match, so `%` and `_` are already literal.
      exact: sql`ce.organization_normalized = ${t}`,
      prefix: sql`ce.organization_normalized like ${`${e}%`}`,
      interior: sql`ce.organization_normalized like ${`% ${e} %`}`,
      suffix: sql`ce.organization_normalized like ${`% ${e}`}`,
    };
  };
  const matches = sql.join(
    unique.map((t) => {
      const { exact, prefix, interior, suffix } = tiers(t);
      return sql`(${exact} or ${prefix} or ${interior} or ${suffix})`;
    }),
    sql` or `
  );
  const score = sql.join(
    unique.map((t) => {
      const { exact, prefix, interior, suffix } = tiers(t);
      return sql`case
        when ${exact} then 3
        when ${prefix} then 2
        when ${interior} or ${suffix} then 1
        else 0 end`;
    }),
    sql` + `
  );

  const result = await db.execute(sql`
    select
      contacts.id,
      max(${score}) as match_score,
      bool_or(ce.is_current) as any_current,
      max(ce.end_year) as latest_end
    from contacts
    join contact_experiences ce
      on ce.contact_id = contacts.id and ce.user_id = contacts.user_id
    where contacts.user_id = ${userId}
      and (${matches})
      ${filter ? sql`and ${filter}` : sql``}
    group by contacts.id
    -- RRF reads only the ordinal, so this ordering IS the arm's ranking contribution.
    -- After match quality, prefer the person who still works there, then the most
    -- recent departure (a null end_year is ongoing or unknown, so it sorts first).
    -- contacts.id is the final tiebreak only, for a stable page — never a signal.
    order by match_score desc, any_current desc, latest_end desc nulls first, contacts.id
    limit ${armLimit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => String(r.id));
}

async function semanticArm(
  userId: string,
  embedding: number[],
  armLimit: number
): Promise<string[]> {
  const db = await getDb();

  if (isPgvectorAvailable()) {
    const literal = formatVectorLiteral(embedding);
    const scanLimit = Math.max(armLimit * OVERSCAN_FOR_DEDUPE, 50);
    // ANN scan must be a bare ORDER BY <=> LIMIT in the innermost query or the
    // HNSW index is unusable (see pgvectorSearchContacts in src/lib/search.ts).
    // Contact-level filters are NOT applied here — an ANN scan cannot filter on
    // the contacts table; filtering happens at hydration.
    const result = await db.execute(sql`
      select contact_id
      from (
        select contact_id, min(distance) as best
        from (
          select contact_id, embedding_vector <=> ${literal}::vector as distance
          from contact_embeddings
          where user_id = ${userId}
            and embedding_vector is not null
          order by embedding_vector <=> ${literal}::vector
          limit ${scanLimit}
        ) nearest
        group by contact_id
        having 1 - min(distance) > ${SEMANTIC_SIMILARITY_FLOOR}
      ) ranked
      order by best asc
      limit ${armLimit}
    `);
    return rowsOf<{ contact_id: string }>(result).map((r) => r.contact_id);
  }

  // Bounded JS fallback: project only what cosine needs, hard row cap.
  const rows = await db.query.contactEmbeddings.findMany({
    where: eq(contactEmbeddings.userId, userId),
    columns: { contactId: true, embedding: true },
    limit: IN_MEMORY_EMBEDDING_SCAN_LIMIT,
  });
  if (rows.length === IN_MEMORY_EMBEDDING_SCAN_LIMIT) {
    console.warn(
      `[hybrid-search] in-memory vector fallback hit its ${IN_MEMORY_EMBEDDING_SCAN_LIMIT}-row cap; semantic results are partial.`
    );
  }
  const best = new Map<string, number>();
  for (const row of rows) {
    const sim = cosineSimilarity(embedding, row.embedding);
    if (sim > (best.get(row.contactId) ?? 0)) best.set(row.contactId, sim);
  }
  return [...best.entries()]
    .filter(([, sim]) => sim > SEMANTIC_SIMILARITY_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, armLimit)
    .map(([contactId]) => contactId);
}

/**
 * Reciprocal-rank fusion. Every arm contributes at the same weight — there is no
 * per-arm coefficient here, and `experience` deliberately does not introduce one: a
 * stored employer is an exact recorded fact, so it belongs at `fts` parity, which in an
 * unweighted table means simply joining it. Rank position inside each arm (its own
 * exact > prefix > substring ordering, for `experience`) is what separates the hits.
 */
function fuse(results: ArmResult[]): Map<string, { score: number; arms: ArmName[] }> {
  const fused = new Map<string, { score: number; arms: ArmName[] }>();
  for (const { arm, ids } of results) {
    ids.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, arms: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.arms.push(arm);
      fused.set(id, entry);
    });
  }
  return fused;
}

async function runArms(
  userId: string,
  options: HybridSearchOptions,
  filter: SQL | null,
  armLimit: number
): Promise<ArmResult[]> {
  const [fts, trgm, vec, exp] = await Promise.all([
    ftsArm(userId, options.query, options.expansionTerms ?? [], filter, armLimit),
    trigramArm(userId, options.query, filter, armLimit),
    options.embedding?.length
      ? semanticArm(userId, options.embedding, armLimit)
      : Promise.resolve([]),
    experienceArm(userId, options.query, options.expansionTerms ?? [], filter, armLimit),
  ]);
  return [
    { arm: "fts" as const, ids: fts },
    { arm: "trigram" as const, ids: trgm },
    { arm: "semantic" as const, ids: vec },
    { arm: "experience" as const, ids: exp },
  ];
}

export async function hybridSearchContacts(
  userId: string,
  options: HybridSearchOptions
): Promise<RankedContact[]> {
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 80);
  const armLimit = Math.max(limit * 2, 40);
  const filter = filterCondition(userId, options.filters);

  const fused = fuse(await runArms(userId, options, filter, armLimit));
  // The semantic arm is unfiltered (ANN can't see contact columns), so the
  // filter is re-applied at hydration; over-fetch so post-filter still fills a
  // page. Always over-fetch, filtered or not — the recall guard below also
  // needs more candidates than a single page to backfill from.
  const orderedIds = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit * 2)
    .map(([id]) => id);

  let hydrated = await hydrate(userId, orderedIds, fused, filter);
  hydrated = hydrated.slice(0, limit);

  const normalizeToOwnMax = (rows: RankedContact[]): RankedContact[] => {
    const max = rows.reduce((m, h) => Math.max(m, h.rrfScore), 0);
    return rows.map((h) => ({ ...h, relevance: max > 0 ? h.rrfScore / max : 0 }));
  };

  let results = normalizeToOwnMax(hydrated);

  // Recall guard: an over-narrow filter should widen, not starve. Filtered
  // hits stay first (spec-mandated order); backfill is appended after them,
  // each segment normalized against its own max so the merged array stays
  // monotonic non-increasing in relevance rather than jumbling two unrelated
  // scales together.
  if (filter && results.length < Math.ceil(limit / RECALL_GUARD_DIVISOR)) {
    const unfiltered = await hybridSearchContacts(userId, {
      ...options,
      filters: null,
    });
    const seen = new Set(results.map((h) => h.id));
    const backfillRaw = unfiltered
      .filter((h) => !seen.has(h.id))
      .slice(0, limit - results.length);

    if (backfillRaw.length > 0) {
      const backfillNormalized = normalizeToOwnMax(backfillRaw);
      const minFilteredRelevance = results.length
        ? Math.min(...results.map((h) => h.relevance))
        : 0;
      // No filtered rows at all: backfill just normalizes to (0,1] directly.
      // Otherwise scale it to sit strictly below the lowest filtered relevance.
      const scale = results.length > 0 ? minFilteredRelevance * 0.9 : 1;
      const backfillSegment = backfillNormalized.map((h) => ({
        ...h,
        relevance: h.relevance * scale,
        filterMatched: false,
      }));
      results = [...results, ...backfillSegment];
    }
  }

  return results.slice(0, limit);
}

async function hydrate(
  userId: string,
  orderedIds: string[],
  fused: Map<string, { score: number; arms: ArmName[] }>,
  filter: SQL | null
): Promise<RankedContact[]> {
  if (orderedIds.length === 0) return [];
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: filter
      ? and(eq(contacts.userId, userId), inArray(contacts.id, orderedIds), filter)
      : and(eq(contacts.userId, userId), inArray(contacts.id, orderedIds)),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      company: true,
      school: true,
      title: true,
      location: true,
      email: true,
      industry: true,
      notes: true,
      aiSummary: true,
      keyFacts: true,
      relationshipScore: true,
      priorityLevel: true,
      closenessTier: true,
    },
    with: { contactTags: { with: { tag: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: RankedContact[] = [];
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (!row) continue; // filtered out at hydration, or deleted between arm and hydrate
    const entry = fused.get(id)!;
    out.push({
      id: row.id,
      fullName: row.fullName,
      preferredName: row.preferredName,
      company: row.company,
      school: row.school,
      title: row.title,
      location: row.location,
      email: row.email,
      industry: row.industry,
      notes: row.notes,
      aiSummary: row.aiSummary,
      keyFacts: row.keyFacts ?? [],
      relationshipScore: row.relationshipScore ?? 0,
      priorityLevel: row.priorityLevel ?? 0,
      closenessTier: row.closenessTier,
      tags: row.contactTags?.map((ct) => ct.tag.name) ?? [],
      rrfScore: entry.score,
      relevance: 0, // normalized by caller
      matchedArms: entry.arms,
      // The WHERE clause above already enforces `filter` when one is given (and is
      // vacuously satisfied when it isn't), so every row hydrate() returns satisfied
      // whatever filter this call ran with. The caller is responsible for marking
      // recall-guard backfill rows false when it merges them in from elsewhere.
      filterMatched: true,
    });
  }
  return out;
}
