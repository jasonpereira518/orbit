"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
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
} from "@/lib/apollo";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
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

  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;

    let tag = await db.query.tags.findFirst({
      where: and(eq(tags.userId, userId), eq(tags.name, name)),
    });

    if (!tag) {
      const [created] = await db
        .insert(tags)
        .values({ userId, name })
        .returning();
      tag = created;
    }

    await db.insert(contactTags).values({ contactId, tagId: tag.id });
  }
}

export async function listContacts(filters?: {
  q?: string;
  company?: string;
  minScore?: number;
  followUp?: "due";
}) {
  const userId = await requireUserId();
  const db = await getDb();

  let rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: { contactTags: { with: { tag: true } } },
    orderBy: [desc(contacts.updatedAt)],
  });

  if (filters?.q) {
    const q = filters.q.toLowerCase();
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
  if (filters?.company) {
    rows = rows.filter(
      (c) => (c.company || "").toLowerCase() === filters.company!.toLowerCase()
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

  const goals = await listActiveGoalTexts(userId);

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

export async function getContact(id: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, id), eq(contacts.userId, userId)),
    with: {
      contactTags: { with: { tag: true } },
      interactions: { orderBy: [desc(interactions.interactionDate)] },
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
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const parsedDate =
    input.interactionDate instanceof Date
      ? input.interactionDate
      : input.interactionDate
        ? new Date(input.interactionDate)
        : null;
  const when =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

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
    })
    .returning();

  await db
    .update(contacts)
    .set({ lastInteractionAt: when, updatedAt: new Date() })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)));

  if (input.rawNotes || input.aiSummary) {
    await rebuildContactEmbedding(userId, input.contactId);
  }

  revalidatePath(`/contacts/${input.contactId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/graph");
  return row;
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
export async function draftContactFollowUp(contactId: string) {
  const userId = await requireUserId();
  const goals = await listActiveGoalTexts(userId);
  return generateContactFollowUpDraft(userId, contactId, goals);
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

  return { ok: true as const };
}

/** Contacts related by company, school, howMet, mentions, tags, or interests. */
export async function listRelatedContacts(
  contactId: string,
  limit = 8
): Promise<RelatedContact[]> {
  const userId = await requireUserId();
  const db = await getDb();

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
    limit
  );
}
