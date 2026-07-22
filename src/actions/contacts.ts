"use server";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contactTags,
  contacts,
  interactions,
  reminders,
  tags,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { computeCloseness } from "@/lib/closeness";
import { listActiveGoalTexts } from "@/actions/goals";
import { companyFieldsForWrite } from "@/lib/companies";
import { isMetContext } from "@/lib/met-context";
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
  downloadImageAsDataUrl,
  fetchLinkedInPhotoDataUrl,
} from "@/lib/contact-avatar";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import {
  findRelatedContacts,
  type RelatedContact,
} from "@/lib/related-contacts";
import {
  getOutreachSendConfig,
  sendOutreachMessage,
} from "@/lib/outreach-send";

export type ContactWriteOptions = {
  /** Skip path revalidation during bulk imports. */
  skipRevalidate?: boolean;
};

export type ContactInput = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  company?: string;
  title?: string;
  location?: string;
  school?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  website?: string;
  profileImageUrl?: string | null;
  relationshipScore?: number;
  priorityLevel?: number;
  source?: string;
  industry?: string;
  metContext?: string;
  dateMet?: string | null;
  howMet?: string;
  notes?: string;
  aiSummary?: string;
  keyFacts?: string[];
  sharedInterests?: string[];
  opportunities?: string[];
  nextFollowUpAt?: string | null;
  tagNames?: string[];
};

function normalizeMetContext(value?: string | null) {
  if (!value?.trim()) return null;
  return isMetContext(value) ? value : null;
}

async function syncTags(
  userId: string,
  contactId: string,
  tagNames: string[] = []
) {
  const db = await getDb();
  await db.delete(contactTags).where(eq(contactTags.contactId, contactId));

  const names = [
    ...new Set(tagNames.map((raw) => raw.trim()).filter(Boolean)),
  ];
  if (names.length === 0) return;

  const existing = await db.query.tags.findMany({
    where: and(eq(tags.userId, userId), inArray(tags.name, names)),
  });
  const byName = new Map(existing.map((tag) => [tag.name, tag]));

  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const created = await db
      .insert(tags)
      .values(missing.map((name) => ({ userId, name })))
      .returning();
    for (const tag of created) {
      byName.set(tag.name, tag);
    }
  }

  await db.insert(contactTags).values(
    names.map((name) => ({
      contactId,
      tagId: byName.get(name)!.id,
    }))
  );
}

export async function listContacts(filters?: {
  q?: string;
  company?: string;
  minScore?: number;
  followUp?: "due";
}) {
  const userId = await requireUserId();
  const db = await getDb();

  const [allRows, goals] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      with: { contactTags: { with: { tag: true } } },
      orderBy: [desc(contacts.updatedAt)],
    }),
    listActiveGoalTexts(userId),
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
        c.notes,
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
    const closeness = computeCloseness({ ...c, tags }, goals);
    return {
      ...c,
      tags,
      closeness: closeness.closeness,
      closenessTier: closeness.tier,
      orbitScore: closeness.orbitScore,
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
  const userId = await requireUserId();
  const db = await getDb();
  const now = new Date();
  const companyFields = await companyFieldsForWrite(userId, input.company);
  const dateMet = input.dateMet ? new Date(input.dateMet) : null;
  const metAt =
    dateMet && !Number.isNaN(dateMet.getTime()) ? dateMet : null;

  const [contact] = await db
    .insert(contacts)
    .values({
      userId,
      fullName: input.fullName,
      firstName: input.firstName,
      lastName: input.lastName,
      preferredName: input.preferredName,
      company: companyFields.company,
      companyId: companyFields.companyId,
      title: input.title,
      location: input.location,
      school: input.school,
      email: input.email,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      website: input.website,
      profileImageUrl: input.profileImageUrl ?? null,
      relationshipScore: input.relationshipScore ?? 2,
      priorityLevel: input.priorityLevel ?? 0,
      source: input.source ?? "manual",
      industry: input.industry,
      metContext: normalizeMetContext(input.metContext),
      dateMet: metAt,
      howMet: input.howMet,
      notes: input.notes,
      aiSummary: input.aiSummary,
      keyFacts: input.keyFacts ?? [],
      sharedInterests: input.sharedInterests ?? [],
      opportunities: input.opportunities ?? [],
      firstInteractionAt: metAt ?? now,
      lastInteractionAt: metAt ?? now,
      nextFollowUpAt: input.nextFollowUpAt
        ? new Date(input.nextFollowUpAt)
        : null,
    })
    .returning();

  await syncTags(userId, contact.id, input.tagNames);
  await rebuildContactEmbedding(userId, contact.id);

  if (!options?.skipRevalidate) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
  }

  return contact;
}

export async function updateContact(
  id: string,
  input: Partial<ContactInput>,
  options?: ContactWriteOptions
) {
  const userId = await requireUserId();
  const db = await getDb();

  const companyPatch =
    input.company !== undefined
      ? await companyFieldsForWrite(userId, input.company)
      : null;

  const [contact] = await db
    .update(contacts)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.preferredName !== undefined
        ? { preferredName: input.preferredName }
        : {}),
      ...(companyPatch
        ? { company: companyPatch.company, companyId: companyPatch.companyId }
        : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.school !== undefined ? { school: input.school } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.linkedinUrl !== undefined
        ? { linkedinUrl: input.linkedinUrl }
        : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.profileImageUrl !== undefined
        ? { profileImageUrl: input.profileImageUrl }
        : {}),
      ...(input.relationshipScore !== undefined
        ? { relationshipScore: input.relationshipScore }
        : {}),
      ...(input.priorityLevel !== undefined
        ? { priorityLevel: input.priorityLevel }
        : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.industry !== undefined ? { industry: input.industry } : {}),
      ...(input.metContext !== undefined
        ? { metContext: normalizeMetContext(input.metContext) }
        : {}),
      ...(input.dateMet !== undefined
        ? { dateMet: input.dateMet ? new Date(input.dateMet) : null }
        : {}),
      ...(input.howMet !== undefined ? { howMet: input.howMet } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.aiSummary !== undefined ? { aiSummary: input.aiSummary } : {}),
      ...(input.keyFacts !== undefined ? { keyFacts: input.keyFacts } : {}),
      ...(input.sharedInterests !== undefined
        ? { sharedInterests: input.sharedInterests }
        : {}),
      ...(input.opportunities !== undefined
        ? { opportunities: input.opportunities }
        : {}),
      ...(input.nextFollowUpAt !== undefined
        ? {
            nextFollowUpAt: input.nextFollowUpAt
              ? new Date(input.nextFollowUpAt)
              : null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
    .returning();

  if (input.tagNames) {
    await syncTags(userId, id, input.tagNames);
  }

  await rebuildContactEmbedding(userId, id);

  const significant =
    input.fullName !== undefined ||
    input.preferredName !== undefined ||
    input.title !== undefined ||
    input.company !== undefined ||
    input.industry !== undefined ||
    input.howMet !== undefined ||
    input.metContext !== undefined ||
    input.notes !== undefined ||
    input.keyFacts !== undefined ||
    input.sharedInterests !== undefined;

  if (significant && !options?.skipRevalidate) {
    void generateAndStorePersonSummary(userId, id).catch(() => null);
  }

  if (!options?.skipRevalidate) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${id}`);
    revalidatePath("/graph");
  }

  return contact;
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

export async function logInteraction(input: {
  contactId: string;
  rawNotes?: string;
  aiSummary?: string;
  topics?: string[];
  actionItems?: string[];
  interactionType?: string;
  source?: string;
  interactionDate?: string | Date;
  /** When true, parse a date from rawNotes if interactionDate is omitted. */
  parseDateFromNotes?: boolean;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const { parseInteractionDateFromNotes } = await import(
    "@/lib/interaction-date"
  );

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

  if (!when && input.parseDateFromNotes) {
    when = parseInteractionDateFromNotes(input.rawNotes, new Date());
  }
  if (!when) when = new Date();

  const [row] = await db
    .insert(interactions)
    .values({
      userId,
      contactId: input.contactId,
      rawNotes: input.rawNotes,
      aiSummary: input.aiSummary,
      topics: input.topics ?? [],
      actionItems: input.actionItems ?? [],
      interactionType: input.interactionType ?? "note",
      source: input.source,
      interactionDate: when,
      sameDayOrder: 0,
    })
    .returning();

  await db
    .update(contacts)
    .set({ lastInteractionAt: when, updatedAt: new Date() })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)));

  if (input.rawNotes || input.aiSummary) {
    await rebuildContactEmbedding(userId, input.contactId);
  }

  // Significant change: refresh stored person summary
  void generateAndStorePersonSummary(userId, input.contactId).catch(() => null);

  revalidatePath(`/contacts/${input.contactId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/graph");
  return row;
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
    return { refreshed: 0, unmatched: 0, failed: 0, avatarOnly: false };
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
    return { refreshed: 0, unmatched: 0, failed: 0, avatarOnly: false };
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

  for (let i = 0; i < ordered.length; i++) {
    const contact = ordered[i];
    const profile = enriched[i];

    try {
      // Prefer Apollo photo when present; otherwise resolve via LinkedIn OG image.
      let profileImageUrl: string | null = null;
      if (profile?.profileImageUrl) {
        profileImageUrl = await downloadImageAsDataUrl(profile.profileImageUrl);
      }
      if (!profileImageUrl && contact.linkedinUrl) {
        profileImageUrl = await fetchLinkedInPhotoDataUrl(contact.linkedinUrl);
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

  return { refreshed, unmatched, failed, avatarOnly };
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
  const goals = await listActiveGoalTexts(userId);
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
  const goals = await listActiveGoalTexts(userId);

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
