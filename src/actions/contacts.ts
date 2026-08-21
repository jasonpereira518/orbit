"use server";

import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, interactions, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { isPaywallError } from "@/lib/entitlements";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { listActiveGoalTexts } from "@/actions/goals";
import { type CompanyResolver } from "@/lib/companies";
import {
  createContactForUser,
  createContactsBulkForUser,
  logInteractionForUser,
  updateContactForUser,
  type ContactInput,
  type ContactWriteOptions,
  type LogInteractionInput,
} from "@/lib/contact-writes";
import { generateAndStorePersonSummary } from "@/lib/person-summary";
import { rebuildContactEmbedding } from "@/lib/search";
import {
  enrichPeopleFromLinkedIn,
  getApolloApiKey,
  type LinkedInProfileEnrichment,
} from "@/lib/apollo";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import {
  AVATAR_BACKFILL_BATCH_SIZE,
  AvatarStorageError,
  downloadAndPersistAvatar,
  fetchLinkedInPhotoUrl,
  isUnusableAvatarUrl,
  MicrolinkRateLimitError,
} from "@/lib/contact-avatar";
import {
  clientContactAvatarUrl,
  isDurableAvatarUrl,
} from "@/lib/contact-avatar-url";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
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

export async function listContacts(filters?: {
  q?: string;
  company?: string;
  minScore?: number;
  followUp?: "due";
}) {
  const userId = await requireUserId();
  const db = await getDb();

  // Promise.resolve pins a single execution: a drizzle query builder is a lazy
  // thenable that re-runs on every await, so handing the bare builder to the
  // cohort would quietly issue the same scan twice.
  const contactRowsPromise = Promise.resolve(
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        userId: true,
        fullName: true,
        firstName: true,
        lastName: true,
        preferredName: true,
        company: true,
        title: true,
        location: true,
        school: true,
        email: true,
        phone: true,
        linkedinUrl: true,
        website: true,
        // Omit raw profileImageUrl blob — rewritten via clientContactAvatarUrl.
        profileImageUrl: true,
        relationshipScore: true,
        priorityLevel: true,
        source: true,
        industry: true,
        metContext: true,
        dateMet: true,
        howMet: true,
        // Heavy text fields not needed for list UI — keep short summary only.
        notes: false,
        aiSummary: true,
        keyFacts: true,
        sharedInterests: true,
        nextFollowUpAt: true,
        lastInteractionAt: true,
        createdAt: true,
        updatedAt: true,
      },
      with: { contactTags: { with: { tag: true } } },
      orderBy: [desc(contacts.updatedAt)],
    })
  );

  const [allRows, closenessCohort] = await Promise.all([
    contactRowsPromise,
    // Donates the scan above rather than repeating it.
    getClosenessCohort(userId, contactRowsPromise),
  ]);

  let rows = allRows;

  if (filters?.q?.trim()) {
    const q = filters.q.trim().toLowerCase();
    rows = rows.filter((c) =>
      [
        c.fullName,
        c.preferredName,
        c.company,
        c.title,
        c.location,
        c.school,
        c.email,
        c.phone,
        c.location,
        c.metContext,
        c.howMet,
        c.website,
        c.aiSummary,
        // notes intentionally excluded — no longer selected (payload slimming);
        // list search matches the AI summary instead of raw note text.
      ]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q))
    );
  }
  if (filters?.company?.trim()) {
    rows = rows.filter(
      (c) =>
        (c.company || "").toLowerCase() === filters.company!.trim().toLowerCase()
    );
  }
  if (filters?.minScore) {
    rows = rows.filter((c) => c.relationshipScore >= filters.minScore!);
  }
  if (filters?.followUp === "due") {
    const now = new Date();
    rows = rows.filter(
      (c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now
    );
  }

  const mapped = rows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    // Scored against the whole orbit, not this filtered page — a search result
    // must not change how close someone is.
    const closeness = closenessCohort.byId.get(c.id);
    return {
      ...c,
      // Never ship base64 data URLs in list payloads.
      profileImageUrl: clientContactAvatarUrl(c.id, c.profileImageUrl),
      tags,
      closeness: closeness?.closeness ?? 0,
      closenessTier: closeness?.tier ?? ("outer" as const),
      orbitScore: closeness?.orbitScore ?? 1,
    };
  });

  mapped.sort((a, b) => {
    const aLast = lastNameSortKey(a.lastName, a.fullName);
    const bLast = lastNameSortKey(b.lastName, b.fullName);
    const byLast = aLast.localeCompare(bLast, undefined, { sensitivity: "base" });
    if (byLast !== 0) return byLast;
    return a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" });
  });

  return mapped;
}

function lastNameSortKey(lastName: string | null | undefined, fullName: string) {
  const fromField = lastName?.trim();
  if (fromField) return fromField.toLocaleLowerCase();
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const inferred = parts.length > 1 ? parts[parts.length - 1]! : parts[0] || "";
  return inferred.toLocaleLowerCase();
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
      reminders: { orderBy: [desc(reminders.createdAt)] },
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

  await rebuildContactEmbedding(userId, existing.contactId);
  void generateAndStorePersonSummary(userId, existing.contactId).catch(
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
  const summary = await generateAndStorePersonSummary(userId, contactId, {
    force: true,
  });
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  revalidatePath("/dashboard");
  return { summary };
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
  const skip = new Set(options.skipIds ?? []);
  const db = await getDb();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      linkedinUrl: true,
      profileImageUrl: true,
    },
  });

  const needsWork = rows
    .filter((r) => {
      if (skip.has(r.id)) return false;
      const linkedin = r.linkedinUrl?.trim();
      const stored = r.profileImageUrl?.trim() || "";
      if (!linkedin && (!stored || isUnusableAvatarUrl(stored))) return false;
      // Need LinkedIn resolution when missing/unusable.
      if (linkedin && isUnusableAvatarUrl(stored)) return true;
      // Also durably cache remote URLs that aren't in Blob storage yet.
      if (
        stored &&
        !isUnusableAvatarUrl(stored) &&
        !isDurableAvatarUrl(stored)
      ) {
        return true;
      }
      return false;
    })
    // Prefer free remote→Blob caching work before spending Microlink quota.
    .sort((a, b) => {
      const aRemote =
        Boolean(a.profileImageUrl?.trim()) &&
        !isUnusableAvatarUrl(a.profileImageUrl) &&
        !isDurableAvatarUrl(a.profileImageUrl)
          ? 0
          : 1;
      const bRemote =
        Boolean(b.profileImageUrl?.trim()) &&
        !isUnusableAvatarUrl(b.profileImageUrl) &&
        !isDurableAvatarUrl(b.profileImageUrl)
          ? 0
          : 1;
      return aRemote - bRemote;
    });

  if (needsWork.length === 0) {
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

  let saved = 0;
  const savedIds: string[] = [];
  const failedIds: string[] = [];
  let failed = 0;
  let rateLimitedUntil: number | null = null;
  let storageError: string | null = null;
  const batch = needsWork.slice(0, batchSize);

  for (const contact of batch) {
    const stored = contact.profileImageUrl?.trim() || "";
    try {
      let photoUrl: string | null = null;

      if (stored && !isUnusableAvatarUrl(stored) && !isDurableAvatarUrl(stored)) {
        photoUrl = await downloadAndPersistAvatar(contact.id, stored);
      }

      if (!photoUrl && contact.linkedinUrl?.trim()) {
        try {
          photoUrl = await fetchLinkedInPhotoUrl(contact.id, contact.linkedinUrl);
        } catch (err) {
          if (err instanceof MicrolinkRateLimitError) {
            rateLimitedUntil = err.resetAt;
            // Unavatar was already tried inside fetchLinkedInPhotoUrl.
            failed += 1;
            continue;
          }
          throw err;
        }
      }

      if (!photoUrl) {
        failed += 1;
        failedIds.push(contact.id);
        continue;
      }

      await db
        .update(contacts)
        .set({ profileImageUrl: photoUrl, updatedAt: new Date() })
        .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));
      saved += 1;
      savedIds.push(contact.id);
    } catch (err) {
      if (err instanceof MicrolinkRateLimitError) {
        rateLimitedUntil = err.resetAt;
        break;
      }
      if (err instanceof AvatarStorageError) {
        // Every remaining contact would fail the same way — stop the run.
        storageError = err.message;
        break;
      }
      failed += 1;
      failedIds.push(contact.id);
    }
  }

  const pending = Math.max(0, needsWork.length - saved - failedIds.length);
  if (saved > 0) {
    revalidatePath("/contacts");
    revalidatePath("/");
    revalidatePath("/graph");
  }

  return {
    saved,
    savedIds,
    failedIds,
    pending,
    failed,
    rateLimitedUntil,
    storageError,
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

export type MutualContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  firstName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  mutualCount: number;
};

function extractLinkedinSlug(url: string | null | undefined): string | null {
  const t = url?.trim();
  if (!t) return null;
  const match = t.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Mutuals for a specific contact `contactId` (belonging to the signed-in user):
 * for each other account, count how many of the signed-in user's contacts
 * overlap with that other account's contacts, given that other account also
 * has the profile contact (matched by contact id and/or LinkedIn slug).
 *
 * Returns only the signed-in user's contacts (so we never expose other users).
 */
export async function listMutualContacts(
  contactId: string,
  limit = 6
): Promise<MutualContact[]> {
  const userId = await requireUserId();
  const db = await getDb();

  const viewerContact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      firstName: true,
      title: true,
      company: true,
      school: true,
      location: true,
      profileImageUrl: true,
      linkedinUrl: true,
      email: true,
      phone: true,
    },
  });

  if (!viewerContact) return [];

  const profileLinkedinSlug = extractLinkedinSlug(viewerContact.linkedinUrl);
  // If we can't match this contact identity across accounts, return nothing.
  if (!profileLinkedinSlug) return [];

  const viewerContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      firstName: true,
      title: true,
      company: true,
      school: true,
      location: true,
      profileImageUrl: true,
      linkedinUrl: true,
      email: true,
      phone: true,
    },
  });

  // Map "identity key" => viewer contact ids.
  // We can have duplicates in rare cases (e.g. if the same LinkedIn URL was
  // imported twice), so keep arrays.
  const viewerKeyToIds = new Map<string, string[]>();
  const viewerById = new Map<string, MutualContact>();

  for (const c of viewerContacts) {
    const linkedinSlug = extractLinkedinSlug(c.linkedinUrl);

    if (c.id) {
      viewerById.set(c.id, {
        id: c.id,
        fullName: c.fullName,
        preferredName: c.preferredName ?? null,
        firstName: c.firstName ?? null,
        title: c.title ?? null,
        company: c.company ?? null,
        school: c.school ?? null,
        location: c.location ?? null,
        profileImageUrl: c.profileImageUrl ?? null,
        linkedinUrl: c.linkedinUrl ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        mutualCount: 0, // filled later
      });
    }

    const keys: string[] = [`i:${c.id}`];
    if (linkedinSlug) keys.push(`l:${linkedinSlug}`);

    for (const key of keys) {
      const existing = viewerKeyToIds.get(key);
      if (existing) existing.push(c.id);
      else viewerKeyToIds.set(key, [c.id]);
    }
  }

  const profileKeys = new Set<string>([`i:${viewerContact.id}`]);
  if (profileLinkedinSlug) profileKeys.add(`l:${profileLinkedinSlug}`);

  const MAX_OTHER_USERS_SCAN = 20;
  const MAX_OTHER_USER_CONTACTS_SCAN = 250;
  const MAX_OTHER_USER_MATCHING_CONTACTS = 1000;

  // Step 1: find other userIds that likely have this profile contact.
  const otherUserConditions: Array<ReturnType<typeof ilike>> = [
    ilike(contacts.linkedinUrl, `%/in/${profileLinkedinSlug}%`),
  ];

  const otherUserRows = await db.query.contacts.findMany({
    where: and(
      sql`${contacts.userId} <> ${userId}`,
      or(...otherUserConditions)
    ),
    columns: {
      userId: true,
      lastInteractionAt: true,
    },
    limit: MAX_OTHER_USER_MATCHING_CONTACTS,
  });

  const maxLastInteractionAtByUser = new Map<string, number>();
  for (const r of otherUserRows) {
    if (!r.userId) continue;
    const ts = r.lastInteractionAt ? new Date(r.lastInteractionAt).getTime() : 0;
    const prev = maxLastInteractionAtByUser.get(r.userId) ?? -Infinity;
    if (ts > prev) maxLastInteractionAtByUser.set(r.userId, ts);
  }

  const otherUserIds = [...maxLastInteractionAtByUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_OTHER_USERS_SCAN)
    .map(([id]) => id);

  const mutualCountByViewerContactId = new Map<string, number>();

  // Step 2: for each other user, count which of *your* contacts overlap
  // (given that they also have the profile contact).
  for (const otherUserId of otherUserIds) {
    const otherContacts = await db.query.contacts.findMany({
      where: eq(contacts.userId, otherUserId),
      columns: {
        id: true,
        linkedinUrl: true,
        lastInteractionAt: true,
      },
      // Prefer recent contacts so we find mutuals quickly.
      orderBy: (c, { desc: descOrder }) => [descOrder(c.lastInteractionAt)],
      limit: MAX_OTHER_USER_CONTACTS_SCAN,
    });

    let hasProfile = false;
    const overlaps = new Set<string>(); // viewer contact ids

    for (const oc of otherContacts) {
      const linkedinSlug = extractLinkedinSlug(oc.linkedinUrl);

      const keys: string[] = [`i:${oc.id}`];
      if (linkedinSlug) keys.push(`l:${linkedinSlug}`);
      if (keys.length === 0) continue;

      if (!hasProfile) {
        for (const k of keys) {
          if (profileKeys.has(k)) {
            hasProfile = true;
            break;
          }
        }
      }

      for (const k of keys) {
        const viewerIds = viewerKeyToIds.get(k);
        if (!viewerIds) continue;
        for (const vid of viewerIds) overlaps.add(vid);
      }
    }

    if (!hasProfile) continue;

    for (const vid of overlaps) {
      if (vid === contactId) continue;
      const current = mutualCountByViewerContactId.get(vid) ?? 0;
      mutualCountByViewerContactId.set(vid, current + 1);
    }
  }

  const result: MutualContact[] = [];
  for (const [vid, count] of mutualCountByViewerContactId.entries()) {
    const base = viewerById.get(vid);
    if (!base) continue;
    result.push({
      ...base,
      mutualCount: count,
    });
  }

  result.sort(
    (a, b) =>
      b.mutualCount - a.mutualCount ||
      (a.fullName || "").localeCompare(b.fullName || "", undefined, {
        sensitivity: "base",
      })
  );

  return result.slice(0, limit);
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
