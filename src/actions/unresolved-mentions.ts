"use server";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, unresolvedMentions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { revalidateMentionPaths } from "@/lib/reminder-paths";

export type UnresolvedMentionRow = {
  id: string;
  mentionText: string;
  context: string | null;
  createdAt: Date;
  nearContactId: string | null;
  nearContactName: string | null;
  interactionId: string | null;
};

export async function listUnresolvedMentions(): Promise<UnresolvedMentionRow[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .select({
      id: unresolvedMentions.id,
      mentionText: unresolvedMentions.mentionText,
      context: unresolvedMentions.context,
      createdAt: unresolvedMentions.createdAt,
      interactionId: unresolvedMentions.interactionId,
      nearContactId: contacts.id,
      nearContactName: contacts.fullName,
    })
    .from(unresolvedMentions)
    .leftJoin(contacts, eq(contacts.id, unresolvedMentions.nearContactId))
    .where(and(eq(unresolvedMentions.userId, userId), eq(unresolvedMentions.status, "pending")))
    .orderBy(desc(unresolvedMentions.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, nearContactId: r.nearContactId ?? null, nearContactName: r.nearContactName ?? null }));
}

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

export async function resolveUnresolvedMentionToContact(mentionId: string, contactId: string): Promise<void> {
  const userId = await requireUserId();
  const row = await loadPendingMention(userId, mentionId);
  if (!row) return;
  const db = await getDb();
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
  revalidateMentionPaths(contactId);
}

export async function dismissUnresolvedMention(mentionId: string): Promise<void> {
  const userId = await requireUserId();
  const row = await loadPendingMention(userId, mentionId);
  if (!row) return;
  const db = await getDb();
  await db
    .update(unresolvedMentions)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(and(eq(unresolvedMentions.id, mentionId), eq(unresolvedMentions.userId, userId)));
  revalidateMentionPaths(null);
}
