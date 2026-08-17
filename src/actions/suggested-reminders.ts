"use server";

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contacts,
  reminders,
  suggestedReminders,
  type ReminderActionKind,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  EXTRACTED_DATE_REMINDER_TYPE,
  isoDayToLocalNoon,
} from "@/lib/suggested-reminder-utils";
import { revalidateReminderPaths } from "@/lib/reminder-paths";
import { getInboxListId, findReminderListForUser } from "@/lib/reminder-lists";
import {
  inferReminderActionKind,
  isReminderActionKind,
} from "@/lib/reminder-action-kind";

export type SuggestedReminderRow = {
  id: string;
  title: string;
  description: string | null;
  rawDatePhrase: string;
  dueDate: Date;
  yearInferred: boolean;
  sourceExcerpt: string;
  actionKind: ReminderActionKind;
  confidenceScore: number | null;
  contactId: string | null;
  contactName: string | null;
  createdAt: Date;
};

export async function listSuggestedReminders(options?: {
  status?: "pending" | "all";
  limit?: number;
}): Promise<SuggestedReminderRow[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const status = options?.status ?? "pending";

  const rows = await db.query.suggestedReminders.findMany({
    where:
      status === "all"
        ? eq(suggestedReminders.userId, userId)
        : and(
            eq(suggestedReminders.userId, userId),
            eq(suggestedReminders.status, "pending")
          ),
    orderBy: [asc(suggestedReminders.dueDate)],
    limit: options?.limit ?? 50,
  });

  if (!rows.length) return [];

  // Resolve contact names with one query and a map, matching listRemindersPage.
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))];
  const nameById = new Map<string, string>();
  if (contactIds.length) {
    const people = await db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        inArray(contacts.id, contactIds as string[])
      ),
      columns: { id: true, fullName: true, preferredName: true },
    });
    for (const p of people) {
      nameById.set(p.id, p.preferredName || p.fullName);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    rawDatePhrase: r.rawDatePhrase,
    dueDate: r.dueDate,
    yearInferred: r.yearInferred === 1,
    sourceExcerpt: r.sourceExcerpt,
    actionKind: r.actionKind,
    confidenceScore: r.confidenceScore,
    contactId: r.contactId,
    contactName: r.contactId ? nameById.get(r.contactId) ?? null : null,
    createdAt: r.createdAt,
  }));
}

async function loadPendingSuggestion(userId: string, id: string) {
  const db = await getDb();
  const row = await db.query.suggestedReminders.findFirst({
    where: and(
      eq(suggestedReminders.id, id),
      eq(suggestedReminders.userId, userId)
    ),
  });
  if (!row) throw new Error("Suggestion not found");
  // Throwing on an already-resolved row makes a double-submit from a stale client
  // a no-op error rather than a duplicate reminder.
  if (row.status !== "pending") throw new Error("Suggestion already resolved");
  return row;
}

export async function confirmSuggestedReminder(
  id: string,
  patch?: {
    title?: string;
    description?: string | null;
    /** YYYY-MM-DD */
    dueDate?: string;
    contactId?: string | null;
    listId?: string | null;
    actionKind?: ReminderActionKind;
  }
) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await loadPendingSuggestion(userId, id);

  const title = patch?.title?.trim() || row.title;
  const description =
    patch?.description !== undefined ? patch.description : row.description;
  const dueDate = patch?.dueDate
    ? isoDayToLocalNoon(patch.dueDate)
    : row.dueDate;
  const contactId =
    patch?.contactId !== undefined ? patch.contactId : row.contactId;

  let listId = patch?.listId || (await getInboxListId(userId));
  if (patch?.listId) {
    const list = await findReminderListForUser(userId, patch.listId);
    if (!list) throw new Error("List not found");
    listId = list.id;
  }

  const actionKind =
    patch?.actionKind && isReminderActionKind(patch.actionKind)
      ? patch.actionKind
      : isReminderActionKind(row.actionKind)
        ? row.actionKind
        : inferReminderActionKind({
            title,
            description,
            reminderType: EXTRACTED_DATE_REMINDER_TYPE,
            contactId,
          });

  // Inserted directly rather than via createReminder, which hardcodes
  // createdBy: "user". These are AI-originated and must record that.
  const [reminder] = await db
    .insert(reminders)
    .values({
      userId,
      contactId,
      listId,
      title,
      description,
      dueDate,
      status: "pending",
      reminderType: EXTRACTED_DATE_REMINDER_TYPE,
      actionKind,
      createdBy: "ai",
    })
    .returning();

  await db
    .update(suggestedReminders)
    .set({
      status: "confirmed",
      reminderId: reminder.id,
      resolvedAt: new Date(),
      contactId,
    })
    .where(
      and(
        eq(suggestedReminders.id, id),
        eq(suggestedReminders.userId, userId)
      )
    );

  revalidateReminderPaths(contactId);
  return { reminderId: reminder.id, contactId };
}

export async function discardSuggestedReminder(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await loadPendingSuggestion(userId, id);

  // Marked, never deleted — the row is what stops a re-paste from re-suggesting it.
  await db
    .update(suggestedReminders)
    .set({ status: "discarded", resolvedAt: new Date() })
    .where(
      and(
        eq(suggestedReminders.id, id),
        eq(suggestedReminders.userId, userId)
      )
    );

  revalidateReminderPaths(row.contactId);
}

export async function confirmSuggestedReminders(ids: string[]) {
  let confirmed = 0;
  for (const id of ids) {
    try {
      await confirmSuggestedReminder(id);
      confirmed += 1;
    } catch {
      // Already resolved elsewhere — skip rather than failing the whole batch.
    }
  }
  return { confirmed };
}

export async function discardSuggestedReminders(ids: string[]) {
  let discarded = 0;
  for (const id of ids) {
    try {
      await discardSuggestedReminder(id);
      discarded += 1;
    } catch {
      // Already resolved elsewhere — skip.
    }
  }
  return { discarded };
}
