"use server";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  actionItems,
  contactTags,
  contacts,
  interactionMentions,
  interactions,
  reminders,
  tags,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  CONTACTS_PAGE_SIZE,
  type ContactPickerOption,
  type ContactSort,
  type ContactsPage,
  type ContactsPageFilters,
} from "@/lib/contacts-page";
import { isPaywallError } from "@/lib/entitlements";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { listActiveGoalTexts } from "@/actions/goals";
import { type CompanyResolver } from "@/lib/companies";
import {
  createContactForUser,
  createContactsBulkForUser,
  deleteInteractionForUser,
  logInteractionForUser,
  updateContactForUser,
  type ContactInput,
  type ContactWriteOptions,
  type LogInteractionInput,
} from "@/lib/contact-writes";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { scheduleEmbeddingRebuild } from "@/lib/contact-writes";
import {
  selectTriageCandidates,
  type TriageCandidate,
} from "@/lib/triage-candidates";
import {
  enrichPeopleFromLinkedIn,
  getApolloApiKey,
  type LinkedInProfileEnrichment,
} from "@/lib/apollo";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import {
  AVATAR_BACKFILL_BATCH_SIZE,
  AVATAR_BACKFILL_BUDGET_MS,
  downloadAndPersistAvatar,
  fetchLinkedInPhotoUrl,
  MicrolinkRateLimitError,
} from "@/lib/contact-avatar";
import { clientContactAvatarUrl } from "@/lib/contact-avatar-url";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import {
  countAvatarBackfillCandidates,
  findAvatarBackfillCandidates,
  runAvatarBackfillBatch,
} from "@/lib/avatar-backfill";
import { traced } from "@/lib/perf-trace";
import {
  findRelatedContacts,
  type RelatedContact,
} from "@/lib/related-contacts";
import {
  getOutreachSendConfig,
  sendOutreachMessage,
} from "@/lib/outreach-send";

export type {
  ContactInput,
  ContactWriteOptions,
} from "@/lib/contact-writes";

export type {
  ContactListRow,
  ContactPickerOption,
  ContactSort,
  ContactsPage,
  ContactsPageFilters,
} from "@/lib/contacts-page";

/** Ordering position of the last row on a page, enough to resume immediately after it. */
type Cursor =
  | { s: "name"; k: string; n: string; id: string }
  | { s: "closeness"; c: number; id: string }
  | { s: "recent"; u: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined, sort: ContactSort): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    // A cursor from a different sort describes a position that does not exist in this
    // ordering. Starting over beats silently skipping or repeating people.
    if (!parsed || parsed.s !== sort) return null;
    return parsed as Cursor;
  } catch {
    return null;
  }
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
 */
export async function listContactsPage(
  filters?: ContactsPageFilters
): Promise<ContactsPage> {
  const userId = await requireUserId();
  const db = await getDb();

  const sort: ContactSort = filters?.sort ?? "name";
  const limit = Math.min(Math.max(filters?.limit ?? CONTACTS_PAGE_SIZE, 1), 200);
  const cursor = decodeCursor(filters?.cursor, sort);

  const conditions = [eq(contacts.userId, userId)];

  const q = filters?.q?.trim();
  if (q) conditions.push(searchCondition(q));

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

  if (cursor) conditions.push(cursorCondition(cursor));

  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      preferredName: contacts.preferredName,
      title: contacts.title,
      company: contacts.company,
      school: contacts.school,
      location: contacts.location,
      linkedinUrl: contacts.linkedinUrl,
      profileImageUrl: contacts.profileImageUrl,
      relationshipScore: contacts.relationshipScore,
      closeness: contacts.closeness,
      closenessTier: contacts.closenessTier,
      priorityLevel: contacts.priorityLevel,
      nextFollowUpAt: contacts.nextFollowUpAt,
      lastInteractionAt: contacts.lastInteractionAt,
      sortKey: contacts.sortKey,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(...orderFor(sort))
    // One extra row answers "is there more" without a second count.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

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
      // Never ship base64 data URLs in list payloads.
      profileImageUrl: clientContactAvatarUrl(row.id, row.profileImageUrl),
      relationshipScore: row.relationshipScore,
      closeness: (row.closeness ?? 0) / 100,
      closenessTier: row.closenessTier ?? "outer",
      priorityLevel: row.priorityLevel,
      nextFollowUpAt: row.nextFollowUpAt,
      lastInteractionAt: row.lastInteractionAt,
      tags: tagsByContact.get(row.id) ?? [],
    })),
    nextCursor: hasMore ? encodeCursor(cursorFor(sort, page[page.length - 1])) : null,
    total,
  };
}

/**
 * Every ordering ends in `id`, so it is a total order — without that tiebreak two contacts
 * comparing equal can straddle a page boundary and be shown twice or skipped. It matters
 * more than it sounds: closeness is a 0–100 integer over thousands of rows, so ties are the
 * common case, not the edge case.
 *
 * The tiebreak also has to run in the *same direction* as the column ahead of it. Cursors
 * are row-value comparisons — `(a, b) < (x, y)` — and that form compares every element the
 * same way. Pairing a descending sort with an ascending id silently produces a condition
 * that skips rows on one side of each tie and repeats them on the other.
 */
function orderFor(sort: ContactSort) {
  if (sort === "closeness") {
    return [desc(contacts.closeness), desc(contacts.id)];
  }
  if (sort === "recent") {
    return [desc(contacts.updatedAt), desc(contacts.id)];
  }
  return [asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)];
}

function cursorCondition(cursor: Cursor) {
  if (cursor.s === "closeness") {
    // Both elements descending, matching `orderFor`. See the note there on why the id must
    // run the same direction as the column it breaks ties for.
    return sql`(${contacts.closeness}, ${contacts.id}) < (${cursor.c}, ${cursor.id}::uuid)`;
  }
  if (cursor.s === "recent") {
    return sql`(${contacts.updatedAt}, ${contacts.id}) < (${new Date(cursor.u)}, ${cursor.id}::uuid)`;
  }
  // Row-value comparison rather than the unrolled OR chain, so the planner can satisfy it
  // straight from `contacts_user_sort_idx`.
  return sql`(${contacts.sortKey}, ${contacts.fullName}, ${contacts.id}) > (${cursor.k}, ${cursor.n}, ${cursor.id}::uuid)`;
}

function cursorFor(
  sort: ContactSort,
  row: { id: string; sortKey: string | null; fullName: string; closeness: number | null; updatedAt: Date }
): Cursor {
  if (sort === "closeness") {
    return { s: "closeness", c: row.closeness ?? 0, id: row.id };
  }
  if (sort === "recent") {
    return { s: "recent", u: new Date(row.updatedAt).toISOString(), id: row.id };
  }
  return { s: "name", k: row.sortKey ?? "", n: row.fullName, id: row.id };
}

/**
 * Match a query against the stored search vector, fuzzily against names, and against tags.
 *
 * Four branches because they answer different questions. `search_tsv` is whole-word and
 * ranked, and covers everything on the contact row. The `%` prefix match is kept for the
 * partial-word case a user typing into a filter box expects: "mar" should find "Marcus"
 * before they finish the word, which neither full-text nor trigram will do. Trigram
 * similarity is what finds someone when the spelling is off by a character — it is
 * index-backed via `contacts_name_trgm` on `lower(full_name)`/`lower(company)`, so it is
 * only worth adding for queries long enough to produce meaningful trigrams. Tags cannot be
 * in a generated column — they live in their own table — so they are an EXISTS.
 *
 * `search_tsv` is written as a bare identifier because Drizzle has no `tsvector` column
 * type to declare it with; Postgres maintains it as a generated column either way. The
 * query selects `from contacts` unaliased, so the qualified name resolves.
 */
function searchCondition(q: string) {
  const like = `${q.toLowerCase()}%`;
  const lowered = q.toLowerCase();
  // Trigram similarity only helps (and only uses its index) for queries long
  // enough to produce meaningful trigrams; short prefixes are served by LIKE.
  const fuzzy =
    lowered.length >= 4
      ? sql` or lower(${contacts.fullName}) % ${lowered} or lower(coalesce(${contacts.company}, '')) % ${lowered}`
      : sql``;
  return sql`(
    contacts.search_tsv @@ websearch_to_tsquery('simple', ${q})
    or lower(${contacts.fullName}) like ${like}
    or lower(coalesce(${contacts.company}, '')) like ${like}
    or lower(coalesce(${contacts.email}, '')) like ${like}
    ${fuzzy}
    or exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = ${contacts.id} and lower(t.name) like ${like}
    )
  )`;
}

/**
 * Contacts for a picker — a bounded, searchable slice rather than the whole network.
 *
 * Three components (capture, the reminder dialog, the onboarding wizard) filled a `<select>`
 * by calling `listContacts()` from the browser with no filter, which fetched and serialized
 * every contact the user has. This is what they should have been asking for: a page of
 * results, narrowed by whatever the user has typed.
 */
export async function searchContactsForPicker(
  q?: string,
  limit = 50
): Promise<ContactPickerOption[]> {
  const userId = await requireUserId();
  const db = await getDb();

  const conditions = [eq(contacts.userId, userId)];
  const term = q?.trim();
  if (term) conditions.push(searchCondition(term));

  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      company: contacts.company,
    })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id))
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows;
}

/**
 * Which letters the A–Z rail should offer.
 *
 * An index-only scan over `contacts_user_sort_idx` — it never touches the heap, and reads
 * one small column rather than whole rows. The rail cannot derive this from the loaded page
 * any more: with pagination the client has only seen the first 50 contacts, so asking it
 * which letters exist would dim every letter the user has not scrolled to yet.
 */
export async function listContactLetters(): Promise<string[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .select({
      letter: sql<string>`coalesce(nullif(upper(left(${contacts.sortKey}, 1)), ''), '#')`,
    })
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .groupBy(sql`1`);

  return rows.map((r) => (/^[A-Z]$/.test(r.letter) ? r.letter : "#"));
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

export type TriageDisplayCandidate = {
  id: string;
  fullName: string;
  firstName: string | null;
  company: string | null;
  title: string | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
};

/**
 * Contacts to ask the user about in the setup wizard's triage step.
 *
 * Chosen for information gain, not current closeness — see
 * `selectTriageCandidates` in `@/lib/triage-candidates` for why. This pulls
 * the same column set `listContacts` donates to `getClosenessCohort` (plus a
 * few display-only fields) so evidence/prior here agree with every other
 * surface that shows closeness.
 */
export async function getTriageCandidates(): Promise<TriageDisplayCandidate[]> {
  const userId = await requireUserId();
  const db = await getDb();

  const contactRowsPromise = Promise.resolve(
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        firstName: true,
        company: true,
        title: true,
        profileImageUrl: true,
        linkedinUrl: true,
        relationshipScore: true,
        statedCloseness: true,
        lastInteractionAt: true,
        firstInteractionAt: true,
        dateMet: true,
        createdAt: true,
        email: true,
        school: true,
        industry: true,
        howMet: true,
        aiSummary: true,
        keyFacts: true,
        sharedInterests: true,
      },
      with: { contactTags: { with: { tag: true } } },
    })
  );

  const [rows, cohort] = await Promise.all([
    contactRowsPromise,
    getClosenessCohort(userId, contactRowsPromise),
  ]);

  const pool: TriageCandidate[] = rows.map((c) => {
    const breakdown = cohort.byId.get(c.id);
    return {
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      evidence: breakdown?.evidence ?? 0,
      prior: breakdown?.prior ?? 0,
      statedCloseness: c.statedCloseness,
    };
  });

  const selected = selectTriageCandidates(pool);
  const byId = new Map(rows.map((c) => [c.id, c]));

  return selected.flatMap((c) => {
    const row = byId.get(c.id);
    if (!row) return [];
    return [
      {
        id: row.id,
        fullName: row.fullName,
        firstName: row.firstName,
        company: row.company,
        title: row.title,
        profileImageUrl: row.profileImageUrl,
        linkedinUrl: row.linkedinUrl,
      },
    ];
  });
}

export type ContactFieldSuggestions = {
  locations: string[];
  schools: string[];
  /** Most common location per school (case-insensitive school key → display location). */
  locationBySchool: Record<string, string>;
  /** Most common school per location (case-insensitive location key → display school). */
  schoolByLocation: Record<string, string>;
};

/** Distinct location/school values from the user's network for form autocomplete. */
export async function getContactFieldSuggestions(): Promise<ContactFieldSuggestions> {
  const userId = await requireUserId();
  const db = await getDb();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { location: true, school: true },
  });

  const locationCounts = new Map<string, { display: string; count: number }>();
  const schoolCounts = new Map<string, { display: string; count: number }>();
  const pairCounts = new Map<
    string,
    { school: string; location: string; count: number }
  >();

  for (const row of rows) {
    const location = row.location?.trim();
    const school = row.school?.trim();

    if (location) {
      const key = location.toLowerCase();
      const prev = locationCounts.get(key);
      locationCounts.set(key, {
        display: prev?.display ?? location,
        count: (prev?.count ?? 0) + 1,
      });
    }
    if (school) {
      const key = school.toLowerCase();
      const prev = schoolCounts.get(key);
      schoolCounts.set(key, {
        display: prev?.display ?? school,
        count: (prev?.count ?? 0) + 1,
      });
    }
    if (location && school) {
      const key = `${school.toLowerCase()}::${location.toLowerCase()}`;
      const prev = pairCounts.get(key);
      pairCounts.set(key, {
        school: prev?.school ?? school,
        location: prev?.location ?? location,
        count: (prev?.count ?? 0) + 1,
      });
    }
  }

  const locationBySchool: Record<string, string> = {};
  const schoolByLocation: Record<string, string> = {};
  const bestSchoolPair = new Map<string, { location: string; count: number }>();
  const bestLocationPair = new Map<string, { school: string; count: number }>();

  for (const pair of pairCounts.values()) {
    const schoolKey = pair.school.toLowerCase();
    const locationKey = pair.location.toLowerCase();
    const schoolBest = bestSchoolPair.get(schoolKey);
    if (!schoolBest || pair.count > schoolBest.count) {
      bestSchoolPair.set(schoolKey, {
        location: pair.location,
        count: pair.count,
      });
    }
    const locationBest = bestLocationPair.get(locationKey);
    if (!locationBest || pair.count > locationBest.count) {
      bestLocationPair.set(locationKey, {
        school: pair.school,
        count: pair.count,
      });
    }
  }

  for (const [key, value] of bestSchoolPair) {
    locationBySchool[key] = value.location;
  }
  for (const [key, value] of bestLocationPair) {
    schoolByLocation[key] = value.school;
  }

  const byCountThenName = (
    a: { display: string; count: number },
    b: { display: string; count: number }
  ) =>
    b.count - a.count ||
    a.display.localeCompare(b.display, undefined, { sensitivity: "base" });

  return {
    locations: [...locationCounts.values()]
      .sort(byCountThenName)
      .map((v) => v.display),
    schools: [...schoolCounts.values()]
      .sort(byCountThenName)
      .map((v) => v.display),
    locationBySchool,
    schoolByLocation,
  };
}

export async function getContact(id: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, id), eq(contacts.userId, userId)),
    with: {
      contactTags: { with: { tag: true } },
      interactions: {
        orderBy: [
          desc(interactions.interactionDate),
          asc(interactions.sameDayOrder),
        ],
      },
      // `dismissed` is the undo tombstone: the row survives so the batch item_hash keeps
      // blocking a re-paste, but it must never show up as a live reminder on the profile.
      reminders: {
        where: (r, { ne }) => ne(r.status, "dismissed"),
        orderBy: [desc(reminders.createdAt)],
      },
    },
  });

  if (!contact) return null;

  return {
    ...contact,
    tags: contact.contactTags.map((ct) => ct.tag.name),
  };
}

export async function createContact(
  input: ContactInput,
  options?: ContactWriteOptions
) {
  return createContactForUser(await requireUserId(), input, options);
}

/**
 * Like `createContact`, but returns `null` instead of throwing when the plan's contact
 * limit is full.
 *
 * Import loops use this: a free user importing 300 rows should keep everything that fits
 * and get a count of what did not, rather than having the whole import abort partway with
 * a paywall error.
 */
export async function createContactIfRoom(
  input: ContactInput,
  options?: ContactWriteOptions
) {
  try {
    return await createContactForUser(await requireUserId(), input, options);
  } catch (err) {
    if (isPaywallError(err)) return null;
    throw err;
  }
}

/**
 * Bulk-create contacts in a single insert, using a preloaded `CompanyResolver`
 * (see `createCompanyResolver`) instead of a per-row company lookup, and a
 * single batched embedding pass instead of one embedding call per contact.
 * For bulk imports only — general callers should use `createContact`.
 */
export async function createContactsBulk(
  inputs: ContactInput[],
  companyResolve: CompanyResolver,
  options?: ContactWriteOptions
) {
  return createContactsBulkForUser(
    await requireUserId(),
    inputs,
    companyResolve,
    options
  );
}

export async function updateContact(
  id: string,
  input: Partial<ContactInput>,
  options?: ContactWriteOptions
) {
  return updateContactForUser(await requireUserId(), id, input, options);
}

/** Valid range for a user-supplied closeness rating (matches the 1–5 scale used throughout, e.g. contact-form.tsx's "Strength" field). */
const MIN_STATED_CLOSENESS = 1;
const MAX_STATED_CLOSENESS = 5;

/**
 * Bulk-save closeness ratings from the setup wizard's triage step.
 *
 * Deliberately goes through `updateContactForUser` (the same shared write
 * path `updateContact` wraps) rather than writing `statedCloseness` /
 * `relationshipScore` directly — see the comment on `relationshipScore` in
 * `updateContactForUser` for the mirroring rule. There is one other writer,
 * `acceptScoreBump` in `@/actions/reminders` (it mirrors too), and two
 * is already one more than the invariant wants; a third is how it drifts.
 *
 * Runs one `updateContactForUser` call per rating rather than a single bulk
 * query, since that's what keeps this one writer instead of two. To keep a
 * screen's worth of ratings (eight) fast, each call skips the embedding
 * rebuild — `relationshipScore` isn't part of the embedded text (see
 * `buildContactEmbeddingContent` in `@/lib/search`) — and per-row
 * revalidation, paths are revalidated once after the loop instead.
 *
 * `updateContactForUser` returns `undefined` rather than throwing when its
 * ownership-scoped WHERE matches no row (deleted contact, ownership race) —
 * so `failedContactIds` is how a caller distinguishes "saved" from "silently
 * matched nothing," instead of trusting a bare count. A per-row `try/catch`
 * means one broken id can't abort the rest of the screen's ratings either.
 */
export async function rateContacts(
  ratings: Array<{ contactId: string; closeness: number }>
): Promise<{ updated: number; failedContactIds: string[] }> {
  const userId = await requireUserId();
  let updated = 0;
  const failedContactIds: string[] = [];

  for (const { contactId, closeness } of ratings) {
    const value = Math.min(
      MAX_STATED_CLOSENESS,
      Math.max(MIN_STATED_CLOSENESS, Math.round(closeness))
    );
    try {
      const contact = await updateContactForUser(
        userId,
        contactId,
        { relationshipScore: value },
        { skipEmbedding: true, skipSummary: true, skipRevalidate: true }
      );
      if (contact) {
        updated++;
      } else {
        failedContactIds.push(contactId);
      }
    } catch {
      failedContactIds.push(contactId);
    }
  }

  if (updated > 0) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
    revalidatePath("/dashboard");
  }

  return { updated, failedContactIds };
}

export async function deleteContact(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .delete(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)));
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/graph");
}

export async function logInteraction(input: LogInteractionInput) {
  return logInteractionForUser(await requireUserId(), input);
}

export async function updateInteraction(
  interactionId: string,
  input: {
    rawNotes?: string;
    aiSummary?: string;
    actionItems?: string[];
    interactionType?: string;
    interactionDate?: string | Date;
    parseDateFromNotes?: boolean;
  }
) {
  const userId = await requireUserId();
  const db = await getDb();
  const { parseInteractionDateFromNotes } = await import(
    "@/lib/interaction-date"
  );

  const existing = await db.query.interactions.findFirst({
    where: and(
      eq(interactions.id, interactionId),
      eq(interactions.userId, userId)
    ),
  });
  if (!existing) throw new Error("Interaction not found");

  const parsedDate =
    input.interactionDate instanceof Date
      ? input.interactionDate
      : input.interactionDate
        ? new Date(
            input.interactionDate.length <= 10
              ? `${input.interactionDate}T12:00:00`
              : input.interactionDate
          )
        : null;

  let when =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
  const notes = input.rawNotes !== undefined ? input.rawNotes : existing.rawNotes;
  if (!when && input.parseDateFromNotes) {
    when = parseInteractionDateFromNotes(notes, new Date(existing.interactionDate));
  }

  const [row] = await db
    .update(interactions)
    .set({
      ...(input.rawNotes !== undefined ? { rawNotes: input.rawNotes } : {}),
      ...(input.aiSummary !== undefined ? { aiSummary: input.aiSummary } : {}),
      ...(input.actionItems !== undefined
        ? { actionItems: input.actionItems }
        : {}),
      ...(input.interactionType !== undefined
        ? { interactionType: input.interactionType }
        : {}),
      ...(when ? { interactionDate: when } : {}),
    })
    .where(eq(interactions.id, interactionId))
    .returning();

  if (input.actionItems !== undefined) {
    const { syncActionItems } = await import("@/lib/action-items");
    await syncActionItems(userId, interactionId, existing.contactId, input.actionItems);
  }

  await scheduleEmbeddingRebuild(userId, existing.contactId);
  void generateAndStoreContactBrief(userId, existing.contactId).catch(
    () => null
  );

  revalidatePath(`/contacts/${existing.contactId}`);
  revalidatePath("/dashboard");
  revalidatePath("/graph");
  return row;
}

/** Persist manual order for interactions on the same calendar day (YYYY-MM-DD). */
export async function reorderSameDayInteractions(
  contactId: string,
  dayIso: string,
  orderedIds: string[]
) {
  const userId = await requireUserId();
  const db = await getDb();

  const rows = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contactId)
    ),
  });

  const dayRows = rows.filter((r) => {
    const d = new Date(r.interactionDate);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return iso === dayIso;
  });

  const allowed = new Set(dayRows.map((r) => r.id));
  if (
    orderedIds.length === 0 ||
    orderedIds.some((id) => !allowed.has(id)) ||
    orderedIds.length !== allowed.size
  ) {
    throw new Error("Invalid reorder payload");
  }

  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(interactions)
      .set({ sameDayOrder: i })
      .where(
        and(
          eq(interactions.id, orderedIds[i]),
          eq(interactions.userId, userId)
        )
      );
  }

  revalidatePath(`/contacts/${contactId}`);
  return { ok: true as const };
}

export async function regenerateContactSummary(contactId: string) {
  const userId = await requireUserId();
  const out = await generateAndStoreContactBrief(userId, contactId, {
    force: true,
  });
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  revalidatePath("/dashboard");
  return { summary: out?.summary ?? null };
}

export type LinkedInRefreshTarget = {
  id: string;
  fullName: string;
  email: string | null;
  linkedinUrl: string;
};

/** Contacts that have a LinkedIn URL and can be refreshed. */
export async function listLinkedInRefreshTargets(): Promise<{
  targets: LinkedInRefreshTarget[];
  hasApollo: boolean;
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const apiKey = await getApolloApiKey(userId);

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
    },
  });

  const targets = rows
    .filter((r): r is typeof r & { linkedinUrl: string } =>
      Boolean(r.linkedinUrl?.trim())
    )
    .map((r) => ({
      id: r.id,
      fullName: r.fullName,
      email: r.email,
      linkedinUrl: r.linkedinUrl.trim(),
    }));

  return { targets, hasApollo: Boolean(apiKey) };
}

export type AvatarBackfillResult = {
  saved: number;
  savedIds: string[];
  /**
   * Contacts we tried and couldn't resolve. Pass them back as `skipIds` so the
   * next batch moves past them instead of retrying the same few forever.
   */
  failedIds: string[];
  pending: number;
  failed: number;
  rateLimitedUntil: number | null;
  /** Set when the photo store itself is broken — the whole run should stop. */
  storageError: string | null;
};

export type AvatarBackfillOptions = {
  limit?: number;
  skipIds?: string[];
};

/**
 * Persist LinkedIn photos for contacts that still need one.
 * Processes a small batch, stops when Microlink quota is hit, and returns
 * when the client should retry after the rate-limit reset.
 */
export async function backfillContactAvatars(
  options: AvatarBackfillOptions = {}
): Promise<AvatarBackfillResult> {
  const userId = await requireUserId();
  const limit = options.limit ?? AVATAR_BACKFILL_BATCH_SIZE;
  const batchSize = Math.min(
    Math.max(1, Math.floor(limit) || AVATAR_BACKFILL_BATCH_SIZE),
    AVATAR_BACKFILL_BATCH_SIZE
  );
  const skipIds = options.skipIds ?? [];
  const db = await getDb();

  // Two bounded statements: the page of work, and the size of the backlog it came from.
  // The backlog count is what the client shows progress against and uses to stop.
  const [candidates, backlog] = await Promise.all([
    findAvatarBackfillCandidates(db, userId, { limit: batchSize, skipIds }),
    countAvatarBackfillCandidates(db, userId, skipIds),
  ]);

  if (candidates.length === 0) {
    return {
      saved: 0,
      savedIds: [],
      failedIds: [],
      pending: 0,
      failed: 0,
      rateLimitedUntil: null,
      storageError: null,
    };
  }

  const result = await traced(
    "contacts.backfillAvatars",
    () =>
      runAvatarBackfillBatch(candidates, {
        deadline: Date.now() + AVATAR_BACKFILL_BUDGET_MS,
        persistRemote: downloadAndPersistAvatar,
        resolveLinkedIn: fetchLinkedInPhotoUrl,
        save: async (contactId, photoUrl) => {
          await db
            .update(contacts)
            .set({ profileImageUrl: photoUrl, updatedAt: new Date() })
            .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
        },
      }),
    { userId }
  );

  if (result.saved > 0) {
    revalidatePath("/contacts");
    revalidatePath("/");
    revalidatePath("/graph");
  }

  return {
    ...result,
    pending: Math.max(0, backlog - result.saved - result.failedIds.length),
  };
}

function isLinkedInProfileUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`
    );
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "linkedin.com" && /\/in\//i.test(url.pathname);
  } catch {
    return /linkedin\.com\/in\//i.test(trimmed);
  }
}

/**
 * Look up a LinkedIn profile (via Apollo) to autofill role and related fields
 * on the contact form. Does not write to the database.
 */
export async function lookupLinkedInProfile(input: {
  linkedinUrl: string;
  fullName?: string;
  email?: string;
}): Promise<LinkedInProfileEnrichment | null> {
  const userId = await requireUserId();
  const raw = input.linkedinUrl.trim();
  if (!isLinkedInProfileUrl(raw)) {
    throw new Error("Enter a LinkedIn profile URL (linkedin.com/in/…)");
  }

  const linkedinUrl = buildLinkedInUrl(raw);
  const [profile] = await enrichPeopleFromLinkedIn(userId, [
    {
      linkedinUrl,
      fullName: input.fullName?.trim() || null,
      email: input.email?.trim() || null,
    },
  ]);
  return profile;
}

/**
 * Refresh a batch of contacts from LinkedIn via Apollo people/match.
 * Updates role, company, location, school, and profile picture when found.
 */
export async function refreshContactsFromLinkedIn(contactIds: string[]) {
  const userId = await requireUserId();
  if (contactIds.length === 0) {
    return { refreshed: 0, unmatched: 0, failed: 0, avatarOnly: false, rateLimited: false };
  }
  if (contactIds.length > LINKEDIN_REFRESH_BATCH_SIZE) {
    throw new Error(
      `Refresh at most ${LINKEDIN_REFRESH_BATCH_SIZE} contacts at a time`
    );
  }

  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)),
    columns: {
      id: true,
      fullName: true,
      email: true,
      linkedinUrl: true,
      title: true,
      company: true,
      location: true,
      school: true,
      profileImageUrl: true,
      firstName: true,
      lastName: true,
    },
  });

  // Preserve caller order for stable batch progress.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = contactIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r?.linkedinUrl?.trim()));

  if (ordered.length === 0) {
    return { refreshed: 0, unmatched: 0, failed: 0, avatarOnly: false, rateLimited: false };
  }

  let enriched: Awaited<ReturnType<typeof enrichPeopleFromLinkedIn>>;
  let avatarOnly = false;

  const apiKey = await getApolloApiKey(userId);
  if (!apiKey) {
    // Photos still refresh via LinkedIn OG without Apollo.
    avatarOnly = true;
    enriched = ordered.map(() => null);
  } else {
    try {
      enriched = await enrichPeopleFromLinkedIn(
        userId,
        ordered.map((r) => ({
          linkedinUrl: r.linkedinUrl!,
          fullName: r.fullName,
          email: r.email,
        }))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Free Apollo plans often block people enrichment — still refresh photos.
      if (
        /not available on your current plan|403|Add an Apollo API key/i.test(
          message
        )
      ) {
        avatarOnly = true;
        enriched = ordered.map(() => null);
      } else {
        throw err;
      }
    }
  }

  let refreshed = 0;
  let unmatched = 0;
  let failed = 0;
  let rateLimited = false;

  for (let i = 0; i < ordered.length; i++) {
    const contact = ordered[i];
    const profile = enriched[i];

    try {
      // Prefer Apollo photo when present; otherwise resolve via LinkedIn.
      let profileImageUrl: string | null = null;
      if (profile?.profileImageUrl) {
        profileImageUrl = await downloadAndPersistAvatar(
          contact.id,
          profile.profileImageUrl
        );
      }
      if (!profileImageUrl && contact.linkedinUrl) {
        try {
          profileImageUrl = await fetchLinkedInPhotoUrl(
            contact.id,
            contact.linkedinUrl
          );
        } catch (err) {
          if (err instanceof MicrolinkRateLimitError) {
            rateLimited = true;
            unmatched += 1;
            continue;
          }
          throw err;
        }
      }

      if (!profile) {
        if (profileImageUrl) {
          await updateContact(
            contact.id,
            { profileImageUrl },
            { skipRevalidate: true }
          );
          refreshed += 1;
        } else {
          unmatched += 1;
        }
        continue;
      }

      await updateContact(
        contact.id,
        {
          ...(profile.title ? { title: profile.title } : {}),
          ...(profile.company ? { company: profile.company } : {}),
          ...(profile.location ? { location: profile.location } : {}),
          ...(profile.school ? { school: profile.school } : {}),
          ...(profile.email ? { email: profile.email } : {}),
          ...(profile.firstName ? { firstName: profile.firstName } : {}),
          ...(profile.lastName ? { lastName: profile.lastName } : {}),
          ...(profile.linkedinUrl
            ? { linkedinUrl: profile.linkedinUrl }
            : {}),
          ...(profileImageUrl ? { profileImageUrl } : {}),
        },
        { skipRevalidate: true }
      );
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }

  revalidatePath("/contacts");
  revalidatePath("/");
  revalidatePath("/graph");

  return { refreshed, unmatched, failed, avatarOnly, rateLimited };
}

/** Draft a warm follow-up message from the contact profile. */
export async function draftContactFollowUp(
  contactId: string,
  options?: {
    channel?: "email" | "linkedin" | "sms";
    intent?: string;
  }
) {
  const userId = await requireUserId();
  const goals = await listActiveGoalTexts();
  return generateContactFollowUpDraft(userId, contactId, goals, options);
}

export type ContactFollowUpSendOptions = {
  canSendEmail: boolean;
  hasEmail: boolean;
  hasLinkedIn: boolean;
  email: string | null;
  linkedinUrl: string | null;
};

/** Whether this contact can receive an automated email follow-up. */
export async function getContactFollowUpSendOptions(
  contactId: string
): Promise<ContactFollowUpSendOptions> {
  const userId = await requireUserId();
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      email: true,
      linkedinUrl: true,
    },
  });
  if (!contact) throw new Error("Contact not found");

  const config = await getOutreachSendConfig(userId);
  const email = contact.email?.trim() || null;
  const linkedinUrl = contact.linkedinUrl?.trim() || null;

  return {
    hasEmail: Boolean(email),
    hasLinkedIn: Boolean(linkedinUrl),
    email,
    linkedinUrl,
    canSendEmail: Boolean(email && config.resendApiKey),
  };
}

/** Send a follow-up email via Resend and log it as an interaction. */
export async function sendContactFollowUpEmail(
  contactId: string,
  body: string,
  subject?: string
) {
  const userId = await requireUserId();
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      email: true,
      fullName: true,
      preferredName: true,
    },
  });
  if (!contact) throw new Error("Contact not found");
  if (!contact.email?.trim()) throw new Error("Contact has no email address.");

  const trimmed = body.trim();
  if (!trimmed) throw new Error("Message body is empty.");

  const name = contact.preferredName || contact.fullName;
  await sendOutreachMessage({
    userId,
    channel: "email",
    toEmail: contact.email.trim(),
    subject: subject?.trim() || `Following up · ${name}`,
    body: trimmed,
  });

  await logInteraction({
    contactId,
    interactionType: "email",
    source: "follow_up",
    rawNotes: trimmed,
    aiSummary: "Sent follow-up email from contact profile",
  });

  const { clearContactFollowUp } = await import("@/actions/reminders");
  await clearContactFollowUp(contactId);

  return { ok: true as const };
}

/** Contacts related by company, school, howMet, mentions, tags, or interests. */
export async function listRelatedContacts(
  contactId: string,
  limit = 6
): Promise<RelatedContact[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const goals = await listActiveGoalTexts();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: { contactTags: { with: { tag: true } } },
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      firstName: true,
      title: true,
      company: true,
      companyId: true,
      school: true,
      location: true,
      howMet: true,
      profileImageUrl: true,
      linkedinUrl: true,
      email: true,
      phone: true,
      notes: true,
      aiSummary: true,
      keyFacts: true,
      sharedInterests: true,
      relationshipScore: true,
    },
  });

  return findRelatedContacts(
    contactId,
    rows.map((r) => ({
      ...r,
      tags: r.contactTags.map((ct) => ct.tag.name),
    })),
    limit,
    goals
  );
}

/** Lightweight contact payload for the floating ask bar person chip. */
export async function getAskBarContact(contactId: string): Promise<{
  id: string;
  displayName: string;
  firstName: string | null;
  fullName: string;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
} | null> {
  const userId = await requireUserId();
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      preferredName: true,
      firstName: true,
      fullName: true,
      profileImageUrl: true,
      linkedinUrl: true,
    },
  });
  if (!contact) return null;
  return {
    id: contact.id,
    displayName: contact.preferredName || contact.fullName,
    firstName: contact.firstName,
    fullName: contact.fullName,
    profileImageUrl: contact.profileImageUrl,
    linkedinUrl: contact.linkedinUrl,
  };
}

/**
 * Everything the interaction detail sheet shows, fetched when the sheet opens rather than
 * loaded with the profile — the timeline can hold hundreds of interactions and only one is
 * ever open at a time.
 */
export async function getInteractionDetail(interactionId: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const row = await db.query.interactions.findFirst({
    where: and(
      eq(interactions.id, interactionId),
      eq(interactions.userId, userId)
    ),
  });
  if (!row) throw new Error("Interaction not found");

  const [items, mentioned] = await Promise.all([
    db
      .select({
        id: actionItems.id,
        text: actionItems.text,
        status: actionItems.status,
        reminderId: actionItems.reminderId,
      })
      .from(actionItems)
      .where(
        and(
          eq(actionItems.userId, userId),
          eq(actionItems.interactionId, interactionId)
        )
      )
      .orderBy(asc(actionItems.position)),
    db
      .select({
        contactId: interactionMentions.contactId,
        mentionText: interactionMentions.mentionText,
        fullName: contacts.fullName,
      })
      .from(interactionMentions)
      .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
      .where(
        and(
          eq(interactionMentions.userId, userId),
          eq(interactionMentions.interactionId, interactionId)
        )
      ),
  ]);

  return {
    id: row.id,
    contactId: row.contactId,
    interactionType: row.interactionType,
    interactionDate: new Date(row.interactionDate).toISOString(),
    aiSummary: row.aiSummary,
    rawNotes: row.rawNotes,
    topics: row.topics ?? [],
    source: row.source,
    // `action_items` rows are the source of truth; the jsonb column on the interaction is a
    // write-through denorm, so it is deliberately not read here. When a row has notes but no
    // rows (an older interaction, or one logged without AI), fall back to the denorm so the
    // sheet still shows what was recorded.
    actionItems: items.length
      ? items
      : (row.actionItems ?? []).map((text, index) => ({
          id: `denorm-${index}`,
          text,
          status: "open" as const,
          reminderId: null as string | null,
        })),
    /** True when the items above came from `action_items` and can therefore be checked off. */
    actionItemsCheckable: items.length > 0,
    mentions: mentioned,
  };
}

export type InteractionDetail = Awaited<ReturnType<typeof getInteractionDetail>>;

/**
 * Re-extract the summary, topics and action items for one interaction from its own notes.
 *
 * `syncActionItems` diffs by hash, so items the user already ticked off keep their completed
 * state instead of coming back as fresh open ones.
 */
export async function resummarizeInteraction(interactionId: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const existing = await db.query.interactions.findFirst({
    where: and(
      eq(interactions.id, interactionId),
      eq(interactions.userId, userId)
    ),
  });
  if (!existing) throw new Error("Interaction not found");

  const notes = (existing.rawNotes || "").trim();
  if (!notes) throw new Error("There are no notes to summarize");

  const contact = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.id, existing.contactId),
      eq(contacts.userId, userId)
    ),
  });

  const { consumeBucket, RATE_LIMITS } = await import("@/lib/rate-limit");
  await consumeBucket("capture", userId, RATE_LIMITS.capture);

  const { parseMultiPersonNotesWithAI } = await import("@/lib/ai");
  const { withLockedSeedPerson } = await import("@/lib/note-batches");
  const parsed = await parseMultiPersonNotesWithAI(
    userId,
    notes,
    contact ? withLockedSeedPerson(null, contact.fullName) : null
  );

  const person =
    parsed.people.find((p) => p.presence !== "mentioned") ?? parsed.people[0];
  if (!person) throw new Error("Couldn't find anything to summarize in those notes");

  const { MAX_ACTION_ITEMS_PER_INTERACTION, syncActionItems } = await import(
    "@/lib/action-items"
  );
  const items = (person.action_items ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_ACTION_ITEMS_PER_INTERACTION);

  const [row] = await db
    .update(interactions)
    .set({
      aiSummary: person.summary?.trim() || existing.aiSummary,
      topics: person.topics ?? [],
      actionItems: items,
    })
    .where(eq(interactions.id, interactionId))
    .returning();

  await syncActionItems(userId, interactionId, existing.contactId, items);
  await scheduleEmbeddingRebuild(userId, existing.contactId);
  void generateAndStoreContactBrief(userId, existing.contactId).catch(() => null);

  revalidatePath(`/contacts/${existing.contactId}`);
  revalidatePath("/dashboard");
  return row;
}

export async function deleteInteraction(interactionId: string) {
  return deleteInteractionForUser(await requireUserId(), interactionId);
}
