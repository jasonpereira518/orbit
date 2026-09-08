/**
 * Who the account owner is, and whether an extracted person is them.
 *
 * Capture used to create a contact for the user themselves. Three other importers already
 * filter the owner out — `counterpartsOf` in `calendar-classify.ts` (email-set match),
 * `resolveSelfIdentity` in `linkedin-messages.ts` (explicit-beats-inferred slug match), and
 * the extension's Gmail DOM adapter — but the note/capture path had none, so a pasted
 * calendar invite or forwarded email seeded the user as an attendee and
 * `parseMultiPersonTwoPass` force-added them as a participant even when the model had
 * correctly left them out.
 *
 * The matching order below mirrors `resolveSelfIdentity`'s structure: hard identifiers the
 * user (or a provider) declared beat anything inferred from a name.
 */

import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  calendarSubscriptions,
  gmailConnections,
  outlookConnections,
  userSettings,
} from "@/db/schema";
import {
  linkedinSlug,
  nameSimilarity,
  normalize,
  normalizeName,
} from "@/lib/duplicates";

/**
 * Stricter than `DUPLICATE_MERGE_CONFIDENCE` (0.85) on purpose. A false positive here is
 * silent and destructive in a way a merge suggestion is not: a real person is dropped from
 * the extraction and the user never learns they existed. A merge suggestion, by contrast,
 * is shown for confirmation before anything is written.
 */
export const SELF_NAME_SIMILARITY = 0.92;

export type SelfIdentity = {
  /** Every address known to belong to the owner, normalized. */
  emails: Set<string>;
  /** From `user_settings.social_links.linkedin` — the only place the owner's own URL lives. */
  linkedinSlug: string;
  /** The owner's display name from the Clerk mirror; empty when the mirror is unpopulated. */
  name: string;
};

export const EMPTY_SELF_IDENTITY: SelfIdentity = {
  emails: new Set(),
  linkedinSlug: "",
  name: "",
};

/**
 * Assemble the owner's identity from every source that already stores it.
 *
 * Cached per request via React `cache`, like `ensureUserSettings`. Note that outside a
 * request (a script, a smoke test) `cache` is a pass-through, so each call re-queries —
 * fine for the volumes here, and it keeps toggle-and-recheck tests honest.
 *
 * Failures are swallowed into an empty identity rather than thrown: not knowing who the
 * user is must degrade capture back to its old behaviour, never break the extraction.
 */
export const getSelfIdentity = cache(
  async (userId: string): Promise<SelfIdentity> => {
    try {
      const db = await getDb();
      const [settings, gmail, outlook, calendars] = await Promise.all([
        db.query.userSettings.findFirst({
          where: eq(userSettings.userId, userId),
          columns: {
            email: true,
            firstName: true,
            lastName: true,
            socialLinks: true,
          },
        }),
        db.query.gmailConnections.findFirst({
          where: eq(gmailConnections.userId, userId),
          columns: { emailAddress: true },
        }),
        db.query.outlookConnections.findFirst({
          where: eq(outlookConnections.userId, userId),
          columns: { emailAddress: true },
        }),
        db.query.calendarSubscriptions.findMany({
          where: eq(calendarSubscriptions.userId, userId),
          columns: { selfEmail: true },
        }),
      ]);

      const emails = new Set<string>();
      for (const value of [
        settings?.email,
        gmail?.emailAddress,
        outlook?.emailAddress,
        ...calendars.map((c) => c.selfEmail),
      ]) {
        const normalized = normalize(value);
        if (normalized) emails.add(normalized);
      }

      return {
        emails,
        linkedinSlug: linkedinSlug(settings?.socialLinks?.linkedin),
        name: [settings?.firstName, settings?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim(),
      };
    } catch {
      return EMPTY_SELF_IDENTITY;
    }
  }
);

export type SelfProbe = {
  name?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
};

/**
 * Is this extracted person the account owner?
 *
 * Order matters:
 *   1. A known address is proof.
 *   2. The declared LinkedIn slug is proof.
 *   3. An address that is NOT one of the owner's is proof of the opposite — and this is
 *      what makes step 4 safe. A real contact who happens to share the owner's name almost
 *      always arrives carrying their own email, so the name check never sees them.
 *   4. Only then, a near-exact name match — and only against a full name.
 *
 * That last restriction matters. `nameSimilarity` short-circuits to 1 on an exact string
 * match *before* its under-4-characters guard, so if the Clerk mirror holds a mononym
 * ("Jay") every Jay in every note would match it exactly and be dropped. A single token is
 * too weak a signal to silently delete a person, so a name-only match requires the owner's
 * name to carry at least two tokens. A mononym owner still gets filtered by email and
 * LinkedIn slug, which is where the signal actually is.
 */
export function isSelf(probe: SelfProbe, self: SelfIdentity): boolean {
  const email = normalize(probe.email);
  if (email && self.emails.has(email)) return true;

  const slug = linkedinSlug(probe.linkedinUrl);
  if (slug && self.linkedinSlug && slug === self.linkedinSlug) return true;

  // Carries an address, and it isn't one of ours: this is somebody else.
  if (email) return false;

  if (!probe.name?.trim()) return false;
  const selfName = normalizeName(self.name);
  if (!selfName || !selfName.includes(" ")) return false;
  return nameSimilarity(probe.name, selfName) >= SELF_NAME_SIMILARITY;
}
