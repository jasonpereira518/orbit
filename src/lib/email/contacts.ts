import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { findIdentityOwners } from "@/lib/contact-identity";
import { identityKeysFor } from "@/lib/duplicates";

/**
 * The contacts a set of recipient addresses belong to, for interaction logging. Matches the
 * contact's primary `email` (case-insensitive) and its `contact_identities` email keys — the
 * same normalizer duplicate detection uses, so a match here is a match there. Role addresses
 * (`isRoleEmail`) have no identity key and match only by primary email.
 */
export async function resolveRecipientContacts(userId: string, emails: string[]): Promise<string[]> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const db = await getDb();

  const byEmail = new Map<string, string>();
  const primary = await db
    .select({ id: contacts.id, email: sql<string>`lower(${contacts.email})` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(sql`lower(${contacts.email})`, wanted)));
  for (const row of primary) if (!byEmail.has(row.email)) byEmail.set(row.email, row.id);

  const keys = wanted.flatMap((email) => identityKeysFor({ email }).filter((k) => k.kind === "email"));
  for (const owner of await findIdentityOwners(userId, keys)) {
    const email = owner.key.value.toLowerCase();
    if (!byEmail.has(email)) byEmail.set(email, owner.contactId);
  }

  const ordered: string[] = [];
  for (const email of wanted) {
    const id = byEmail.get(email);
    if (id && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}
