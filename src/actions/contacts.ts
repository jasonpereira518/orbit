"use server";

import { and, eq, desc } from "drizzle-orm";
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
import { rebuildContactEmbedding } from "@/lib/search";

export type ContactInput = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  company?: string;
  title?: string;
  location?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  website?: string;
  relationshipScore?: number;
  priorityLevel?: number;
  source?: string;
  industry?: string;
  howMet?: string;
  notes?: string;
  aiSummary?: string;
  keyFacts?: string[];
  sharedInterests?: string[];
  opportunities?: string[];
  nextFollowUpAt?: string | null;
  tagNames?: string[];
};

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
        c.email,
        c.phone,
        c.location,
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

  return rows.map((c) => ({
    ...c,
    tags: c.contactTags.map((ct) => ct.tag.name),
  }));
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

export async function createContact(input: ContactInput) {
  const userId = await requireUserId();
  const db = await getDb();
  const now = new Date();

  const [contact] = await db
    .insert(contacts)
    .values({
      userId,
      fullName: input.fullName,
      firstName: input.firstName,
      lastName: input.lastName,
      preferredName: input.preferredName,
      company: input.company,
      title: input.title,
      location: input.location,
      email: input.email,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      website: input.website,
      relationshipScore: input.relationshipScore ?? 2,
      priorityLevel: input.priorityLevel ?? 0,
      source: input.source ?? "manual",
      industry: input.industry,
      howMet: input.howMet,
      notes: input.notes,
      aiSummary: input.aiSummary,
      keyFacts: input.keyFacts ?? [],
      sharedInterests: input.sharedInterests ?? [],
      opportunities: input.opportunities ?? [],
      firstInteractionAt: now,
      lastInteractionAt: now,
      nextFollowUpAt: input.nextFollowUpAt
        ? new Date(input.nextFollowUpAt)
        : null,
    })
    .returning();

  await syncTags(userId, contact.id, input.tagNames);
  await rebuildContactEmbedding(userId, contact.id);

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/graph");

  return contact;
}

export async function updateContact(id: string, input: Partial<ContactInput>) {
  const userId = await requireUserId();
  const db = await getDb();

  const [contact] = await db
    .update(contacts)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.preferredName !== undefined
        ? { preferredName: input.preferredName }
        : {}),
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.linkedinUrl !== undefined
        ? { linkedinUrl: input.linkedinUrl }
        : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.relationshipScore !== undefined
        ? { relationshipScore: input.relationshipScore }
        : {}),
      ...(input.priorityLevel !== undefined
        ? { priorityLevel: input.priorityLevel }
        : {}),
      ...(input.industry !== undefined ? { industry: input.industry } : {}),
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

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  revalidatePath("/graph");

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
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const now = new Date();

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
      interactionDate: now,
    })
    .returning();

  await db
    .update(contacts)
    .set({ lastInteractionAt: now, updatedAt: now })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)));

  if (input.rawNotes || input.aiSummary) {
    await rebuildContactEmbedding(userId, input.contactId);
  }

  revalidatePath(`/contacts/${input.contactId}`);
  revalidatePath("/");
  return row;
}
