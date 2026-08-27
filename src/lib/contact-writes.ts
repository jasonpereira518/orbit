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

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { contactTags, contacts, interactions, tags } from "@/db/schema";
import { PaywallError, getEntitlements } from "@/lib/entitlements";
import { recordGateHit } from "@/lib/gate-events";
import {
  companyFieldsForWrite,
  companyFieldsForWriteCached,
  type CompanyResolver,
} from "@/lib/companies";
import { isMetContext } from "@/lib/met-context";
import { generateAndStorePersonSummary } from "@/lib/person-summary";
import { markCohortDirty, rescoreContact } from "@/lib/closeness-materialize";
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
  /**
   * Skip per-contact closeness scoring. For bulk paths only: they recalibrate the whole
   * network once at the end, which supersedes scoring each row against a distribution that
   * is about to be redrawn anyway.
   */
  skipCloseness?: boolean;
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
  /**
   * Set this ONLY from a flow where the user themselves supplied the rating
   * (the contact-form slider, the AI-capture review step) — never from an
   * importer default. Unlike `relationshipScore`, `contactInsertValues` does
   * NOT fall back to a default here: an omitted value stays `null` on create,
   * which is what keeps imported contacts unrated. See `strengthComponent` in
   * `@/lib/closeness` for why the distinction matters.
   */
  statedCloseness?: number | null;
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
    // Deliberately NOT `input.statedCloseness ?? input.relationshipScore` —
    // that would resurrect the exact leak this field exists to prevent, since
    // several importers pass relationshipScore explicitly. Only a caller that
    // set statedCloseness itself (a real user rating) reaches this column;
    // everyone else gets null, same as before this field existed.
    statedCloseness: input.statedCloseness ?? null,
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

/**
 * How many more contacts this user may create, or `null` for unlimited.
 *
 * The plan cap gates *creation only*. Reads, edits, and interaction logging are never
 * gated, so a lapsed subscriber sitting above the cap keeps full access to everything
 * already in their orbit — nothing is ever hidden behind the paywall.
 */
export async function contactHeadroomForUser(userId: string) {
  const { contactLimit } = await getEntitlements(userId);
  if (contactLimit === null) return null;

  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, userId));

  return Math.max(0, contactLimit - (row?.value ?? 0));
}

/** Current usage for the contacts-page counter. `limit: null` means unlimited. */
export async function contactUsageForUser(userId: string) {
  const { contactLimit, plan } = await getEntitlements(userId);
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, userId));

  const used = row?.value ?? 0;
  return {
    used,
    limit: contactLimit,
    plan,
    remaining: contactLimit === null ? null : Math.max(0, contactLimit - used),
  };
}

export async function createContactForUser(
  userId: string,
  input: ContactInput,
  options?: ContactWriteOptions
) {
  const headroom = await contactHeadroomForUser(userId);
  if (headroom !== null && headroom < 1) {
    const { plan, contactLimit } = await getEntitlements(userId);
    // The cap is the most direct pricing lever Orbit has, and until now hitting it left no
    // trace — so "does the 100-contact limit convert, or just annoy?" had no evidence
    // behind it either way.
    await recordGateHit({
      userId,
      feature: "contacts",
      plan,
      context: { contactLimit },
    });
    throw new PaywallError(
      "contacts",
      plan,
      `You've reached the ${contactLimit}-contact limit on the free plan. Upgrade to add more people to your orbit.`
    );
  }

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

  await scoreAfterWrite(userId, contact.id, options);

  if (!options?.skipRevalidate) {
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidatePath("/graph");
  }

  return contact;
}

/**
 * Give a just-written contact a closeness score, and note that the ranking has moved.
 *
 * The score matters immediately: a contact with none reads as "never scored", and the next
 * page view would respond by recalibrating the entire network — so skipping this would make
 * every individual write cost a full rescore. The dirty flag is the cheap half; a background
 * pass redraws the distribution once things settle.
 *
 * Failure here is not worth failing a write over. An unscored contact is picked up by the
 * next recalibration either way, which is exactly what the dirty flag is asking for.
 */
async function scoreAfterWrite(
  userId: string,
  contactId: string,
  options?: ContactWriteOptions
) {
  if (options?.skipCloseness) return;
  try {
    await rescoreContact(userId, contactId);
    await markCohortDirty(userId);
  } catch {
    // Left unscored on purpose; recalibration will claim it.
  }
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

  // Take what fits rather than failing the whole batch: a free user importing 847
  // LinkedIn connections should still get their first 100, and the caller reports the
  // shortfall by comparing `created.length` against what it passed in.
  const headroom = await contactHeadroomForUser(userId);
  if (headroom !== null && headroom < 1) return [];
  const admitted =
    headroom === null ? inputs : inputs.slice(0, headroom);

  const db = await getDb();
  const now = new Date();

  const companyFieldsList = await Promise.all(
    admitted.map((input) =>
      companyFieldsForWriteCached(companyResolve, input.company)
    )
  );

  const values = admitted.map((input, i) =>
    contactInsertValues(userId, input, companyFieldsList[i], now)
  );

  const created = await db.insert(contacts).values(values).returning();

  // Deliberately no per-row scoring here. The caller recalibrates once when the import
  // finishes, and scoring each row against a distribution that is about to be redrawn would
  // be work thrown away — a 3,000-contact import would pay for 3,000 rescores to reach the
  // same place one recalibration reaches.
  await markCohortDirty(userId).catch(() => null);

  await syncTagsBulk(
    userId,
    created.map((contact, i) => ({
      contactId: contact.id,
      tagNames: admitted[i].tagNames,
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

/**
 * Apply a column patch to many existing contacts in one statement.
 *
 * The import merge path used to call `updateContactForUser` per row, which re-resolved the
 * company through the *uncached* `companyFieldsForWrite` — throwing away the resolver the
 * caller had already preloaded and spending two to three round trips per merged row.
 *
 * `undefined` means "leave alone", matching `updateContactForUser`'s `!== undefined`
 * checks: each field is passed as NULL and coalesced against the existing column.
 *
 * IMPORTANT: this is the second contact-write path in the codebase. Its column list must
 * be kept in sync by hand with `updateContactForUser` below. Deliberately narrow — it
 * carries only the fields importers actually merge, and notably NOT `relationshipScore`,
 * because mirroring that into `statedCloseness` is reserved for a human moving the slider
 * (see the comment on `relationshipScore` in `updateContactForUser`).
 *
 * KNOWN LIMITATION: COALESCE cannot tell "this field was explicitly normalized/resolved to
 * null" apart from "this field was never mentioned" — both arrive as SQL NULL in the VALUES
 * tuple, so this path can only set a column or leave it alone, never clear one. Four fields
 * can legitimately resolve to null from a defined input, and for all four that null is
 * indistinguishable from absence here: `company`/`companyId` (an unresolvable or blank name
 * resolves to `{company: null, companyId: null}` via `companyFieldsForWriteCached`),
 * `metContext` (an invalid string normalizes to null via `normalizeMetContext`),
 * `profileImageUrl`, and `dateMet` (both typed nullable on `ContactInput`).
 * `updateContactForUser` does not have this problem — its `!== undefined` checks see the
 * whole patch object, including a null-valued one, and apply it — so it can clear any of
 * these where this path cannot. It stays safe only because today's one caller (the LinkedIn
 * merge builder in `import-job-processor.ts`) never asks to clear any of them. The day an
 * importer needs to clear one of these fields during a merge, this silently keeps the stale
 * value instead; that importer needs a different encoding here (e.g. a sentinel that
 * distinguishes "clear" from "leave alone"), not a fix to this comment.
 */
export async function bulkMergeContactsForUser(
  userId: string,
  merges: Array<{ contactId: string; input: Partial<ContactInput> }>,
  companyResolve: CompanyResolver
) {
  if (merges.length === 0) return;
  const db = await getDb();
  const now = new Date();

  const companyFields = await Promise.all(
    merges.map((m) =>
      m.input.company !== undefined
        ? companyFieldsForWriteCached(companyResolve, m.input.company)
        : Promise.resolve({ company: null, companyId: null })
    )
  );

  const tuples = merges.map((m, i) => {
    const v = m.input;
    return sql`(
      ${m.contactId}::uuid,
      ${companyFields[i].company}::text,
      ${companyFields[i].companyId}::uuid,
      ${v.title ?? null}::text,
      ${v.email ?? null}::text,
      ${v.phone ?? null}::text,
      ${v.linkedinUrl ?? null}::text,
      ${v.firstName ?? null}::text,
      ${v.lastName ?? null}::text,
      ${v.profileImageUrl ?? null}::text,
      ${v.source ?? null}::text,
      ${v.howMet ?? null}::text,
      ${normalizeMetContext(v.metContext)}::text,
      ${safeTimestamp(v.dateMet)}::timestamptz
    )`;
  });

  await db.execute(sql`
    UPDATE contacts AS c
    SET company           = COALESCE(v.company, c.company),
        company_id        = COALESCE(v.company_id, c.company_id),
        title             = COALESCE(v.title, c.title),
        email             = COALESCE(v.email, c.email),
        phone             = COALESCE(v.phone, c.phone),
        linkedin_url      = COALESCE(v.linkedin_url, c.linkedin_url),
        first_name        = COALESCE(v.first_name, c.first_name),
        last_name         = COALESCE(v.last_name, c.last_name),
        profile_image_url = COALESCE(v.profile_image_url, c.profile_image_url),
        source            = COALESCE(v.source, c.source),
        how_met           = COALESCE(v.how_met, c.how_met),
        met_context       = COALESCE(v.met_context, c.met_context),
        date_met          = COALESCE(v.date_met, c.date_met),
        updated_at        = ${now}
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(
      id, company, company_id, title, email, phone, linkedin_url,
      first_name, last_name, profile_image_url, source, how_met, met_context, date_met
    )
    WHERE c.id = v.id AND c.user_id = ${userId}
  `);
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
      // A user moving this slider (contact-form.tsx, or the AI-capture review
      // step) is the strongest closeness signal the app ever gets, and it is
      // what lifts a contact above EVIDENCE_FLOOR. Mirror it here — but only
      // here, not on create — because no importer's update payload includes
      // relationshipScore (verified: LinkedIn/Google/Outlook/messages imports
      // only ever *create* with a default score, never *update* one). Create
      // paths still coalesce `input.relationshipScore ?? 2`, which is
      // indistinguishable from a real rating of 2, so they must never mirror.
      ...(input.relationshipScore !== undefined
        ? {
            relationshipScore: input.relationshipScore,
            statedCloseness: input.relationshipScore,
          }
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
    // `after()` rather than a bare floating promise: on Vercel the function can be
    // suspended the moment the response is sent, which would cut an unawaited summary
    // request off partway through.
    after(() => generateAndStorePersonSummary(userId, id).catch(() => null));
  }

  await scoreAfterWrite(userId, id, options);

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
    after(() =>
      generateAndStorePersonSummary(userId, input.contactId).catch(() => null)
    );
  }

  // Recency and cadence are the two components an interaction actually moves, so this is
  // the write most likely to change a contact's ring.
  await scoreAfterWrite(userId, input.contactId, options);

  if (!options?.skipRevalidate) {
    revalidatePath(`/contacts/${input.contactId}`);
    revalidatePath("/");
    revalidatePath("/dashboard");
    revalidatePath("/graph");
  }

  return row;
}
