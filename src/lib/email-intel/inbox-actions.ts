/**
 * Adding, or dismissing, a person from the "From your inbox" strip. Request-free, so the
 * smoke drives the same code the server actions do (`src/actions/radar.ts`).
 *
 * ## The client sends a key and nothing else
 *
 * The key is the person's address, as `loadInboxPeople` offered it. The name, the title and
 * the address that go into the contact are read again here from the stored event, through the
 * same filters, so a forged or stale request can only ever add someone the strip would have
 * offered this account a moment ago. It cannot put chosen text on a contact, and it cannot
 * add anyone from another account's mail.
 *
 * ## Adding goes through the one way every contact is made
 *
 * `resolveOrCreateContact`: plan caps, identity claims, duplicate handling. The contact gets a
 * name, the address and the title the email gave, and `source: "email_intel"`. No company (an
 * agency recruiter's company is not the company the email is about), no notes, and no summary
 * of the email: a contact is the person's own data and outlives the mail it came from.
 */
import { PaywallError } from "@/lib/entitlements";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { upsertIgnoredPeople } from "@/lib/ignored-people";
import { findInboxPerson } from "./inbox-people";
import { EMAIL_INTEL_CONTACT_SOURCE, INBOX_IGNORED_CONTEXT } from "./types";

export type InboxAddResult =
  | { ok: true; contactId: string; name: string; created: boolean }
  | { ok: false; reason: "gone" | "limit"; message: string };

export const INBOX_GONE_MESSAGE = "That suggestion has already changed — refresh to see the latest";

const WRITE_OPTIONS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;

export async function addInboxPersonForUser(userId: string, key: string, now: Date = new Date()): Promise<InboxAddResult> {
  const person = await findInboxPerson(userId, key, now);
  if (!person) return { ok: false, reason: "gone", message: INBOX_GONE_MESSAGE };
  try {
    const out = await resolveOrCreateContact(
      userId,
      {
        fullName: person.name,
        email: person.key,
        title: person.title ?? undefined,
        source: EMAIL_INTEL_CONTACT_SOURCE,
      },
      WRITE_OPTIONS
    );
    return { ok: true, contactId: out.contactId, name: person.name, created: out.outcome === "created" };
  } catch (err) {
    // The plan cap is a fact about the account, not a fault: say it as itself.
    if (err instanceof PaywallError) return { ok: false, reason: "limit", message: err.message };
    throw err;
  }
}

/**
 * Dismiss: the name goes on the set-aside list (`ignored_people`), which the strip checks, so
 * they are not offered again. Idempotent: someone no longer offered is already dealt with.
 */
export async function dismissInboxPersonForUser(userId: string, key: string, now: Date = new Date()): Promise<{ ok: true }> {
  const person = await findInboxPerson(userId, key, now);
  if (person) {
    await upsertIgnoredPeople(userId, [{ displayName: person.name, reason: "rejected", context: INBOX_IGNORED_CONTEXT }]);
  }
  return { ok: true };
}
