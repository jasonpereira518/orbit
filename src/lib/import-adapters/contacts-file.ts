import type { ContactsFileRowPayload } from "@/db/schema";
import type { ImportAdapter } from "@/lib/import-engine";

/**
 * The `imports.import_type` value address-book file imports (vCard / contacts CSV) carry.
 *
 * Lives here rather than in `import-job-dispatch.ts` (which re-exports it, so every
 * existing call site is unchanged) so the adapter registry can key on it without importing
 * the dispatcher — the dispatcher reaches the engine, and the engine reaches the registry.
 */
export const CONTACTS_FILE_IMPORT_TYPE = "contacts_file";

/**
 * The same identity story as Google and Outlook Contacts (see `google-contacts.ts`), because
 * these are usually the very same records exported to a file instead of fetched over OAuth:
 * matched on email, and a row with no email — most of a phone's address book — still probes
 * on `fullName`, matchable only on the weak `byName` tier (0.6, below the 0.85 merge floor),
 * so it creates rather than merges on no stronger evidence than a shared name.
 *
 * Unlike those two, a card can carry a LinkedIn URL (iCloud's social profiles, a Google
 * "Website" entry), and it is probed too: it is the strongest identifier the matcher knows,
 * and it is what lets an address-book entry fold into the contact a LinkedIn import already
 * created for the same person.
 *
 * Phone is written but not probed — `findDuplicateCandidatesIndexed` has no phone tier, so an
 * existing contact that shares only a phone number with a card is not recognised here, exactly
 * as it isn't for the Google and Outlook imports. (Within one file, `parseContactsFile` does
 * collapse same-name-same-phone cards before any of this runs.)
 */
export const contactsFileAdapter: ImportAdapter<ContactsFileRowPayload> = {
  identity(payload) {
    if (!payload.fullName.trim()) return null;
    return {
      fullName: payload.fullName,
      email: payload.email,
      linkedinUrl: payload.linkedinUrl,
      company: payload.company,
      title: payload.title,
    };
  },

  toCreate(payload) {
    return {
      fullName: payload.fullName,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      company: payload.company || undefined,
      title: payload.title || undefined,
      email: payload.email || undefined,
      phone: payload.phone || undefined,
      linkedinUrl: payload.linkedinUrl || undefined,
      // Create only. `bulkMergeContactsForUser` has no notes column, and that is the right
      // call rather than a gap: a merge target's notes are the user's own words, and an
      // address-book NOTE from years ago has no business replacing them.
      notes: payload.notes || undefined,
      source: "contacts_file",
      // No statedCloseness and no relationshipScore, same as the LinkedIn adapter: nobody has
      // rated these people, and an address book of plumbers and old classmates is the last
      // place to guess. `contactInsertValues` still coalesces the legacy column to 2.
      howMet: "Address book",
      // No metContext either. Google/Outlook say "online", which is at least where their
      // data lives; a phone's address book says nothing about where two people met.
      tagNames: ["address-book"],
    };
  },

  /**
   * Contact details only — deliberately narrower than the Google and Outlook adapters.
   *
   * `bulkMergeContactsForUser` writes `COALESCE(incoming, existing)`: whatever is passed here
   * REPLACES what the contact has, it does not fill blanks. An address book is the stalest
   * source Orbit imports — the card for a friend still says the job they had when you saved
   * their number — so passing company and title would let it overwrite the current role a
   * LinkedIn import put there. And rewriting `source`/`howMet` would erase how you actually
   * know someone you already had, just because they are also in your phone. What an address
   * book is genuinely good for is how to reach a person, so that is all a merge takes.
   */
  toMerge(payload) {
    return {
      email: payload.email || undefined,
      phone: payload.phone || undefined,
      linkedinUrl: payload.linkedinUrl || undefined,
    };
  },
};
