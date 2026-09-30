/**
 * Mapping the people an email names to contacts the user already has.
 *
 * **Resolved on read, never stored.** A contact id held inside `email_events.people` would
 * have to survive `mergeContacts` (which repoints child rows by id and replays them on
 * `unmergeContacts`, and cannot see ids inside a JSON column), a deletion, and a contact
 * added after the email arrived. Looking the address up in `contact_identities` each time has
 * none of those problems: merge already moves those rows to the winner, a deleted contact
 * takes its identity rows with it, and a new contact resolves at once. Email is the only key:
 * a name match is how duplicates get made.
 */
import { findIdentityOwners } from "@/lib/contact-identity";
import { identityKeysFor } from "@/lib/duplicates";
import type { EmailEventPerson } from "./types";

export type ResolvedPerson = EmailEventPerson & {
  /** The contact that holds this person's address right now, or null. */
  contactId: string | null;
  /** Unresolved but named: worth offering as an "Add to Orbit" suggestion. */
  suggestAdd: boolean;
};

/**
 * The address as `contact_identities` stores it, or null when it cannot be an identity. The
 * rule is `identityKeysFor`'s, so a lookup can never use a spelling no contact could hold.
 */
export function normalizedEmail(email: string | null | undefined): string | null {
  return identityKeysFor({ email }).find((k) => k.kind === "email")?.value ?? null;
}

/** Normalized email → contact id, for the addresses some contact of this user holds. */
export async function resolveEmails(userId: string, emails: string[]): Promise<Map<string, string>> {
  const values = new Set<string>();
  for (const email of emails) {
    const normalized = normalizedEmail(email);
    if (normalized) values.add(normalized);
  }
  if (values.size === 0) return new Map();
  const owners = await findIdentityOwners(
    userId,
    [...values].map((value) => ({ kind: "email" as const, value }))
  );
  return new Map(owners.filter((o) => o.key.kind === "email").map((o) => [o.key.value, o.contactId]));
}

export async function resolvePeople(userId: string, people: EmailEventPerson[]): Promise<ResolvedPerson[]> {
  const owners = await resolveEmails(userId, people.map((p) => p.email ?? ""));
  return people.map((p) => {
    const normalized = normalizedEmail(p.email);
    const contactId = (normalized ? owners.get(normalized) : undefined) ?? null;
    return { ...p, contactId, suggestAdd: contactId === null && Boolean(p.name?.trim()) };
  });
}
