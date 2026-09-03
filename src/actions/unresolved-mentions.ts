"use server";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, unresolvedMentions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { revalidateMentionPaths } from "@/lib/reminder-paths";
import { dismissUnresolvedMentionForUser, resolveUnresolvedMentionForUser } from "@/lib/unresolved-mentions";

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

export async function resolveUnresolvedMentionToContact(mentionId: string, contactId: string): Promise<{ alreadyResolved: boolean }> {
  const userId = await requireUserId();
  const result = await resolveUnresolvedMentionForUser(userId, mentionId, contactId);
  if (!result.alreadyResolved) revalidateMentionPaths(contactId, result.nearContactId);
  return { alreadyResolved: result.alreadyResolved };
}

export async function dismissUnresolvedMention(mentionId: string): Promise<{ alreadyResolved: boolean }> {
  const userId = await requireUserId();
  const result = await dismissUnresolvedMentionForUser(userId, mentionId);
  if (!result.alreadyResolved) revalidateMentionPaths(null);
  return result;
}
