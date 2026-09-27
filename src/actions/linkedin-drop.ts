"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { findIdentityOwners } from "@/lib/contact-identity";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { identityKeysFor, linkedinSlug } from "@/lib/duplicates";
import { PaywallError } from "@/lib/entitlements";
import { resolvePastedLinkedInProfiles } from "@/lib/linkedin-capture";
import {
  MAX_PASTED_LINKEDIN_PROFILES,
  extractLinkedInProfileRefs,
  type LinkedInLookupDegradation,
} from "@/lib/linkedin-paste";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export type DroppedLinkedInPerson = { contactId: string; name: string };

export type LinkedInDropResult = {
  /** People this drop put into the network. */
  added: DroppedLinkedInPerson[];
  /** Profiles that already belonged to a contact — left exactly as they were. */
  existing: DroppedLinkedInPerson[];
  /** Why the added people carry a name read off the URL rather than profile data. */
  degraded: LinkedInLookupDegradation;
  /** Profiles past the cap, never looked at. */
  dropped: number;
  /** Set when the plan's contact cap stopped the drop part-way. */
  limitMessage: string | null;
};

/**
 * Add the people behind LinkedIn profile URLs dropped (or pasted) onto /imports.
 *
 * The capture panel already turns a bare profile URL into a person, but through a review
 * card, because it sits beside a note. A drop on Imports is the whole instruction — "this
 * person, into my contacts" — so it writes straight away, with the same pieces:
 * `resolvePastedLinkedInProfiles` for the lookup (and its slug fallback when Apollo is
 * unavailable), `resolveOrCreateContact` for the write, so the identity index stays the one
 * guard against a duplicate.
 *
 * A profile somebody already holds is reported, not written. Routing it through
 * `resolveOrCreateContact` would "match" and then overwrite the existing contact with
 * whatever the lookup returned — which, without Apollo, is a name guessed from the slug
 * replacing a name the user typed. It also skips the Apollo credit for someone Orbit knows.
 */
export async function addContactsFromLinkedInUrls(
  text: string
): Promise<LinkedInDropResult> {
  const userId = await requireUserId();
  const refs = extractLinkedInProfileRefs(text);
  const empty: LinkedInDropResult = {
    added: [],
    existing: [],
    degraded: null,
    dropped: 0,
    limitMessage: null,
  };
  if (!refs.length) return empty;

  const dropped = Math.max(0, refs.length - MAX_PASTED_LINKEDIN_PROFILES);
  const capped = refs.slice(0, MAX_PASTED_LINKEDIN_PROFILES);

  // 1. Who is already here, by LinkedIn identity alone. Names are deliberately not
  //    consulted: before the lookup, the only name we have is a guess from the slug.
  const ownerBySlug = new Map<string, string>();
  const owners = await findIdentityOwners(
    userId,
    capped.flatMap((ref) => identityKeysFor({ linkedinUrl: ref.url }))
  );
  for (const owner of owners) ownerBySlug.set(owner.key.value, owner.contactId);

  const existingIds = capped
    .map((ref) => ownerBySlug.get(linkedinSlug(ref.url)))
    .filter((id): id is string => Boolean(id));
  const existing: DroppedLinkedInPerson[] = [];
  if (existingIds.length) {
    const db = await getDb();
    const rows = await db
      .select({ id: contacts.id, fullName: contacts.fullName })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, existingIds)));
    for (const row of rows) existing.push({ contactId: row.id, name: row.fullName });
  }

  const fresh = capped.filter((ref) => !ownerBySlug.has(linkedinSlug(ref.url)));
  if (!fresh.length) return { ...empty, existing, dropped };

  // 2. Look the rest up, then write each through the one resolve-or-create path.
  const { people, degraded } = await resolvePastedLinkedInProfiles(userId, fresh);
  const added: DroppedLinkedInPerson[] = [];
  let limitMessage: string | null = null;

  for (const person of people) {
    const fullName = person.name ?? person.slug;
    try {
      const { contactId, outcome } = await resolveOrCreateContact(
        userId,
        {
          fullName,
          title: person.title ?? undefined,
          company: person.company ?? undefined,
          location: person.location ?? undefined,
          school: person.school ?? undefined,
          email: person.email ?? undefined,
          linkedinUrl: person.url,
          source: "linkedin",
        },
        { source: "linkedin_drop" }
      );
      // A name-tier fold means they were here under another spelling of their profile.
      if (outcome === "created") added.push({ contactId, name: fullName });
      else existing.push({ contactId, name: fullName });
    } catch (err) {
      if (err instanceof PaywallError) {
        limitMessage = err.message;
        break;
      }
      throw err;
    }
  }

  if (added.length) {
    revalidatePath("/contacts");
    revalidatePath("/");
    revalidatePath("/graph");
  }

  return { added, existing, degraded, dropped, limitMessage };
}
