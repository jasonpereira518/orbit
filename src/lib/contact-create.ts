import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import type { ContactInput, ContactWriteOptions } from "@/lib/contact-writes";

/**
 * `createContactDetailed` for a caller that already knows who the user is.
 *
 * The Server Action of the same name is a public endpoint, so it takes only the person's
 * `ContactInput`. The write options (`skipRevalidate`, `skipEmbedding`, `headroom`, …) are
 * for trusted server paths — outreach, imports — and live here, behind no action id.
 *
 * Returns the contact that survives, which is not always the one inserted: if the record's
 * identifiers already belonged to someone, the data is folded into them and their row
 * comes back instead.
 */
export async function createContactDetailedForUser(
  userId: string,
  input: ContactInput,
  options?: ContactWriteOptions
) {
  const { contactId, outcome, reason } = await resolveOrCreateContact(userId, input, options);
  const db = await getDb();
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, contactId)))
    .limit(1);
  return { contact, outcome, reason: reason ?? null };
}
