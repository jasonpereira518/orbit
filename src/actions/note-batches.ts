"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, noteBatches, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { dismissNoteReminderForUser, undoNoteBatchForUser } from "@/lib/note-batch-save";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export async function getNoteBatch(batchId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const batch = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)),
  });
  if (!batch) return null;

  const reminderIds = batch.result.reminders.map((r) => r.id);
  const contactIds = [
    ...new Set([
      ...batch.result.participants.map((p) => p.contactId),
      ...batch.result.mentions.map((m) => m.contactId),
      ...batch.result.reminders.map((r) => r.contactId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const [reminderRows, contactRows] = await Promise.all([
    reminderIds.length
      ? db.select({ id: reminders.id, status: reminders.status }).from(reminders).where(and(eq(reminders.userId, userId), inArray(reminders.id, reminderIds)))
      : Promise.resolve([]),
    contactIds.length
      ? db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)))
      : Promise.resolve([]),
  ]);
  return {
    ...batch,
    reminderStatus: Object.fromEntries(reminderRows.map((r) => [r.id, r.status])),
    contactNames: Object.fromEntries(contactRows.map((c) => [c.id, c.fullName])),
  };
}

export async function undoNoteBatch(batchId: string) {
  const userId = await requireUserId();
  const out = await undoNoteBatchForUser(userId, batchId);
  revalidateReminderPaths();
  revalidatePath(`/capture/${batchId}`);
  revalidatePath("/contacts");
  return out;
}

export async function dismissNoteReminder(reminderId: string) {
  const userId = await requireUserId();
  await dismissNoteReminderForUser(userId, reminderId);
  revalidateReminderPaths();
}
