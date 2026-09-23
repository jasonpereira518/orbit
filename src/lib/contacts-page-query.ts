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

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactTags, contacts, tags } from "@/db/schema";
import { getRankedContacts } from "@/actions/search";
import { contactSearchCondition, nameMatchTierSql } from "@/lib/contact-search-rank";
import {
  contactsCursorCondition,
  contactsCursorFor,
  contactsOrderBy,
  decodeContactsCursor,
  encodeContactsCursor,
} from "@/lib/contacts-page-cursor";
import { contactsListSelection } from "@/lib/contact-avatar-sql";
import type { RankedContact } from "@/lib/hybrid-search";
import {
  CONTACTS_PAGE_SIZE,
  type ContactSort,
  type ContactsPage,
  type ContactsPageFilters,
} from "@/lib/contacts-page";

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
 */
export async function listContactsPage(
  userId: string,
  filters?: ContactsPageFilters
): Promise<ContactsPage> {
  const db = await getDb();

  const sort: ContactSort = filters?.sort ?? "name";
  const limit = Math.min(Math.max(filters?.limit ?? CONTACTS_PAGE_SIZE, 1), 200);
  // "relevance" has no stable keyset — see `contactsOrderBy` — so it never accepts a cursor and
  // always returns its first (only) page.
  const cursor = sort === "relevance" ? null : decodeContactsCursor(filters?.cursor, sort, Boolean(filters?.q?.trim()));

  const conditions = [eq(contacts.userId, userId)];

  const q = filters?.q?.trim();
  // Reused below by `contactsOrderBy` (relevance ranking) and by the match-reason map — one
  // hybrid-search call serves widening, ranking, and explaining, instead of asking thrice.
  let semanticIds: string[] = [];
  let matchReasons = new Map<string, string>();
  if (q) {
    // Short queries are prefix lookups ("mar" -> Marcus) that `contactSearchCondition` alone
    // already serves well; below this length a semantic round trip only adds latency.
    // At 3+ chars, OR in contacts whose title/company/experience is a semantic match
    // even when no literal keyword overlaps ("Full-time SWE at Google" finding someone
    // whose stored role is "Software Engineer" at Google, full time). Request the max
    // hybridSearchContacts will give (80) rather than its default 12, since this list
    // also drives relevance ordering, not just widening the match.
    const ranked = q.length >= 3 ? await getRankedContacts(userId, q, 80) : [];
    semanticIds = ranked.map((r) => r.id);
    matchReasons = matchReasonsFor(ranked);
    conditions.push(
      semanticIds.length
        ? or(contactSearchCondition(q), inArray(contacts.id, semanticIds))!
        : contactSearchCondition(q)
    );
  }
  // Name matches first in every sort while searching; see `contacts-page-cursor.ts`.
  const tier = q ? nameMatchTierSql(q) : null;

  const company = filters?.company?.trim();
  if (company) {
    // Matches `contacts_company_idx`, which existed all along and was never used because
    // this filter ran in JavaScript.
    conditions.push(sql`lower(trim(${contacts.company})) = ${company.toLowerCase()}`);
  }

  if (filters?.minScore) {
    conditions.push(sql`${contacts.relationshipScore} >= ${filters.minScore}`);
  }

  if (filters?.followUp === "due") {
    conditions.push(
      sql`${contacts.nextFollowUpAt} is not null and ${contacts.nextFollowUpAt} <= now()`
    );
  }

  const importId = filters?.importId?.trim();
  if (importId) {
    // Narrowed to one import's people — the same set the People list reads
    // (`importContactIds` in `src/lib/imports/import-people.ts`). Scoped by both the import
    // and the user, so a foreign or forged `importId` simply matches nothing rather than
    // leaking another account's contacts. A literal table name, not an interpolated column
    // reference: `import_job_rows` isn't part of this query's FROM clause.
    conditions.push(
      sql`${contacts.id} IN (
        SELECT r.contact_id FROM import_job_rows r
        WHERE r.import_id = ${importId} AND r.user_id = ${userId}
          AND r.status = 'done' AND r.contact_id IS NOT NULL
      )`
    );
  }

  // The A–Z rail is a seek, not a scroll. Asking for "S" starts the page at the first
  // contact sorting there rather than loading everyone up to it — which is the whole reason
  // the rail survives pagination at all.
  const letter = filters?.letter?.trim();
  if (letter && sort === "name") {
    conditions.push(
      letter === "#"
        ? sql`(${contacts.sortKey} is null or ${contacts.sortKey} < 'a')`
        : sql`${contacts.sortKey} >= ${letter.toLowerCase()}`
    );
  }

  if (cursor) conditions.push(contactsCursorCondition(cursor, tier));

  const rows = await db
    .select({ ...contactsListSelection, nameTier: tier ?? sql<number>`2` })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(...contactsOrderBy(sort, tier, semanticIds))
    // One extra row answers "is there more" without a second count.
    .limit(limit + 1);

  const fetchedExtra = rows.length > limit;
  const page = fetchedExtra ? rows.slice(0, limit) : rows;
  // Relevance has no keyset to resume from, so it never claims there's more — the caller
  // gets one ranked page and the "Showing X of Y" footer if that page is short of `total`.
  const hasMore = sort !== "relevance" && fetchedExtra;

  const [tagsByContact, total] = await Promise.all([
    tagsForContacts(page.map((r) => r.id)),
    cursor ? Promise.resolve(null) : countContacts(and(...conditions)),
  ]);

  return {
    items: page.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      firstName: row.firstName,
      lastName: row.lastName,
      preferredName: row.preferredName,
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
      tags: tagsByContact.get(row.id) ?? [],
      matchReason: matchReasons.get(row.id) ?? null,
    })),
    nextCursor: hasMore ? encodeContactsCursor(contactsCursorFor(sort, page[page.length - 1], Boolean(tier))) : null,
    total,
  };
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

async function countContacts(where: ReturnType<typeof and>) {
  const db = await getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}

/** Tag names for one page of contacts — one query for the page, not one per row. */
async function tagsForContacts(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ contactId: contactTags.contactId, name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, ids));
  for (const row of rows) {
    const list = out.get(row.contactId) ?? [];
    list.push(row.name);
    out.set(row.contactId, list);
  }
  return out;
}
