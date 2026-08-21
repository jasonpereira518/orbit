/**
 * Contact write paths, parameterized by `userId`.
 *
 * These hold the actual insert/update logic for contacts and interactions.
 * `src/actions/contacts.ts` wraps each one with `requireUserId()` for the app's
 * own components; route handlers (which have no Clerk cookie context of the
 * kind server actions assume) call these directly with an explicitly resolved
 * userId.
 *
 * This mirrors `src/lib/reminders.ts`, `src/lib/follow-up-drafts.ts`, and
 * `src/lib/search.ts`, which already take `userId` as their first argument.
 */

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactTags, contacts, interactions, tags } from "@/db/schema";
import {
  companyFieldsForWrite,
  companyFieldsForWriteCached,
  type CompanyResolver,
} from "@/lib/companies";
import { isMetContext } from "@/lib/met-context";
import { generateAndStorePersonSummary } from "@/lib/person-summary";
import {
  rebuildContactEmbedding,
  rebuildContactEmbeddingsBatch,
} from "@/lib/search";

export type ContactWriteOptions = {
  /** Skip path revalidation during bulk imports. */
  skipRevalidate?: boolean;
  /** Skip the synchronous embedding API call; caller will rebuild embeddings in a batch. */
  skipEmbedding?: boolean;
  /** Skip the fire-and-forget person-summary refresh; caller will defer it (e.g. via `after()`). */
  skipSummary?: boolean;
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
  /**
   * Overrides the computed first-interaction timestamp (normally derived from
   * `dateMet`). Used by importers that know the real relationship age — e.g.
   * a LinkedIn "Connected On" date — so that age-based scoring isn't blind to
   * imported history.
   */
  firstInteractionAt?: string | Date | null;
  howMet?: string;
  notes?: string;
  aiSummary?: string;
  keyFacts?: string[];
  sharedInterests?: string[];
  opportunities?: string[];
  nextFollowUpAt?: string | null;
  tagNames?: string[];
};

export type LogInteractionInput = {
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
};

/** Thrown when a write targets a contact the user does not own (or that no longer exists). */
export class ContactNotFoundError extends Error {
  constructor(message = "Contact not found") {
    super(message);
    this.name = "ContactNotFoundError";
  }
}

function normalizeMetContext(value?: string | null) {
  if (!value?.trim()) return null;
  return isMetContext(value) ? value : null;
}

/** Coerce date inputs into a Postgres-safe timestamptz, or null. */
export function safeTimestamp(value?: string | Date | null): Date | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  // Reject JS misparses (e.g. Excel serial "46198" → year 46198) that
  // Postgres refuses with "time zone displacement out of range".
  if (year < 1970 || year > 2100) return null;
  return date;
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

/** Bulk variant of `syncTags` for freshly-created contacts (no existing tags to delete). */
async function syncTagsBulk(
  userId: string,
  items: { contactId: string; tagNames?: string[] }[]
) {
  const perContactNames = items.map((item) => [
    ...new Set((item.tagNames || []).map((raw) => raw.trim()).filter(Boolean)),
  ]);
  const allNames = [...new Set(perContactNames.flat())];
  if (allNames.length === 0) return;

  const db = await getDb();
  const existing = await db.query.tags.findMany({
    where: and(eq(tags.userId, userId), inArray(tags.name, allNames)),
  });
  const byName = new Map(existing.map((tag) => [tag.name, tag]));

  const missing = allNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const created = await db
      .insert(tags)
      .values(missing.map((name) => ({ userId, name })))
      .returning();
    for (const tag of created) {
      byName.set(tag.name, tag);
    }
  }

  const rows = items.flatMap((item, i) =>
    perContactNames[i].map((name) => ({
      contactId: item.contactId,
      tagId: byName.get(name)!.id,
    }))
  );
  if (rows.length > 0) {
    await db.insert(contactTags).values(rows);
  }
}

/** Shared column mapping for both the single and bulk create paths. */
function contactInsertValues(
  userId: string,
  input: ContactInput,
  companyFields: { company: string | null; companyId: string | null },
  now: Date
) {
  const metAt = safeTimestamp(input.dateMet);
  const firstInteractionAt =
    input.firstInteractionAt !== undefined
      ? safeTimestamp(input.firstInteractionAt)
      : metAt;
  return {
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
    firstInteractionAt: firstInteractionAt ?? now,
    lastInteractionAt: metAt ?? now,
    nextFollowUpAt: safeTimestamp(input.nextFollowUpAt),
  };
}

export async function createContactForUser(
  userId: string,
  input: ContactInput,
  options?: ContactWriteOptions
) {
  const db = await getDb();
  const now = new Date();
  const companyFields = await companyFieldsForWrite(userId, input.company);

  const [contact] = await db
    .insert(contacts)
    .values(contactInsertValues(userId, input, companyFields, now))
    .returning();

  await syncTags(userId, contact.id, input.tagNames);
  if (!options?.skipEmbedding) {
    await rebuildContactEmbedding(userId, contact.id);
  }

  if (!options?.skipRevalidate) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
  }

  return contact;
}

/**
 * Bulk-create contacts in a single insert, using a preloaded `CompanyResolver`
 * (see `createCompanyResolver`) instead of a per-row company lookup, and a
 * single batched embedding pass instead of one embedding call per contact.
 * For bulk imports only — general callers should use `createContactForUser`.
 */
export async function createContactsBulkForUser(
  userId: string,
  inputs: ContactInput[],
  companyResolve: CompanyResolver,
  options?: ContactWriteOptions
) {
  if (inputs.length === 0) return [];

  const db = await getDb();
  const now = new Date();

  const companyFieldsList = await Promise.all(
    inputs.map((input) =>
      companyFieldsForWriteCached(companyResolve, input.company)
    )
  );

  const values = inputs.map((input, i) =>
    contactInsertValues(userId, input, companyFieldsList[i], now)
  );

  const created = await db.insert(contacts).values(values).returning();

  await syncTagsBulk(
    userId,
    created.map((contact, i) => ({
      contactId: contact.id,
      tagNames: inputs[i].tagNames,
    }))
  );

  if (!options?.skipEmbedding) {
    await rebuildContactEmbeddingsBatch(
      userId,
      created.map((contact) => contact.id)
    );
  }

  if (!options?.skipRevalidate) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
  }

  return created;
}

export async function updateContactForUser(
  userId: string,
  id: string,
  input: Partial<ContactInput>,
  options?: ContactWriteOptions
) {
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
        ? { dateMet: safeTimestamp(input.dateMet) }
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
        ? { nextFollowUpAt: safeTimestamp(input.nextFollowUpAt) }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
    .returning();

  if (input.tagNames) {
    await syncTags(userId, id, input.tagNames);
  }

  if (!options?.skipEmbedding) {
    await rebuildContactEmbedding(userId, id);
  }

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

  if (significant && !options?.skipRevalidate && !options?.skipSummary) {
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

export async function logInteractionForUser(
  userId: string,
  input: LogInteractionInput,
  options?: ContactWriteOptions
) {
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

  // Touch the contact first: the userId-scoped WHERE doubles as the ownership
  // check, so an unowned contactId returns no rows and we bail before writing
  // an orphaned interaction. Costs no extra round trip.
  const [owned] = await db
    .update(contacts)
    .set({ lastInteractionAt: when, updatedAt: new Date() })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)))
    .returning();

  if (!owned) {
    throw new ContactNotFoundError();
  }

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

  if ((input.rawNotes || input.aiSummary) && !options?.skipEmbedding) {
    await rebuildContactEmbedding(userId, input.contactId);
  }

  // Significant change: refresh stored person summary
  if (!options?.skipSummary) {
    void generateAndStorePersonSummary(userId, input.contactId).catch(
      () => null
    );
  }

  if (!options?.skipRevalidate) {
    revalidatePath(`/contacts/${input.contactId}`);
    revalidatePath("/");
    revalidatePath("/dashboard");
    revalidatePath("/graph");
  }

  return row;
}
