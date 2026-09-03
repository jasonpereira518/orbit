/**
 * `resolveUnresolvedMentionToContact`/`dismissUnresolvedMention`'s DB logic, with no auth
 * dependency, so `scripts/smoke-unresolved-mentions-resolve.ts` can drive it against PGlite.
 * `src/actions/unresolved-mentions.ts` is a thin `"use server"` wrapper.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, unresolvedMentions } from "@/db/schema";

async function loadPendingMention(userId: string, mentionId: string) {
  const db = await getDb();
  const row = await db.query.unresolvedMentions.findFirst({
    where: and(eq(unresolvedMentions.id, mentionId), eq(unresolvedMentions.userId, userId)),
  });
  if (!row) throw new Error("Mention not found");
  // Already-resolved is a no-op, not an error: a double-click from a stale client should not surface a scary message.
  if (row.status !== "pending") return null;
  return row;
}

export async function resolveUnresolvedMentionForUser(
  userId: string,
  mentionId: string,
  contactId: string
): Promise<{ alreadyResolved: boolean; nearContactId?: string | null }> {
  const row = await loadPendingMention(userId, mentionId);
  if (!row) return { alreadyResolved: true };
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true },
  });
  if (!contact) throw new Error("Contact not found");
  await db
    .update(unresolvedMentions)
    .set({ status: "resolved", resolvedContactId: contactId, resolvedAt: new Date() })
    .where(and(eq(unresolvedMentions.id, mentionId), eq(unresolvedMentions.userId, userId)));
  if (row.interactionId) {
    await db
      .insert(interactionMentions)
      .values({ userId, interactionId: row.interactionId, contactId, mentionText: row.mentionText, confidence: 0.6, matchedBy: "user_pick" })
      .onConflictDoNothing({ target: [interactionMentions.interactionId, interactionMentions.contactId] });
  }
  return { alreadyResolved: false, nearContactId: row.nearContactId };
}

export async function dismissUnresolvedMentionForUser(userId: string, mentionId: string): Promise<{ alreadyResolved: boolean }> {
  const row = await loadPendingMention(userId, mentionId);
  if (!row) return { alreadyResolved: true };
  const db = await getDb();
  await db
    .update(unresolvedMentions)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(and(eq(unresolvedMentions.id, mentionId), eq(unresolvedMentions.userId, userId)));
  return { alreadyResolved: false };
}
