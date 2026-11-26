/**
 * The paginated contacts list query — server-only.
 *
 * Split out of `contacts-page.ts` (which holds this feature's types and constants) because
 * that file is imported by a client component (`ContactsList`, for `CONTACTS_PAGE_SIZE`):
 * a real `@/db` import living in the same module would ride along into the browser bundle
 * and fail the build with an unhelpful `node:fs` chunk error. Nothing client-side may import
 * this file.
 *
 * `listContactsPage` takes `userId` explicitly rather than calling `requireUserId()` itself,
 * so it is unit-testable outside a request — see `scripts/smoke-import-undo.ts`'s import
 * filter case. `src/actions/contacts.ts`'s own `listContactsPage` action is a thin
 * `requireUserId()` wrapper around it.
 */

import { and, eq, inArray, not, or, sql, type SQL } from "drizzle-orm";
import { nonPersonContactSql } from "@/lib/non-person-participant";
import { getDb, rowsOf } from "@/db";
import { contacts } from "@/db/schema";
import { contactSearchCondition, nameMatchTierSql } from "@/lib/contact-search-rank";
import { ENRICHMENT_EMBED_TIMEOUT_MS, rankContactsCached } from "@/lib/contact-ranking";
import { importIdsFrom } from "@/lib/imports/import-ids";
import {
  contactsCursorCondition,
  contactsCursorFor,
  contactsOrderBy,
  decodeContactsCursor,
  encodeContactsCursor,
} from "@/lib/contacts-page-cursor";
import { contactsListSelection } from "@/lib/contact-avatar-sql";
import { openNameGuess } from "@/lib/contact-name-guess";
import { trackSearchPerformed } from "@/lib/search-events";
import { schoolCondition, type RankedContact } from "@/lib/hybrid-search";
import { listSchools } from "@/lib/events/target-companies";
import {
  CONTACTS_PAGE_SIZE,
  parseQuietDays,
  SAME_SCHOOL_AS_ME,
  type ContactListRow,
  type ContactSort,
  type ContactsPage,
  type ContactsPageFilters,
  type ContactsSearchEnrichment,
} from "@/lib/contacts-page";

/**
 * The row's tag names, read in the same statement as the page. They used to be a second query
 * on the page's ids — a whole extra round trip between the rows and the first paint. A
 * correlated subquery is only evaluated for rows that survive the LIMIT (the planner postpones
 * expensive target-list expressions past the sort), so it costs ~50 primary-key lookups.
 * Written against `contacts.id` literally: drizzle renders a column inside a select-list
 * `sql` fragment unqualified, which a correlated subquery would read as the inner table's.
 */
const tagNamesSql = sql<string[] | string>`coalesce((
  select jsonb_agg(t.name order by t.name)
  from contact_tags ct join tags t on t.id = ct.tag_id
  where ct.contact_id = contacts.id
), '[]'::jsonb)`;

function tagNamesOf(row: { tagNames: string[] | string | null }): string[] {
  const v = row.tagNames;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

type RankFn = (
  userId: string,
  query: string,
  limit: number,
  options?: { embedTimeoutMs?: number }
) => Promise<RankedContact[]>;

export type ListContactsPageOptions = {
  /**
   * `"full"` (default): the one-shot search — literal matches, widened by work-history and
   * meaning matches, ranked, with the exact total. `"lexical"`: the first page of a search
   * answered from the literal matches alone, so it can paint at once; the rest comes from
   * `enrichContactsSearch`, and applying that gives the `"full"` page exactly. Only a first
   * page of 3+ characters differs; shorter queries and cursor pages are the same either way.
   */
  search?: "full" | "lexical";
  /** Test seam: the ranker (default: the cached hybrid search). */
  rank?: RankFn;
};

/** Everything a page needs that does not depend on the ranking. */
async function prepare(userId: string, filters?: ContactsPageFilters) {
  const sort: ContactSort = filters?.sort ?? "name";
  const limit = Math.min(Math.max(filters?.limit ?? CONTACTS_PAGE_SIZE, 1), 200);
  const q = filters?.q?.trim();
  // "relevance" has no stable keyset — see `contactsOrderBy` — so it never accepts a cursor and
  // always returns its first (only) page.
  const cursor = sort === "relevance" ? null : decodeContactsCursor(filters?.cursor, sort, Boolean(q));

  // Group calendars and rooms an older calendar sync saved as contacts stay out of the list.
  const base = [eq(contacts.userId, userId), not(nonPersonContactSql())];

  // Name matches first in every sort while searching; see `contacts-page-cursor.ts`.
  const tier = q ? nameMatchTierSql(q) : null;

  const company = filters?.company?.trim();
  if (company) {
    // Matches `contacts_company_idx`, which existed all along and was never used because
    // this filter ran in JavaScript.
    base.push(sql`lower(trim(${contacts.company})) = ${company.toLowerCase()}`);
  }

  if (filters?.minScore) {
    base.push(sql`${contacts.relationshipScore} >= ${filters.minScore}`);
  }

  // Tags had a write path, a search index and no read surface at all: you could set them,
  // find them via free-text search, and never see them again. This is the read surface —
  // `?tag=` narrows the list. Rows do not draw their tags; `ContactListRow.tags` is carried
  // for callers that do.
  const tag = filters?.tag?.trim();
  if (tag) {
    base.push(sql`exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = ${contacts.id}
        and t.user_id = ${userId}
        and lower(trim(t.name)) = ${tag.toLowerCase()}
    )`);
  }

  const school = filters?.school?.trim();
  if (school) {
    const schools = school === SAME_SCHOOL_AS_ME ? await listSchools(userId) : [school];
    // No schools of your own means nobody shares one — not "the filter is off".
    base.push(schools.length ? schoolCondition(userId, schools) : sql`false`);
  }

  // "Gone quiet": nothing logged for at least this many days. A contact with no interaction
  // at all qualifies — `last_interaction_at` is stamped at create, so NULL here means the
  // column predates that or an import left it empty, and either way "never" is quieter than
  // any threshold. Inlined rather than bound because an interval built from a parameter is
  // awkward in Postgres; `parseQuietDays` has already reduced it to one of three integers,
  // so there is no user string anywhere near this.
  const quiet = parseQuietDays(filters?.quiet);
  if (quiet !== null) {
    base.push(
      sql`(${contacts.lastInteractionAt} is null or ${contacts.lastInteractionAt} <= now() - ${sql.raw(
        `interval '${quiet} days'`
      )})`
    );
  }

  if (filters?.followUp === "due") {
    base.push(
      sql`${contacts.nextFollowUpAt} is not null and ${contacts.nextFollowUpAt} <= now()`
    );
  }

  // One id, or the comma-separated list the done card sends. It no longer narrows the list —
  // "Meet your 19 new people" opens everyone, with those 19 marked (`fromImport`) — so it is
  // only read after the page is fetched. Non-uuids are dropped rather than sent:
  // `import_job_rows.import_id` is a uuid column, so a hand-typed id would fail the cast and
  // turn the whole page into a 500. With no usable id, nobody is marked.
  const importIds = importIdsFrom((filters?.importId ?? "").split(","));

  // The A–Z rail is a seek, not a scroll. Asking for "S" starts the page at the first
  // contact sorting there rather than loading everyone up to it — which is the whole reason
  // the rail survives pagination at all.
  const letter = filters?.letter?.trim();
  if (letter && sort === "name") {
    base.push(
      letter === "#"
        ? sql`(${contacts.sortKey} is null or ${contacts.sortKey} < 'a')`
        : sql`${contacts.sortKey} >= ${letter.toLowerCase()}`
    );
  }

  return { sort, limit, q, cursor, base, tier, importIds };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

/**
 * One ordered page (plus the one extra row that answers "is there more"). Takes the database
 * handle so the query is issued synchronously: on a single-connection database (local PGlite)
 * the page must be queued ahead of the count that runs beside it, not behind it.
 */
function selectPage(db: Awaited<ReturnType<typeof getDb>>, p: Prepared, where: SQL[], rankedIds: readonly string[]) {
  return db
    .select({ ...contactsListSelection, nameTier: p.tier ?? sql<number>`2`, tagNames: tagNamesSql })
    .from(contacts)
    .where(and(...p.base, ...where))
    .orderBy(...contactsOrderBy(p.sort, p.tier, rankedIds))
    .limit(p.limit + 1);
}

type PageRow = Awaited<ReturnType<typeof selectPage>>[number];

function toListRow(
  row: PageRow,
  addedHere: Set<string>,
  matchReason: string | null
): ContactListRow {
  return {
    id: row.id,
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    preferredName: row.preferredName,
    nameGuess: openNameGuess(row),
    title: row.title,
    company: row.company,
    school: row.school,
    location: row.location,
    linkedinUrl: row.linkedinUrl,
    // Already browser-safe: `clientAvatarUrlSql` resolved this in Postgres.
    profileImageUrl: row.profileImageUrl,
    canResolveAvatar: Boolean(row.canResolveAvatar),
    relationshipScore: row.relationshipScore,
    closeness: (row.closeness ?? 0) / 100,
    closenessTier: row.closenessTier ?? "outer",
    priorityLevel: row.priorityLevel,
    nextFollowUpAt: row.nextFollowUpAt,
    lastInteractionAt: row.lastInteractionAt,
    source: row.source ?? null,
    tags: tagNamesOf(row),
    matchReason,
    fromImport: addedHere.has(row.id),
  };
}

/** The page a query shows, and whether a "load more" follows it. */
function sliceAndCursor(p: Prepared, rows: PageRow[]) {
  const fetchedExtra = rows.length > p.limit;
  const page = fetchedExtra ? rows.slice(0, p.limit) : rows;
  // Relevance has no keyset to resume from, so it never claims there's more — the caller
  // gets one ranked page and the "Showing X of Y" footer if that page is short of `total`.
  const hasMore = p.sort !== "relevance" && fetchedExtra;
  const nextCursor = hasMore
    ? encodeContactsCursor(contactsCursorFor(p.sort, page[page.length - 1], Boolean(p.tier)))
    : null;
  return { page, nextCursor };
}

/**
 * One page of a user's contacts, ordered, filtered and searched in Postgres.
 *
 * Every part of this used to happen in JavaScript over the whole network: the query loaded
 * every contact and every tag, `Array.filter` applied the filters, and `localeCompare`
 * sorted the result — so the cost of viewing 50 people was set by how many people you knew.
 *
 * Paging is keyset, not `OFFSET`. `OFFSET 5000` still walks the 5,000 rows it discards, so
 * scrolling would get slower the further you went; comparing against the last row's
 * ordering tuple starts exactly where the previous page stopped. That requires the ordering
 * to be a total order, which is why every sort ends in `id`.
 *
 * A search has two speeds (`options.search`). The one-shot `"full"` search awaits the hybrid
 * ranking before it can build its WHERE, which is most of why a keystroke took 300 ms+ to
 * settle. The page route asks for `"lexical"` instead, paints those rows, and fetches the
 * rest from `enrichContactsSearch` — same final page, same labels, same exact total.
 */
export async function listContactsPage(
  userId: string,
  filters?: ContactsPageFilters,
  options: ListContactsPageOptions = {}
): Promise<ContactsPage> {
  const p = await prepare(userId, filters);
  const { q, cursor, tier } = p;

  // Lexical-first only where it differs from the one-shot search: a first page of 3+
  // characters (shorter queries never ranked; cursor pages need the ranking to resume).
  const lexicalFirst = options.search === "lexical" && Boolean(q) && q!.length >= 3 && !cursor;

  // Reused below by `contactsOrderBy` (relevance ranking) and by the match-reason map — one
  // hybrid-search call serves widening, ranking, and explaining, instead of asking thrice.
  let ranked: RankedContact[] = [];
  if (q && !lexicalFirst) {
    // Short queries are prefix lookups ("mar" -> Marcus) that `contactSearchCondition` alone
    // already serves well; below this length a semantic round trip only adds latency.
    // At 3+ chars, OR in contacts whose title/company/experience is a semantic match
    // even when no literal keyword overlaps ("Full-time SWE at Google" finding someone
    // whose stored role is "Software Engineer" at Google, full time). Request the max
    // hybridSearchContacts will give (80) rather than its default 12, since this list
    // also drives relevance ordering, not just widening the match.
    // A "load more" page widens by the SAME ranking the first page was enriched with (same
    // cache entry, same embedding wait), so the pages of one search never disagree about who
    // is in it.
    ranked =
      q.length >= 3
        ? await (options.rank ?? rankContactsCached)(userId, q, 80, cursor ? { embedTimeoutMs: ENRICHMENT_EMBED_TIMEOUT_MS } : undefined)
        : [];
  }
  const semanticIds = ranked.map((r) => r.id);
  const matchReasons = matchReasonsFor(ranked);

  const where: SQL[] = [];
  if (q) {
    where.push(
      semanticIds.length
        ? or(contactSearchCondition(q, userId), inArray(contacts.id, semanticIds))!
        : contactSearchCondition(q, userId)
    );
  }
  if (cursor) where.push(contactsCursorCondition(cursor, tier));

  // The total needs only the conditions, so it runs beside the page rather than after it:
  // one round trip less on every first page and every search (LATENCY_PLAN DB-15). A
  // lexical-first page leaves it to the enrichment, which counts it beside the ranking.
  const db = await getDb();
  const rowsP = selectPage(db, p, where, semanticIds);
  const totalP =
    cursor || lexicalFirst ? Promise.resolve(null) : countContacts(and(...p.base, ...where));
  // Still awaited below; this only keeps a failed count from going unhandled when the page
  // query throws first.
  totalP.catch(() => {});
  const rows = await rowsP;
  const { page, nextCursor } = sliceAndCursor(p, rows);

  const [total, addedHere] = await Promise.all([
    totalP,
    addedByImports(userId, p.importIds, page.map((r) => r.id)),
  ]);

  // The first page of a search is the search; "load more" (a cursor) is not another one. A
  // lexical-first page has no exact count yet — the enrichment records it, once, when it has.
  if (q && !cursor && !lexicalFirst) {
    trackSearchPerformed({ userId, surface: "contacts_page", query: q, resultCount: total ?? page.length });
  }

  return {
    items: page.map((row) => toListRow(row, addedHere, matchReasons.get(row.id) ?? null)),
    nextCursor,
    total,
    ...(lexicalFirst ? { searchPending: true } : {}),
  };
}

/**
 * What `listContactsPage(…, { search: "lexical" })` left out, computed while that page is
 * already on screen: the exact total, the final first page (literal matches widened by
 * work-history and meaning matches, ranked), and why each non-obvious match matched.
 * `mergeSearchEnrichment` applies it; the result equals the one-shot `"full"` page.
 *
 * Returns null where there is nothing to add (no search, or a cursor page).
 *
 * Cheaper than running the one-shot search after the fact, in two ways. The literal count
 * runs beside the ranking instead of after it, and the widened total is that count plus the
 * ranked contacts the literal search did not already find — a handful of ids, not another
 * pass over the whole predicate. And only rows the client lacks come back (it sends `have`).
 *
 * `signal` is checked between steps, so a search the person has already typed past stops
 * before its page query and records nothing.
 */
export async function enrichContactsSearch(
  userId: string,
  filters: ContactsPageFilters | undefined,
  options: {
    /** Ids the client already holds (it may still be loading them: awaited only when needed). */
    have?: readonly string[] | Promise<readonly string[]>;
    signal?: AbortSignal;
    rank?: RankFn;
  } = {}
): Promise<ContactsSearchEnrichment | null> {
  const p = await prepare(userId, filters);
  const { q } = p;
  if (!q || p.cursor) return null;
  const { signal } = options;

  const lexical = contactSearchCondition(q, userId);
  const [ranked, lexicalTotal] = await Promise.all([
    q.length >= 3
      ? (options.rank ?? rankContactsCached)(userId, q, 80, { embedTimeoutMs: ENRICHMENT_EMBED_TIMEOUT_MS })
      : Promise.resolve([] as RankedContact[]),
    countContacts(and(...p.base, lexical)),
  ]);
  signal?.throwIfAborted();

  const semanticIds = ranked.map((r) => r.id);
  if (semanticIds.length === 0) {
    // Nothing to widen with or to rank by: the lexical page was already the final one.
    trackSearchPerformed({ userId, surface: "contacts_page", query: q, resultCount: lexicalTotal });
    return { total: lexicalTotal, order: null, rows: [], matchReasons: {}, nextCursor: null };
  }

  const db = await getDb();
  const [rows, extra] = await Promise.all([
    selectPage(db, p, [or(lexical, inArray(contacts.id, semanticIds))!], semanticIds),
    countRankedOnly(p, q, semanticIds),
  ]);
  signal?.throwIfAborted();

  const { page, nextCursor } = sliceAndCursor(p, rows);
  const have = new Set(await (options.have ?? []));
  const fresh = page.filter((r) => !have.has(r.id));
  const addedHere = await addedByImports(userId, p.importIds, fresh.map((r) => r.id));
  signal?.throwIfAborted();

  const reasons = matchReasonsFor(ranked);
  const matchReasons: Record<string, string> = {};
  for (const r of page) {
    const reason = reasons.get(r.id);
    if (reason) matchReasons[r.id] = reason;
  }

  const total = lexicalTotal + extra;
  trackSearchPerformed({ userId, surface: "contacts_page", query: q, resultCount: total });
  return {
    total,
    order: page.map((r) => r.id),
    rows: fresh.map((row) => toListRow(row, addedHere, matchReasons[row.id] ?? null)),
    matchReasons,
    nextCursor,
  };
}

/**
 * `enrichContactsSearch`, where a newer search by the same account supersedes an older one.
 *
 * Every keystroke that settles renders the page again, and each render starts an enrichment.
 * A Server Component has no abort signal of its own, so the supersession is explicit: starting
 * a search for a DIFFERENT query aborts the account's previous enrichment, which then stops
 * at its next step (no page query, no analytics event) and rejects with `AbortError`. The
 * same query started twice (a prefetch, a refresh) is not a supersession: both run, and the
 * ranking cache means the second one is nearly free. Best effort per server instance.
 */
const latestSearch = (globalThis as unknown as { orbitLatestContactSearch?: Map<string, { key: string; ctl: AbortController }> }).orbitLatestContactSearch ??= new Map();

export function enrichLatestContactsSearch(
  userId: string,
  filters: ContactsPageFilters,
  options: { have?: readonly string[] | Promise<readonly string[]>; rank?: RankFn } = {}
): Promise<ContactsSearchEnrichment | null> {
  const key = JSON.stringify([filters.q?.trim().toLowerCase(), filters.sort, filters.company, filters.tag, filters.school, filters.minScore, filters.followUp, filters.quiet, filters.letter, filters.importId]);
  const previous = latestSearch.get(userId);
  if (previous && previous.key !== key) previous.ctl.abort();
  const ctl = new AbortController();
  latestSearch.set(userId, { key, ctl });
  return enrichContactsSearch(userId, filters, { ...options, signal: ctl.signal }).finally(() => {
    if (latestSearch.get(userId)?.ctl === ctl) latestSearch.delete(userId);
  });
}

/**
 * How many of the ranked contacts the literal search does NOT find (and the filters allow):
 * the part the widening adds to the total. Judged per row with the row-wise form of the
 * literal condition — about 80 candidates, so it costs a primary-key lookup each rather than
 * another pass over the whole predicate. `coalesce` because a NULL search vector makes that
 * condition NULL, and `not NULL` would drop a row the widening does add.
 */
async function countRankedOnly(p: Prepared, q: string, rankedIds: readonly string[]): Promise<number> {
  return countContacts(
    and(
      ...p.base,
      inArray(contacts.id, [...rankedIds]),
      sql`not coalesce(${contactSearchCondition(q)}, false)`
    )
  );
}

/**
 * Why a contact showed up, for the ones where that isn't obvious from the row itself.
 *
 * A contact only gets a reason when it matched via the `experience` or `semantic` arm and
 * *neither* `fts` nor `trigram` — i.e. only when nothing already visible on the row (name,
 * company, title) would explain the match. A contact whose company field literally says
 * "Google" doesn't need a label telling the user it matched "Google"; one who matches only
 * because a past role or an unrelated-looking bio was semantically similar does.
 */
function matchReasonsFor(ranked: RankedContact[]): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const r of ranked) {
    if (r.matchedArms.includes("fts") || r.matchedArms.includes("trigram")) continue;
    if (r.matchedArms.includes("experience")) reasons.set(r.id, "Matched via work history");
    else if (r.matchedArms.includes("semantic")) reasons.set(r.id, "Matched by meaning");
  }
  return reasons;
}

/**
 * Which of one page's contacts those imports ADDED — the people the done card's button
 * counted ("Meet your 19 new people"), so they are the ones the list marks.
 *
 * Every done row carries a contact id, merged ones included, so reading `contact_id` alone
 * would mark everyone the import touched: a LinkedIn re-import that added 100 people and
 * matched 2,900 promised 100 and would have lit up 3,000. The engine's own stamp decides where
 * it exists (`importedBy.created`, written per row by `markRowsDone`); rows staged before the
 * stamp fall back to "created at or after the import", the rule the People list and
 * `import-undo.ts`'s `candidateRows` use. A stamped merge never falls through to the date.
 *
 * Asked only about this page's ids, so it costs the same for a 19-person import as for a
 * 3,000-person one. Scoped by both the imports and the user, so a foreign or forged id marks
 * nobody rather than leaking another account's contacts. Literal table names and aliases
 * throughout: the inner `contacts` gets its own alias because it and `imports` both have a
 * `created_at` that an interpolated drizzle column would leave unqualified.
 */
async function addedByImports(
  userId: string,
  importIds: string[],
  contactIds: string[],
): Promise<Set<string>> {
  if (!importIds.length || !contactIds.length) return new Set();
  const db = await getDb();
  const rows = rowsOf<{ contact_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT r.contact_id FROM import_job_rows r
      JOIN imports i ON i.id = r.import_id AND i.user_id = ${userId}
      JOIN contacts rc ON rc.id = r.contact_id AND rc.user_id = ${userId}
      WHERE r.import_id IN (${sql.join(importIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND r.user_id = ${userId}
        AND r.status = 'done'
        AND r.contact_id IN (${sql.join(contactIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND (
          (r.payload->'importedBy'->>'created') = 'true'
          OR (NOT jsonb_exists(r.payload, 'importedBy') AND rc.created_at >= i.created_at)
        )
    `),
  );
  return new Set(rows.map((r) => r.contact_id));
}

async function countContacts(where: ReturnType<typeof and>) {
  const db = await getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}
