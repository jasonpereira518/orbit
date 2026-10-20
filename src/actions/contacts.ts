"use server";

import { relatedSqlLower } from "@/lib/related-contacts-sql";
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { listSchools } from "@/lib/events/target-companies";
import { contactSearchCondition, nameMatchTierSql } from "@/lib/contact-search-rank";
import { deleteReplacedAvatar } from "@/lib/avatar-blob";
import { deleteContactForUser } from "@/lib/contact-delete";
import { revalidatePath } from "next/cache";
import { getDb, rowsOf } from "@/db";
import {
  actionItems,
  contactTags,
  contacts,
  interactionMentions,
  interactions,
  noteBatches,
  reminders,
} from "@/db/schema";
import { getCurrentUserProfile } from "@/lib/auth";
import { countsAsTouch } from "@/lib/interaction-provenance";
import {
  type ContactPickerOption,
  type ContactsPage,
  type ContactsPageFilters,
} from "@/lib/contacts-page";
import { listContactsPage as listContactsPageForUser } from "@/lib/contacts-page-query";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { listActiveGoalTexts } from "@/actions/goals";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { settle, unwrap } from "@/lib/settled";
import {
  deleteInteractionForUser,
  logInteractionForUser,
  updateContactForUser,
  type ContactInput,
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
  fetchApolloLinkedInPhoto,
  getApolloApiKey,
  type LinkedInProfileEnrichment,
} from "@/lib/apollo";
import { kickWorkHistoryResearch } from "@/lib/work-history-research";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import {
  AVATAR_BACKFILL_BATCH_SIZE,
  AVATAR_BACKFILL_BUDGET_MS,
  downloadAndPersistAvatar,
  fetchGravatarPhotoUrl,
  AvatarSourceRateLimitError,
} from "@/lib/contact-avatar";
import { resolveLinkedInPhotoCached, type ProfileImageSource } from "@/lib/shared-avatars";
import { clientAvatarUrlSql, sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import {
  buildGooglePhotoIndex,
  buildOutlookContactIndex,
  fetchOutlookContactPhoto,
} from "@/lib/contact-avatar-connectors";
import { draftFollowUpResult } from "@/lib/follow-up-drafts";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import {
  countAvatarBackfillCandidates,
  findAvatarBackfillCandidates,
  runAvatarBackfillBatch,
} from "@/lib/avatar-backfill";
import { reindexInteractionPassages } from "@/lib/memory-backfill";
import { traced } from "@/lib/perf-trace";
import {
  findRelatedContacts,
  interestTextPattern,
  JS_WHITESPACE,
  JS_WHITESPACE_AS_SPACES,
  likeBody,
  mentionLikePatterns,
  nameAliases,
  relatedCandidateFilter,
  type RelatedContact,
  type RelatedContactCandidate,
} from "@/lib/related-contacts";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { scheduleDispatch } from "@/lib/email/schedule";
import { getSendCapability, type MailboxId, type SendBlockReason } from "@/lib/email/sender";
import { TEXT_LIMITS, cleanOptionalText, cleanTextList } from "@/lib/input/text";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";
import { anyNumber, uuid } from "@/lib/input/schemas";

// Argument shapes, generated from the handlers' parameter types.
const LogInteractionInputSchema = z.looseObject({ contactId: z.string(), rawNotes: z.string().optional(), aiSummary: z.string().optional(), topics: z.array(z.string()).optional(), actionItems: z.array(z.string()).optional(), interactionType: z.string().optional(), source: z.string().optional(), interactionDate: z.union([z.string(), z.date()]).optional(), parseDateFromNotes: z.boolean().optional(), externalId: z.string().optional(), noteBatchId: z.string().optional(), direction: z.enum(["in", "out"]).nullish() });

// Argument shapes, generated from the handlers' parameter types.
const ContactsPageFiltersSchema = z.looseObject({ q: z.string().optional(), company: z.string().optional(), minScore: anyNumber.optional(), followUp: z.enum(["due"]).optional(), quiet: anyNumber.optional(), sort: z.enum(["name", "closeness", "relevance", "recent", "last_touch"]).optional(), letter: z.string().optional(), tag: z.string().optional(), school: z.string().optional(), cursor: z.string().optional(), limit: anyNumber.optional(), importId: z.string().optional() });
const ContactInputSchema = z.looseObject({ fullName: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), preferredName: z.string().optional(), company: z.string().optional(), title: z.string().optional(), location: z.string().optional(), school: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), linkedinUrl: z.string().optional(), xHandle: z.string().optional(), website: z.string().optional(), blueskyHandle: z.string().nullish(), mastodonAcct: z.string().nullish(), profileImageUrl: z.string().nullish(), profileImageSource: z.string().nullish(), relationshipScore: anyNumber.optional(), statedCloseness: anyNumber.nullish(), priorityLevel: anyNumber.optional(), source: z.string().optional(), industry: z.string().optional(), metContext: z.string().optional(), dateMet: z.string().nullish(), firstInteractionAt: z.union([z.string(), z.date()]).nullish(), lastInteractionAt: z.union([z.string(), z.date()]).nullish(), howMet: z.string().optional(), notes: z.string().optional(), aiSummary: z.string().optional(), keyFacts: z.array(z.string()).optional(), sharedInterests: z.array(z.string()).optional(), opportunities: z.array(z.string()).optional(), cadenceDays: anyNumber.nullish(), cadencePhrase: z.string().nullish(), cadenceSource: z.enum(["note", "user"]).nullish(), cadenceSetAt: z.date().nullish(), nextFollowUpAt: z.string().nullish(), tagNames: z.array(z.string()).optional() });
const AvatarBackfillOptionsSchema = z.looseObject({ limit: anyNumber.optional(), skipIds: z.array(z.string()).optional() });

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

/**
 * One page of a user's contacts, ordered, filtered and searched in Postgres.
 *
 * A thin `requireUserId()` wrapper — the query itself lives in `listContactsPage` in
 * `@/lib/contacts-page-query`, which takes `userId` explicitly so it can be exercised
 * directly from a smoke script (see that file's doc comment and
 * `scripts/smoke-import-undo.ts`).
 */
export const listContactsPage = defineAction(
  { schema: z.tuple([ContactsPageFiltersSchema.optional()]) },
  async (userId, filters?: ContactsPageFilters): Promise<ContactsPage> => {
    return listContactsPageForUser(userId, filters);
  }
);

/**
 * Contacts for a picker — a bounded, searchable slice rather than the whole network.
 *
 * Three components (capture, the reminder dialog, the onboarding wizard) filled a `<select>`
 * by calling `listContacts()` from the browser with no filter, which fetched and serialized
 * every contact the user has. This is what they should have been asking for: a page of
 * results, narrowed by whatever the user has typed.
 */
export const searchContactsForPicker = defineAction(
  { schema: z.tuple([z.string().optional(), anyNumber.optional(), z.enum(["recent", "alphabetical"]).optional()]) },
  async (userId, q?: string, limit: number = 50, order: "alphabetical" | "recent" = "alphabetical"): Promise<ContactPickerOption[]> => {
    const db = await getDb();

    const conditions = [eq(contacts.userId, userId)];
    const term = q?.trim();
    if (term) conditions.push(contactSearchCondition(term, userId));

    const rows = await db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        firstName: contacts.firstName,
        // Never `profileImageUrl` itself: that column carries base64 up to 120 KB a row when
        // Blob storage is unconfigured, and a 200-row picker would drag all of it across the
        // wire only to rewrite it to `/api/avatars/{id}` anyway.
        avatarUrl: clientAvatarUrlSql.as("avatar_url"),
      })
      .from(contacts)
      .where(and(...conditions))
      .orderBy(
        // Name matches first, so "Priya" opens on Priya rather than on whoever sorts first
        // among the people whose notes mention her.
        ...(term ? [asc(nameMatchTierSql(term))] : []),
        ...(order === "recent"
          ? [
              // Never-spoken-to contacts fall to the back and sort alphabetically among
              // themselves, so the tail is still browsable rather than arbitrary.
              sql`${contacts.lastInteractionAt} desc nulls last`,
              asc(contacts.sortKey),
            ]
          : [asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)])
      )
      .limit(Math.min(Math.max(limit, 1), 200));

    return rows;
  }
);

/**
 * Which letters the A–Z rail should offer.
 *
 * An index-only scan over `contacts_user_sort_idx` — it never touches the heap, and reads
 * one small column rather than whole rows. The rail cannot derive this from the loaded page
 * any more: with pagination the client has only seen the first 50 contacts, so asking it
 * which letters exist would dim every letter the user has not scrolled to yet.
 */
/**
 * What the Contacts School filter offers: the user's own schools (for "Same school as me"),
 * and the schools their network went to, most common first.
 */
export const listContactSchoolOptions = defineAction(
  {},
  async (userId): Promise<{ mine: string[]; network: string[] }> => {
    const db = await getDb();
    const [mine, rows] = await Promise.all([
      listSchools(userId),
      db
        .select({ name: sql<string>`btrim(${contacts.school})` })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), sql`btrim(coalesce(${contacts.school}, '')) <> ''`))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) desc`, sql`1`)
        .limit(40),
    ]);
    return { mine, network: rows.map((r) => r.name) };
  }
);

export const listContactLetters = defineAction(
  {},
  async (userId): Promise<string[]> => {
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
);

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
 *
 * The avatar is NOT one of those fields: `profile_image_url` can hold ~120 KB of base64 per
 * contact, and the scan covers the whole network to pick at most `TRIAGE_LIMIT` people. It
 * is read afterwards for the selected rows only, as the browser-safe URL
 * (`clientAvatarUrlSql`), which `ContactAvatar` draws exactly as it drew the stored value.
 */
export const getTriageCandidates = defineAction(
  {},
  async (userId): Promise<TriageDisplayCandidate[]> => {
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
    const avatarRows = selected.length
      ? await db
          .select({ id: contacts.id, profileImageUrl: clientAvatarUrlSql })
          .from(contacts)
          .where(
            and(
              eq(contacts.userId, userId),
              inArray(
                contacts.id,
                selected.map((c) => c.id)
              )
            )
          )
      : [];
    const avatarById = new Map(avatarRows.map((r) => [r.id, r.profileImageUrl]));

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
          profileImageUrl: avatarById.get(row.id) ?? null,
          linkedinUrl: row.linkedinUrl,
        },
      ];
    });
  }
);

export type ContactFieldSuggestions = {
  locations: string[];
  schools: string[];
  /** Most common location per school (case-insensitive school key → display location). */
  locationBySchool: Record<string, string>;
  /** Most common school per location (case-insensitive location key → display school). */
  schoolByLocation: Record<string, string>;
};

/** Distinct location/school values from the user's network for form autocomplete. */
export const getContactFieldSuggestions = defineAction(
  {},
  async (userId): Promise<ContactFieldSuggestions> => {
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
);

/**
 * The interaction columns every timeline read ships. `notesPreview` is `raw_notes` truncated
 * in SQL: the timeline renders a two-line clamp, so shipping whole pasted notes to a client
 * component on every profile view bought nothing — a contact carrying an imported LinkedIn
 * thread paid for thousands of characters to show two lines of them. It is only ever used
 * for that preview and for "does this have notes at all"; the detail sheet still loads the
 * full row lazily through `getInteractionDetail`.
 */
const timelineInteractionColumns = () => ({
  // `as const` keeps each `true` literal, which is what types the selected row.
  columns: {
    id: true,
    interactionType: true,
    interactionDate: true,
    sameDayOrder: true,
    // Which captured batch produced this row, so the timeline can say the summary came
    // from a meeting capture rather than a hand-typed note.
    noteBatchId: true,
    aiSummary: true,
    // Provenance: the profile's "last touch" skips AI-derived timeline events.
    source: true,
  } as const,
  extras: {
    notesPreview: sql<string | null>`left(${interactions.rawNotes}, 600)`.as("notes_preview"),
  },
  orderBy: [desc(interactions.interactionDate), asc(interactions.sameDayOrder)],
});

async function loadContactWithHistory(
  userId: string,
  id: string,
  interactionLimit?: number
) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, id), eq(contacts.userId, userId)),
    // The shared LinkedIn photo (if any) rides beside the contact's own `profileImageUrl`.
    extras: { sharedAvatarUrl: sharedAvatarUrlSql.as("shared_avatar_url") },
    with: {
      contactTags: { with: { tag: true } },
      // Columns are restricted, not rows (unless the caller asks for a page of them):
      // `contacts/[id]/page.tsx` derives `hasLoggedInteraction` from these rows, which a
      // LIMIT with the history aggregate beside it survives but a WHERE would not.
      interactions: {
        ...timelineInteractionColumns(),
        ...(interactionLimit ? { limit: interactionLimit } : {}),
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

/**
 * The contact with its WHOLE interaction history. The MCP-facing and capture callers rely on
 * the full list; the profile page reads {@link getContactForProfile} instead.
 */
export const getContact = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, id: string) => {
    return loadContactWithHistory(userId, id);
  }
);

/**
 * Just enough of a contact to label a form: the capture page names who the note is about
 * and needs nothing else, where `getContact` would ship their whole history and reminders.
 */
export const getContactLabel = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, id: string): Promise<{ id: string; name: string } | null> => {
    const db = await getDb();
    const [row] = await db
      .select({ id: contacts.id, fullName: contacts.fullName, preferredName: contacts.preferredName })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
      .limit(1);
    return row ? { id: row.id, name: row.preferredName || row.fullName } : null;
  }
);

/** How many interactions the profile loads with the contact; the timeline shows 40 of them. */
const PROFILE_INTERACTION_PAGE = 60;

/**
 * Whole-history facts the profile needs when it only holds the newest page of interactions.
 * Everything here is what `contacts/[id]/page.tsx` and the timeline used to derive from the
 * full list, computed from a narrow aggregate instead of shipping every row's preview and
 * summary.
 */
export type InteractionHistorySummary = {
  total: number;
  /** interaction_type → rows, for the timeline's filter chips. */
  typeCounts: Record<string, number>;
  /** Rows that count as a touch (`isLoggedTouch`). */
  loggedCount: number;
  /** Newest logged touch's `interactionDate` — what `latestLoggedTouch` would find. */
  latestLoggedAt: Date | null;
  /**
   * Logged-touch dates (epoch ms) from a little before `formatInteractionFrequency`'s
   * window, which filters them again itself — so its answer is the one it would give the
   * full list.
   */
  recentLoggedTimes: number[];
};

async function loadInteractionHistorySummary(
  userId: string,
  contactId: string
): Promise<InteractionHistorySummary> {
  const db = await getDb();
  // A day wider than `formatInteractionFrequency`'s 90-day window: it re-applies its own
  // cutoff, so anything extra is dropped there, and nothing it would count is missing.
  const cutoff = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  const touch = countsAsTouch();
  const rows = await db
    .select({
      interactionType: interactions.interactionType,
      total: sql<number>`count(*)::int`,
      logged: sql<number>`(count(*) filter (where ${touch}))::int`,
      latestLogged: sql<Date | null>`max(${interactions.interactionDate}) filter (where ${touch})`.mapWith(
        interactions.interactionDate
      ),
      // Text, not an array or numbers: the same on every driver. floor() matches the ms
      // truncation a JS Date applies to a microsecond timestamp.
      recentLogged: sql<string | null>`string_agg(
        (floor(extract(epoch from ${interactions.interactionDate}) * 1000))::bigint::text, ','
      ) filter (where ${and(touch, gte(interactions.interactionDate, cutoff))})`,
    })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, contactId),
        // Same scope as the relational read: rows of a contact this account owns.
        inArray(
          interactions.contactId,
          db
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
        )
      )
    )
    .groupBy(interactions.interactionType);

  const summary: InteractionHistorySummary = {
    total: 0,
    typeCounts: {},
    loggedCount: 0,
    latestLoggedAt: null,
    recentLoggedTimes: [],
  };
  for (const r of rows) {
    const total = Number(r.total);
    summary.total += total;
    summary.typeCounts[r.interactionType] = total;
    summary.loggedCount += Number(r.logged);
    if (r.latestLogged && (!summary.latestLoggedAt || r.latestLogged > summary.latestLoggedAt)) {
      summary.latestLoggedAt = r.latestLogged;
    }
    if (r.recentLogged) {
      for (const t of r.recentLogged.split(",")) summary.recentLoggedTimes.push(Number(t));
    }
  }
  return summary;
}

/**
 * The profile page's read: the contact with the newest {@link PROFILE_INTERACTION_PAGE}
 * interactions instead of the whole history (each row carries a 600-character preview and
 * a summary, and a contact with an imported message thread has thousands), plus
 * `interactionHistory` — the whole-history aggregates — when there is more than that page.
 * `interactionHistory` is null when the rows ARE the whole history, so a contact with a
 * short history renders from exactly the rows it always did. Older rows reach the timeline
 * on demand through {@link listContactTimelineInteractions}.
 */
export const getContactForProfile = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, id: string) => {
    // One extra row says whether there is more without counting anything.
    const contact = await loadContactWithHistory(userId, id, PROFILE_INTERACTION_PAGE + 1);
    if (!contact) return null;
    if (contact.interactions.length <= PROFILE_INTERACTION_PAGE) {
      return { ...contact, interactionHistory: null };
    }
    const interactionHistory = await loadInteractionHistorySummary(userId, id);
    return {
      ...contact,
      interactions: contact.interactions.slice(0, PROFILE_INTERACTION_PAGE),
      interactionHistory,
    };
  }
);

/**
 * Every interaction of a contact, in the timeline's shape — what the profile timeline asks
 * for when someone reaches past the page it was rendered with ("Show N older", a deep link
 * to an older row, a filter whose rows are all older). Same columns and order as the
 * profile's own read; empty for a contact outside this account.
 */
export const listContactTimelineInteractions = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, contactId: string) => {
    const db = await getDb();
    const owned = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
      columns: { id: true },
      with: { interactions: timelineInteractionColumns() },
    });
    // The exact fields the profile page hands the timeline, so older rows render the same.
    return (owned?.interactions ?? []).map((i) => ({
      id: i.id,
      interactionType: i.interactionType,
      interactionDate: i.interactionDate,
      sameDayOrder: i.sameDayOrder,
      notesPreview: i.notesPreview,
      aiSummary: i.aiSummary,
    }));
  }
);

/**
 * These actions are callable from the browser, and a photo's provenance decides what it
 * displays over (`sharedAvatarUrlSql`), so only server-side writers may set it.
 */
function clientContactInput<T extends Partial<ContactInput>>(input: T): T {
  const { profileImageSource: _serverOnly, ...rest } = input;
  return rest as T;
}

/**
 * Create a contact from the manual "New contact" form (and any other single-record path).
 *
 * Goes through `resolveOrCreateContact` rather than straight to `createContactForUser`.
 * This path performed no duplicate check at all until now — the form would happily create a
 * second Ada Lovelace with the same LinkedIn URL as the first — which made hand entry the
 * easiest way in the whole product to create a duplicate.
 *
 * Returns the contact that survives, which is not always the one that was inserted: if the
 * record's identifiers already belonged to someone, the data is folded into them and their
 * row comes back instead.
 *
 * NO `options` PARAMETER, deliberately. These actions are public POST endpoints, and
 * `ContactWriteOptions` is a server-side contract: it carries `entitlements` and `headroom`
 * (the plan cap's inputs) and the `skip*` flags bulk paths use. Accepting it from the caller
 * let a browser POST `{ entitlements: { contactLimit: null } }` and add contacts past the
 * free plan's limit (audit H-01). Server callers that need options use the `*ForUser`
 * functions in `@/lib/contact-writes` directly.
 */
export const createContact = defineAction(
  { schema: z.tuple([ContactInputSchema]) },
  async (userId, input: ContactInput) => {
    const { contact } = await createContactDetailedFor(userId, input);
    return contact;
  }
);

/**
 * `createContact`, but it also tells you what actually happened.
 *
 * `resolveOrCreateContact` has always returned an `outcome` and `createContact` has
 * always thrown it away, so the form toasted "Contact created" even when the submission
 * had been folded into an existing person — silently replacing their company and role,
 * with the contact count unchanged and no way back. A caller with a human in front of it
 * needs to be able to say which of the two happened.
 *
 * Separate from `createContact` rather than a changed return type, so the outreach path
 * that only wants the row keeps working unchanged.
 */
export const createContactDetailed = defineAction(
  { schema: z.tuple([ContactInputSchema]) },
  async (userId, input: ContactInput) => createContactDetailedFor(userId, input)
);

/** The body both create actions share, so `createContact` resolves the caller once. */
async function createContactDetailedFor(userId: string, input: ContactInput) {
  const { contactId, outcome, reason } = await resolveOrCreateContact(
    userId,
    clientContactInput(input)
  );
  const db = await getDb();
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, contactId)))
    .limit(1);
  return { contact, outcome, reason: reason ?? null };
}

// `createContactsBulk` used to be exported here. Bulk creation is an importer concern and
// took a `CompanyResolver` (a function, which cannot cross the action boundary) plus the
// same server-only `options` — so it was never callable from a browser on purpose, yet an
// action id was still minted for it. Importers call `createContactsBulkForUser` directly.

export const updateContact = defineAction(
  { schema: z.tuple([uuid, ContactInputSchema.partial()]) },
  async (userId, id: string, input: Partial<ContactInput>) => {
    return updateContactForUser(userId, id, clientContactInput(input));
  }
);

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
export const rateContacts = defineAction(
  { schema: z.tuple([z.array(z.looseObject({ contactId: z.string(), closeness: anyNumber }))]) },
  async (userId, ratings: Array<{ contactId: string; closeness: number }>): Promise<{ updated: number; failedContactIds: string[] }> => {
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
);

export const deleteContact = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, id: string) => {
    await deleteContactForUser(userId, id);
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
  }
);

/**
 * Force a contact onto the constellation, off it, or back to the automatic rule.
 *
 * A direct update rather than `updateContactForUser`, which is the shared write path for
 * everything else on a contact. That path sets `embeddingStaleAt` unconditionally and calls
 * `scoreAfterWrite`, both correct for content changes and both wrong here: a pin is not part
 * of the embedded text (see `buildContactEmbeddingContent`), so routing through it would
 * enqueue a paid re-embed and dirty the closeness cohort for a value neither one reads.
 *
 * `updatedAt` is deliberately left alone for the same reason. The dashboard's contact scan
 * orders by `desc(updated_at)`, so bumping it would shove whoever you pinned to the top of
 * "recently updated" — a visible, confusing consequence of an invisible setting.
 *
 * Ownership lives in the WHERE clause, the house pattern: a row belonging to someone else
 * simply matches nothing.
 */
export const setConstellationPin = defineAction(
  { schema: z.tuple([uuid, z.enum(["in", "out"]).nullable()]) },
  async (userId, contactId: string, pin: "in" | "out" | null) => {
    const db = await getDb();
    await db
      .update(contacts)
      .set({ constellationPin: pin })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/graph");
    revalidatePath("/dashboard");
    return { pin };
  }
);

export const logInteraction = defineAction(
  { schema: z.tuple([LogInteractionInputSchema]) },
  async (userId, input: LogInteractionInput) => {
    return logInteractionForUser(userId, input);
  }
);

export const updateInteraction = defineAction(
  { schema: z.tuple([uuid, z.looseObject({ rawNotes: z.string().optional(), aiSummary: z.string().optional(), actionItems: z.array(z.string()).optional(), interactionType: z.string().optional(), interactionDate: z.union([z.string(), z.date()]).optional(), parseDateFromNotes: z.boolean().optional() })]) },
  async (userId, interactionId: string, input: {
      rawNotes?: string;
      aiSummary?: string;
      actionItems?: string[];
      interactionType?: string;
      interactionDate?: string | Date;
      parseDateFromNotes?: boolean;
    }) => {
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
        // Same cleaning as `logInteractionForUser` (audit M-05).
        ...(input.rawNotes !== undefined ? { rawNotes: cleanOptionalText(input.rawNotes, TEXT_LIMITS.rawNotes) } : {}),
        ...(input.aiSummary !== undefined ? { aiSummary: cleanOptionalText(input.aiSummary, TEXT_LIMITS.summary) } : {}),
        ...(input.actionItems !== undefined
          ? { actionItems: cleanTextList(input.actionItems, TEXT_LIMITS.listItem) }
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
    // The passages were built from the old text. The sweep would notice on its own (the source
    // hash is what makes an edited note claimable again), but not until the daily cron — and
    // "I just fixed that note" is exactly when someone asks about it.
    if (input.rawNotes !== undefined || input.aiSummary !== undefined || when) {
      await reindexInteractionPassages(userId, interactionId).catch((err) => {
        console.warn("[memory-chunks] could not re-index interaction", interactionId, err);
      });
    }
    void generateAndStoreContactBrief(userId, existing.contactId).catch(
      () => null
    );

    revalidatePath(`/contacts/${existing.contactId}`);
    revalidatePath("/dashboard");
    revalidatePath("/graph");
    return row;
  }
);

/** Persist manual order for interactions on the same calendar day (YYYY-MM-DD). */
export const reorderSameDayInteractions = defineAction(
  { schema: z.tuple([uuid, z.string(), z.array(z.string())]) },
  async (userId, contactId: string, dayIso: string, orderedIds: string[]) => {
    const db = await getDb();

    // Only the id and date are read — the day filter and the allow-list. Unprojected, this
    // shipped every note body the contact has (a whole imported LinkedIn thread) to reorder
    // one day's rows.
    const rows = await db.query.interactions.findMany({
      where: and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, contactId)
      ),
      columns: { id: true, interactionDate: true },
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
);

export const regenerateContactSummary = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, contactId: string) => {
    const out = await generateAndStoreContactBrief(userId, contactId, {
      force: true,
    });
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/graph");
    revalidatePath("/dashboard");
    return { summary: out?.summary ?? null, aiError: out?.aiError ?? null };
  }
);

export type LinkedInRefreshTarget = {
  id: string;
  fullName: string;
  email: string | null;
  linkedinUrl: string;
};

/** Contacts that have a LinkedIn URL and can be refreshed. */
export const listLinkedInRefreshTargets = defineAction(
  {},
  async (userId): Promise<{
    targets: LinkedInRefreshTarget[];
    hasApollo: boolean;
  }> => {
    const db = await getDb();
    const apiKey = await getApolloApiKey(userId);

    // Filtered in SQL rather than fetched-then-filtered: this used to pull every contact on
    // the account (indexed only by userId) just to throw away everyone without a LinkedIn
    // URL. `contacts_user_linkedin_idx` covers `(userId, linkedinUrl)`, so the predicate below
    // is served by the same index instead of a full account scan.
    const rows = await db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        sql`${contacts.linkedinUrl} is not null and btrim(${contacts.linkedinUrl}) <> ''`
      ),
      columns: {
        id: true,
        fullName: true,
        email: true,
        linkedinUrl: true,
      },
    });

    const targets = rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      email: r.email,
      linkedinUrl: r.linkedinUrl!.trim(),
    }));

    return { targets, hasApollo: Boolean(apiKey) };
  }
);

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
export const backfillContactAvatars = defineAction(
  { schema: z.tuple([AvatarBackfillOptionsSchema.optional()]) },
  async (userId, options: AvatarBackfillOptions = {}): Promise<AvatarBackfillResult> => {
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

    // Only worth hitting Google/Outlook/Apollo when this batch could actually use them —
    // most ticks are pure LinkedIn resolution and shouldn't pay for an unused lookup.
    const needsConnectedAccount = candidates.some((c) => c.email);
    const needsApollo = candidates.some((c) => c.linkedinUrl);

    /**
     * Each pre-flight lookup degrades on its own. These three sit outside the per-contact
     * try/catch inside the batch, so a bare `Promise.all` let one rejection — an expired
     * Google refresh token, an Outlook hiccup, a failed key read — throw the whole backfill,
     * and the route turned that into a 500 for a batch where Gravatar and Apollo would have
     * answered perfectly well. Every per-contact source below is already individually
     * guarded; this brings the batch-level ones in line.
     *
     * A failure is recorded rather than swallowed, because it changes what a miss MEANS: a
     * contact whose connected-account index never built did not run out of sources, so it is
     * deferred instead of cooldown-stamped (`sourcesUnavailable`).
     */
    const settled = await Promise.allSettled([
      needsConnectedAccount ? buildGooglePhotoIndex(userId) : Promise.resolve(new Map<string, string>()),
      needsConnectedAccount
        ? buildOutlookContactIndex(userId)
        : Promise.resolve(new Map<string, string>()),
      needsApollo ? getApolloApiKey(userId) : Promise.resolve(null),
    ]);
    const [googleSettled, outlookSettled, apolloSettled] = settled;
    for (const [name, outcome] of [
      ["google photo index", googleSettled],
      ["outlook contact index", outlookSettled],
      ["apollo key", apolloSettled],
    ] as const) {
      if (outcome.status === "rejected") {
        console.warn(`[avatars] ${name} unavailable for this batch — continuing without it`);
      }
    }
    const googlePhotoByEmail =
      googleSettled.status === "fulfilled" ? googleSettled.value : new Map<string, string>();
    const outlookContactIdByEmail =
      outlookSettled.status === "fulfilled" ? outlookSettled.value : new Map<string, string>();
    const apolloApiKey = apolloSettled.status === "fulfilled" ? apolloSettled.value : null;
    const sourcesUnavailable = {
      connectedAccount: googleSettled.status === "rejected" || outlookSettled.status === "rejected",
      apollo: apolloSettled.status === "rejected",
    };

    const resolveConnectedAccount = needsConnectedAccount
      ? async (contactId: string, email: string) => {
          const key = email.trim().toLowerCase();

          const googlePhoto = googlePhotoByEmail.get(key);
          if (googlePhoto) {
            const persisted = await downloadAndPersistAvatar(contactId, googlePhoto);
            if (persisted) return { url: persisted, source: "google" as const };
          }

          const outlookContactId = outlookContactIdByEmail.get(key);
          if (outlookContactId) {
            const photoDataUrl = await fetchOutlookContactPhoto(userId, outlookContactId);
            if (photoDataUrl) {
              const persisted = await downloadAndPersistAvatar(contactId, photoDataUrl);
              if (persisted) return { url: persisted, source: "outlook" as const };
            }
          }

          return null;
        }
      : undefined;

    const resolveApollo = apolloApiKey
      ? async (contactId: string, linkedinUrl: string): Promise<string | null> => {
          const photoUrl = await fetchApolloLinkedInPhoto(userId, linkedinUrl);
          if (!photoUrl) return null;
          return downloadAndPersistAvatar(contactId, photoUrl);
        }
      : undefined;

    const result = await traced(
      "contacts.backfillAvatars",
      () =>
        runAvatarBackfillBatch(candidates, {
          deadline: Date.now() + AVATAR_BACKFILL_BUDGET_MS,
          persistRemote: downloadAndPersistAvatar,
          resolveConnectedAccount,
          resolveLinkedIn: (contactId, url) => resolveLinkedInPhotoCached(contactId, url, userId),
          resolveGravatar: fetchGravatarPhotoUrl,
          resolveApollo,
          sourcesUnavailable,
          save: async (contactId, photoUrl, source) => {
            // `updatedAt` deliberately left alone, for the reason spelled out on
            // `setConstellationPin` below: the dashboard and /knowledge both order by
            // `desc(updated_at)`, and a background photo fetch is an invisible operation. A
            // fresh LinkedIn import would otherwise shove every contact it created to the top
            // of "recently updated" purely because their avatars downloaded.
            //
            // It is also load-bearing for revertible imports. `revertImport` asks "has the
            // user edited this contact since the import" by comparing `created_at` against
            // `updated_at`, and this ran on every page load against exactly the contacts an
            // import had just created — so an undo found them all "edited", deleted nothing,
            // and said so. The revert commit claimed this had been verified; the embedding
            // backfill had been, this had not.
            await db
              .update(contacts)
              .set({ profileImageUrl: photoUrl, ...(source ? { profileImageSource: source } : {}) })
              .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
          },
          markChecked: async (contactId) => {
            // Deliberately does NOT touch updatedAt: a failed photo lookup is not a
            // change to the contact, and bumping it would reorder the "recent" sort.
            await db
              .update(contacts)
              .set({ profileImageCheckedAt: new Date() })
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
);

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
export const lookupLinkedInProfile = defineAction(
  { schema: z.tuple([z.looseObject({ linkedinUrl: z.string(), fullName: z.string().optional(), email: z.string().optional() })]) },
  async (userId, input: {
    linkedinUrl: string;
    fullName?: string;
    email?: string;
  }): Promise<LinkedInProfileEnrichment | null> => {
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
);

/**
 * Refresh a batch of contacts from LinkedIn via Apollo people/match.
 * Updates role, company, location, school, and profile picture when found.
 */
export const refreshContactsFromLinkedIn = defineAction(
  { schema: z.tuple([z.array(uuid)]) },
  async (userId, contactIds: string[]) => {
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
        // Prefer Apollo photo when present; otherwise resolve via LinkedIn, whose photo lands
        // in the shared pool (the contact shows it from there) unless it has to be the
        // contact's own.
        let profileImageUrl: string | null = null;
        let profileImageSource: ProfileImageSource = "apollo";
        let sharedPhoto = false;
        if (profile?.profileImageUrl) {
          profileImageUrl = await downloadAndPersistAvatar(
            contact.id,
            profile.profileImageUrl
          );
        }
        if (!profileImageUrl && contact.linkedinUrl) {
          try {
            const linkedIn = await resolveLinkedInPhotoCached(
              contact.id,
              contact.linkedinUrl,
              userId
            );
            if (typeof linkedIn === "string") {
              profileImageUrl = linkedIn;
              profileImageSource = "public";
            } else {
              sharedPhoto = linkedIn !== null;
            }
          } catch (err) {
            if (err instanceof AvatarSourceRateLimitError) {
              rateLimited = true;
              unmatched += 1;
              continue;
            }
            throw err;
          }
        }

        if (!profile) {
          if (profileImageUrl) {
            await updateContactForUser(
              userId,
              contact.id,
              { profileImageUrl, profileImageSource },
              { skipRevalidate: true }
            );
            await deleteReplacedAvatar(contact.profileImageUrl, profileImageUrl);
            refreshed += 1;
          } else if (sharedPhoto) {
            refreshed += 1;
          } else {
            unmatched += 1;
          }
          continue;
        }

        await updateContactForUser(
          userId,
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
            ...(profileImageUrl ? { profileImageUrl, profileImageSource } : {}),
          },
          { skipRevalidate: true }
        );
        if (profileImageUrl) await deleteReplacedAvatar(contact.profileImageUrl, profileImageUrl);

        refreshed += 1;
      } catch {
        failed += 1;
      }
    }

    // Work history comes from a web search on the person's own AI key, not from Apollo, and
    // in its own function: a few searches outlast this request. The route skips anyone with a
    // recent history, so a repeated refresh does not search again.
    await kickWorkHistoryResearch(
      userId,
      ordered.map((c) => c.id)
    );

    revalidatePath("/contacts");
    revalidatePath("/");
    revalidatePath("/graph");

    return { refreshed, unmatched, failed, avatarOnly, rateLimited };
  }
);

/** Draft a warm follow-up message from the contact profile. */
export const draftContactFollowUp = defineAction(
  { schema: z.tuple([uuid, z.looseObject({ channel: z.enum(["email", "linkedin", "sms"]).optional(), intent: z.string().optional(), reuse: z.boolean().optional() }).optional()]), invalid: failResult },
  async (userId, contactId: string, options?: {
      channel?: "email" | "linkedin" | "sms";
      intent?: string;
      /** The draft already written for this exact context, if any (see `draftFromContext`). */
      reuse?: boolean;
    }) => {
    const goals = await listActiveGoalTexts();
    const writingInstructions = await loadWritingInstructions(userId);
    return draftFollowUpResult(userId, contactId, goals, { ...options, writingInstructions });
  }
);

export type ContactFollowUpSendOptions = {
  canSendEmail: boolean;
  /** Why email can't be sent from Orbit right now, or null when it can. */
  sendBlock: SendBlockReason | "cap_reached" | null;
  /** The mailbox to fix when `sendBlock` names one (null: nothing connected yet). */
  sendBlockProvider: MailboxId | null;
  /** Whether "Connect Outlook" may be offered alongside Gmail. */
  outlookAvailable: boolean;
  hasEmail: boolean;
  hasLinkedIn: boolean;
  email: string | null;
  linkedinUrl: string | null;
};

/** Whether this contact can be emailed from the user's own mailbox right now. */
export const getContactFollowUpSendOptions = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, contactId: string): Promise<ContactFollowUpSendOptions> => {
    const db = await getDb();
    // The capability needs nothing from the contact, so both reads start together. The
    // not-found check still comes first; a capability failure only surfaces after it.
    const capabilityRead = settle(getSendCapability(userId));
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
      columns: {
        email: true,
        linkedinUrl: true,
      },
    });
    if (!contact) throw new Error("Contact not found");

    const capability = unwrap(await capabilityRead);
    const email = contact.email?.trim() || null;
    const linkedinUrl = contact.linkedinUrl?.trim() || null;

    return {
      hasEmail: Boolean(email),
      hasLinkedIn: Boolean(linkedinUrl),
      email,
      linkedinUrl,
      canSendEmail: Boolean(email && capability.ok),
      sendBlock: capability.ok ? null : capability.reason,
      sendBlockProvider: capability.ok ? null : capability.provider,
      outlookAvailable: capability.outlookAvailable,
    };
  }
);

export type FollowUpSendResult =
  | { ok: true; sendId: string; sendAt: string; to: string }
  | { ok: false; reason: EnqueueRefusal | "no_email"; message: string };

/**
 * Queue a follow-up email from the user's own mailbox. It goes out after the undo window,
 * and the follow-up clears only once it has (see `origin-hooks/follow-up.ts`).
 */
export const sendContactFollowUpEmail = defineAction(
  { schema: z.tuple([uuid, z.string(), z.string().optional()]) },
  async (userId, contactId: string, body: string, subject?: string): Promise<FollowUpSendResult> => {
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
    if (!contact.email?.trim()) {
      return { ok: false, reason: "no_email", message: "Add an email address for this contact first." };
    }

    const name = contact.preferredName || contact.fullName;
    const profile = await getCurrentUserProfile().catch(() => null);
    const queued = await enqueueEmail(userId, {
      to: [contact.email.trim()],
      subject: subject?.trim() || `Following up · ${name}`,
      bodyText: body,
      fromName: profile?.name?.trim() || null,
      origin: "follow_up",
      originRef: contactId,
      contactIds: [contactId],
      delayMs: UNDO_DELAY_MS,
    });
    if (!queued.ok) return queued;
    scheduleDispatch(queued.id, queued.sendAt);
    return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to[0]! };
  }
);

// The related-contacts SQL lives in two IMMUTABLE functions defined with the schema
// (`RELATED_CORPUS_FUNCTIONS` in src/db/index.ts) so that it can be indexed:
//   - orbit_related_corpus(ai_summary, notes, key_facts, shared_interests): the corpus the
//     mention prefilter LIKEs, lowered with RELATED_SQL_LOWER. A jsonb string array becomes
//     its elements joined by spaces ('' when it is not an array); null elements drop out,
//     which only removes text the JS corpus renders as "".
//   - orbit_unusual_json_array(jsonb): true when the column is anything but NULL / JSON null
//     / an array of strings (and nulls). JS spreads a string into characters, stringifies
//     numbers its own way and throws on an object, so such a row always gets its wide text
//     fetched and goes through the JS scoring exactly as it used to.

/**
 * Contacts related by company, school, howMet, mentions, tags, or interests.
 *
 * This used to `findMany` the user's whole contact table plus every contact's tags, on
 * every single contact-profile view (hover prefetches included) — the widest, most
 * frequently-hit full-network scan in the app: it pulled `notes`, `aiSummary` and
 * `keyFacts` for every contact just to score six.
 *
 * `bestReason()` in `findRelatedContacts` needs, per candidate: the narrow fields it
 * compares directly (name, company, companyId, school, howMet, sharedInterests,
 * relationshipScore), whether the candidate shares at least two tags with the source, and
 * the free-text corpus — but the corpus only for two questions:
 *   1. "does the candidate's text mention the source?" (the source's text mentioning the
 *      candidate needs only the candidate's NAME), and
 *   2. the goal-token boost, which only applies to a candidate that already has a reason.
 *
 * So, in three steps:
 *   - Round 1 (parallel): the source row whole; goals; the source's tags and the bounded
 *     `GROUP BY … HAVING count(*) >= 2` tags aggregate.
 *   - Round 2: one pass over the account in SQL that keeps only the rows that could earn a
 *     reason (superset prefilters on the narrow columns, plus the indexed mention and
 *     unusual-jsonb arms), with the wide text for the rows that could need it — every row
 *     whose text might mention the source (`mentionLikePatterns`, whose comment proves it
 *     never misses a row the JS test would match), plus, only when the user has active
 *     goals, every candidate.
 *   - Round 3: the display columns for the winners only.
 *
 * The result is exactly what scoring every contact's full text produced: a row left out
 * has no reason (each prefilter is a superset of its JS test), a row left without its
 * text cannot be mentioned-by (the prefilter would have caught it), a mention found in
 * its remaining corpus (`sharedInterests`) is also in its full corpus, and every row that
 * can earn a goal boost has its full text. `scripts/smoke-related-contacts-parity.ts`
 * checks this against the old full-text scoring on adversarial data.
 */
export const listRelatedContacts = defineAction(
  { schema: z.tuple([uuid, anyNumber.optional()]) },
  async (userId, contactId: string, limit: number = 6): Promise<RelatedContact[]> => {
    const db = await getDb();
    // Goals and the narrow scan need nothing from each other, so they start together; their
    // outcomes are taken in the old order (a goals failure still surfaces first). The
    // ForUser variant is what `listActiveGoalTexts()` calls after its own `requireUserId()`,
    // which this function has just done — in a Server Action that repeat is not deduped.
    const goalsRead = settle(listActiveGoalTextsForUser(userId));
    // The source itself, whole: its narrow columns decide which other contacts can be
    // related at all, and its text is the corpus their names are looked for in. Scoped to
    // the caller's account, so a contact outside it reads as nothing.
    const sourceRead = settle(
      db.query.contacts.findFirst({
        where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
        columns: {
          id: true,
          fullName: true,
          preferredName: true,
          company: true,
          companyId: true,
          school: true,
          howMet: true,
          sharedInterests: true,
          relationshipScore: true,
          notes: true,
          aiSummary: true,
          keyFacts: true,
        },
      })
    );
    // The two tag reads start alongside the source read. Scoping them to the caller's account
    // in SQL makes them safe to start first — for a contact outside this account both return
    // nothing — and they are only consumed after the ownership gate below.
    //
    // Tags share is the one reason findRelatedContacts needs that isn't in the narrow scan.
    // Answered as a bounded aggregate over the join table rather than hydrating every
    // contact's tag list: only contacts sharing >=2 tags with the source can ever produce a
    // "sharedTags" match, and HAVING keeps the result set to that size, not the account size.
    // The source's tag ids ride along as a subquery, so the count no longer waits on them.
    const sourceTagsRead = settle(
      db
        .select({ tagId: contactTags.tagId })
        .from(contactTags)
        .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
        .where(and(eq(contactTags.contactId, contactId), eq(contacts.userId, userId)))
    );
    const sharedCountsRead = settle(
      db
        .select({ contactId: contactTags.contactId, shared: sql<number>`count(*)` })
        .from(contactTags)
        .where(
          and(
            sql`${contactTags.tagId} in (
              select ct.tag_id from contact_tags ct join contacts c on c.id = ct.contact_id
               where ct.contact_id = ${contactId}::uuid and c.user_id = ${userId}
            )`,
            sql`${contactTags.contactId} <> ${contactId}::uuid`
          )
        )
        .groupBy(contactTags.contactId)
        .having(sql`count(*) >= 2`)
    );
    const goals = unwrap(await goalsRead);
    // Ownership gate: nothing below (the source's tag ids included) is used for a contact
    // outside this account.
    const sourceRow = unwrap(await sourceRead);
    if (!sourceRow) return [];

    const sourceTagIds = unwrap(await sourceTagsRead).map((r) => r.tagId);
    // Empty when the source has no tags — the subquery matches nothing — as it always was.
    const sharedTagCounts = unwrap(await sharedCountsRead);
    const sharesTwoTags = new Set(sharedTagCounts.map((r) => r.contactId));

    // Which contacts to score. Scoring used to read every contact's narrow columns (100k
    // rows at 100k contacts, most of a profile's 2.9 s); now SQL keeps the rows that could
    // earn a reason, as superset prefilters (`relatedCandidateFilter`), and JS still decides
    // exactly. A candidate can be related by:
    //   - its text mentioning the source: the trigram-indexed corpus arm (`mentionLikePatterns`);
    //   - the source's text mentioning its name: any alias found there contains the name's
    //     last whitespace-free run (split on exactly JS's whitespace), so that run is looked
    //     for in the source's corpus;
    //   - company id, company, howMet, school, two shared tags, or a shared interest.
    // Rows whose jsonb is not an array of strings are always kept, as is the source.
    const filter = relatedCandidateFilter(sourceRow);
    const patterns = mentionLikePatterns(nameAliases(sourceRow));
    // `RELATED_SQL_LOWER`, cheaply: `lower()` under the "C" collation lowers A-Z and nothing
    // else, which is the `translate()`; the two `replace`s are its KELVIN SIGN and the U+0130
    // step. Through `orbit_related_corpus`, or with `translate()`, this one pass over the
    // account cost 1.8 s at 100k contacts on Postgres 16; this way it is ~0.3 s.
    const lowered = relatedSqlLower;
    const unusual = sql`(orbit_unusual_json_array(c.key_facts) or orbit_unusual_json_array(c.shared_interests))`;
    const mentionsSource = patterns.length
      ? sql`orbit_related_corpus(c.ai_summary, c.notes, c.key_facts, c.shared_interests)
              like any (array[${sql.join(patterns.map((p) => sql`${p}::text`), sql`, `)}])`
      : sql`false`;
    const likeAny = (value: SQL, bodies: string[]) =>
      sql`${value} like any (array[${sql.join(bodies.map((p) => sql`${p}::text`), sql`, `)}])`;
    // Anything but ASCII other than `%`, `\` and `_` becomes a `_` in a LIKE body.
    const notPlainAscii = "[^\\x01-\\x24\\x26-\\x5b\\x5d\\x5e\\x60-\\x7f]";
    const corpus = filter?.corpus ?? "";
    /**
     * A name's last whitespace-free run, lowered, found in the source's corpus. An all-ASCII
     * name (`octet_length = char_length`, the common case) needs only `lower()` and the ASCII
     * whitespace, and its run is looked for literally; each branch computes the run once.
     */
    const nameInCorpus = (column: SQL) => {
      const lastRun = (low: SQL, whitespace: string, spaces: string) =>
        sql`split_part(rtrim(translate(${low}, ${whitespace}, ${spaces}), ' '), ' ', -1)`;
      return sql`(case when octet_length(${column}) = char_length(${column})
                    then strpos(${corpus}::text, ${lastRun(sql`lower(${column} collate "C")`, "\t\n\v\f\r", "     ")}) > 0
                    else ${corpus}::text like '%' || regexp_replace(
                      ${lastRun(lowered(column), JS_WHITESPACE, JS_WHITESPACE_AS_SPACES)}, ${notPlainAscii}, '_', 'g') || '%' end)`;
    };
    const interestArm = (interests: string[]) => {
      const asText = interests.map(interestTextPattern);
      if (asText.every((p): p is string => p !== null)) {
        return sql`(jsonb_typeof(c.shared_interests) = 'array' and ${likeAny(lowered(sql`c.shared_interests::text`), asText)})`;
      }
      return sql`(jsonb_typeof(c.shared_interests) = 'array' and exists (
        select 1 from jsonb_array_elements_text(c.shared_interests) as si(v)
         where ${likeAny(lowered(sql`si.v`), interests.map((t) => `%${likeBody(t)}%`))}))`;
    };
    // Cheap tests on narrow columns, one pass over the account's rows.
    const narrowArms: SQL[] = filter
      ? [
          sql`c.id = ${contactId}::uuid`,
          ...(filter.companyId ? [sql`c.company_id = ${filter.companyId}::uuid`] : []),
          ...(filter.company ? [sql`${lowered(sql`c.company`)} like ${filter.company}`] : []),
          ...(filter.howMet ? [sql`${lowered(sql`c.how_met`)} like ${filter.howMet}`] : []),
          ...(filter.school ? [sql`${lowered(sql`c.school`)} like ${filter.school}`] : []),
          ...(sharesTwoTags.size > 0 ? [inArray(sql`c.id`, [...sharesTwoTags])] : []),
          ...(filter.interests ? [interestArm(filter.interests)] : []),
          ...(corpus.trim() ? [nameInCorpus(sql`c.full_name`), nameInCorpus(sql`c.preferred_name`)] : []),
        ]
      : [sql`true`];

    // The rows that get their wide text (and are always candidates): a row whose text might
    // mention the source, and a row whose jsonb is unusual. Each is its own index scan
    // (`contacts_related_corpus_trgm`, `contacts_unusual_json_idx`); folded into the pass
    // above, the corpus test would detoast every row's notes again. When goals are active
    // every candidate gets its text, since a goal boost reads the text of any row with a
    // reason. More text than needed never changes the outcome: the old scoring read every row's.
    const textArms = [
      sql`select c.id from contacts c where c.user_id = ${userId} and ${unusual}`,
      ...(patterns.length ? [sql`select c.id from contacts c where c.user_id = ${userId} and ${mentionsSource}`] : []),
    ];
    const hasText = goals.length > 0 ? sql`true` : sql`c.id in (select id from wide)`;
    const candidateRows = rowsOf<{
      id: string;
      full_name: string;
      preferred_name: string | null;
      company: string | null;
      company_id: string | null;
      school: string | null;
      how_met: string | null;
      shared_interests: string[] | null;
      relationship_score: number | null;
      notes: string | null;
      ai_summary: string | null;
      key_facts: string[] | null;
      has_text: boolean;
    }>(
      await db.execute(sql`
        with wide as (${sql.join(textArms, sql` union `)})
        select c.id, c.full_name, c.preferred_name, c.company, c.company_id, c.school, c.how_met,
               c.shared_interests, c.relationship_score, ${hasText} as has_text,
               case when ${hasText} then c.notes end as notes,
               case when ${hasText} then c.ai_summary end as ai_summary,
               case when ${hasText} then c.key_facts end as key_facts
          from contacts c
         where c.user_id = ${userId}
           and (c.id in (select id from wide) or ${sql.join(narrowArms, sql` or `)})
      `)
    );

    type Candidate = RelatedContactCandidate & { tags: string[] };
    // A placeholder, not a real tag list: `bestReason` only ever compares the source's own
    // `tags` against a candidate's `tagSet` (never the reverse), via
    // `sharedCountFromSignals(...) >= 2`. So the source needs a two-element placeholder
    // whenever it has any tags at all, and each *other* contact needs the same placeholder
    // exactly when the aggregate above found it shares >= 2 real tags with the source.
    const placeholderTags = (id: string) =>
      (id === contactId ? sourceTagIds.length > 0 : sharesTwoTags.has(id)) ? ["__shared__", "__shared__"] : [];
    const candidates: Candidate[] = candidateRows.map((r) =>
      r.id === contactId
        ? { ...sourceRow, tags: placeholderTags(r.id) }
        : {
            id: r.id,
            fullName: r.full_name,
            preferredName: r.preferred_name,
            company: r.company,
            companyId: r.company_id,
            school: r.school,
            howMet: r.how_met,
            sharedInterests: r.shared_interests,
            relationshipScore: r.relationship_score,
            ...(r.has_text ? { notes: r.notes, aiSummary: r.ai_summary, keyFacts: r.key_facts } : {}),
            tags: placeholderTags(r.id),
          }
    );
    // The source is always a candidate (its own arm); this only guards a row that vanished
    // between the two reads.
    if (!candidates.some((c) => c.id === contactId)) return [];

    const ranked = findRelatedContacts(contactId, candidates, limit, goals);
    if (ranked.length === 0) return ranked;

    // The scans above never selected the display columns the card actually renders (avatar,
    // title, location, contact links, the summary) — fetch those only for the handful that
    // won, by id, rather than for every contact that was scored. `aiSummary` is here because
    // a winner whose text round 2 did not need still has to carry its real summary.
    const displayRows = await db.query.contacts.findMany({
      where: inArray(
        contacts.id,
        ranked.map((r) => r.id)
      ),
      columns: {
        id: true,
        firstName: true,
        title: true,
        location: true,
        linkedinUrl: true,
        email: true,
        phone: true,
        aiSummary: true,
      },
      // The browser-safe avatar URL, not the stored value: an inline photo is up to ~120 KB of
      // base64, and six of them rode inside every profile's payload (and every prefetch of it)
      // only for `ContactAvatar` to render `/api/avatars/{id}` for them anyway. It maps every
      // stored value to what that component draws for it — see `clientAvatarUrlSql`.
      extras: { profileImageUrl: clientAvatarUrlSql.as("profile_image_url") },
    });
    const displayById = new Map(displayRows.map((r) => [r.id, r]));
    return ranked.map((r) => ({ ...r, ...(displayById.get(r.id) ?? {}) }));
  }
);

/** Lightweight contact payload for the floating ask bar person chip. */
export const getAskBarContact = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, contactId: string): Promise<{
    id: string;
    displayName: string;
    firstName: string | null;
    fullName: string;
    profileImageUrl: string | null;
    linkedinUrl: string | null;
  } | null> => {
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
      extras: { sharedAvatarUrl: sharedAvatarUrlSql.as("shared_avatar_url") },
    });
    if (!contact) return null;
    return {
      id: contact.id,
      displayName: contact.preferredName || contact.fullName,
      firstName: contact.firstName,
      fullName: contact.fullName,
      profileImageUrl: contact.sharedAvatarUrl ?? contact.profileImageUrl,
      linkedinUrl: contact.linkedinUrl,
    };
  }
);

/**
 * Everything the interaction detail sheet shows, fetched when the sheet opens rather than
 * loaded with the profile — the timeline can hold hundreds of interactions and only one is
 * ever open at a time.
 */
export const getInteractionDetail = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, interactionId: string) => {
    const db = await getDb();

    const row = await db.query.interactions.findFirst({
      where: and(
        eq(interactions.id, interactionId),
        eq(interactions.userId, userId)
      ),
    });
    if (!row) throw new Error("Interaction not found");

    const [items, mentioned, batch] = await Promise.all([
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
      // The call-level digest of a recorded meeting, which no per-person row can carry: one
      // meeting produces one interaction per participant, each summarised for THAT person,
      // and the summary of the meeting itself only ever lived in `note_batches.result`.
      //
      // Scoped by user as well as by id. `interactions.note_batch_id` is a plain column with
      // no foreign key, so it is not self-evidently this caller's batch.
      row.noteBatchId
        ? db.query.noteBatches.findFirst({
            where: and(eq(noteBatches.id, row.noteBatchId), eq(noteBatches.userId, userId)),
            columns: { id: true, result: true },
          })
        : Promise.resolve(undefined),
    ]);

    const meeting = batch?.result?.meeting ?? null;

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
      /**
       * The capture this interaction came from, when it came from one.
       *
       * `batchId` is set for every captured interaction and is the link to the full results
       * page. `meeting` is set only for a recorded meeting, and carries the parts that belong
       * to the CALL rather than to any one person — what it was called, what it was about,
       * and what was decided.
       *
       * A meeting saved with zero participants creates no `interactions` row at all (the
       * contact FK is `NOT NULL`), so `/capture/[batchId]` remains its only home. That is a
       * deliberate limit, not an oversight: the alternative is inventing a contact to hang it
       * on.
       */
      batchId: row.noteBatchId,
      meeting: meeting
        ? {
            title: meeting.title,
            summary: meeting.summary,
            decisions: meeting.decisions ?? [],
          }
        : null,
    };
  }
);

export type InteractionDetail = Awaited<ReturnType<typeof getInteractionDetail>>;

/**
 * Re-extract the summary, topics and action items for one interaction from its own notes.
 *
 * `syncActionItems` diffs by hash, so items the user already ticked off keep their completed
 * state instead of coming back as fresh open ones.
 */
export const resummarizeInteraction = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, interactionId: string) => {
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
    // A rewritten summary is a rewritten note as far as passage search is concerned: for a row
    // with no `raw_notes`, `ai_summary` IS what was indexed.
    await reindexInteractionPassages(userId, interactionId).catch((err) => {
      console.warn("[memory-chunks] could not re-index interaction", interactionId, err);
    });
    void generateAndStoreContactBrief(userId, existing.contactId).catch(() => null);

    revalidatePath(`/contacts/${existing.contactId}`);
    revalidatePath("/dashboard");
    return row;
  }
);

export const deleteInteraction = defineAction(
  { schema: z.tuple([uuid]) },
  async (userId, interactionId: string) => {
    return deleteInteractionForUser(userId, interactionId);
  }
);
