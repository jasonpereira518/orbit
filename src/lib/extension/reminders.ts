/**
 * Completing a reminder from the extension panel, and taking it back.
 *
 * Built on the app's own `completeReminder` / `reopenReminder`, with one thing
 * the app's "Done" does not do and the panel must: when the reminder IS the
 * contact's follow-up, clear the contact's follow-up clock too.
 *
 * A follow-up lives in two places (see `follow-ups.ts`): `contacts.nextFollowUpAt`
 * and a reminders row. The panel's overdue banner reads the contact column, so
 * completing only the row left "Follow-up was due 3 weeks ago" on screen above
 * the thing the user had just marked done. The obvious fix — the app's
 * `clearContactFollowUp` — is too broad: it completes EVERY pending reminder
 * for the contact. Here only the one reminder is completed, and the column is
 * cleared only when it demonstrably belongs to that reminder (same instant),
 * which is exactly how `scheduleContactFollowUp` and `snoozeReminder` write
 * the pair.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { completeReminder, reopenReminder } from "@/lib/reminders";
import type { ReminderCompletion } from "./contract";
import { ExtensionRouteError } from "./http";

export async function completeReminderFromExtension(
  userId: string,
  reminderId: string
): Promise<ReminderCompletion> {
  const db = await getDb();
  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { id: true, contactId: true, dueDate: true },
  });
  // Same answer for "missing" and "someone else's": never confirm an id exists.
  if (!reminder) throw new ExtensionRouteError("not_found", "Reminder not found.");

  const completed = await completeReminder(userId, reminderId);
  if (!completed) throw new ExtensionRouteError("not_found", "Reminder not found.");

  let clearedFollowUpAt: string | null = null;
  if (reminder.contactId && reminder.dueDate) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId)),
      columns: { nextFollowUpAt: true },
    });
    const clock = contact?.nextFollowUpAt;
    if (clock && clock.getTime() === reminder.dueDate.getTime()) {
      await db
        .update(contacts)
        .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: new Date() })
        .where(and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId)));
      clearedFollowUpAt = clock.toISOString();
    }
  }

  return {
    ...completed,
    contactId: reminder.contactId ?? null,
    clearedFollowUpAt,
  };
}

/**
 * Undo a completion: the reminder, the action items that completion closed,
 * and — only if nothing has set a new one since — the follow-up clock.
 */
export async function reopenReminderFromExtension(
  userId: string,
  completion: ReminderCompletion
): Promise<{ restored: boolean }> {
  const { restored } = await reopenReminder(userId, completion);
  if (!restored) return { restored };

  if (completion.contactId && completion.clearedFollowUpAt) {
    const at = new Date(completion.clearedFollowUpAt);
    if (!Number.isNaN(at.getTime())) {
      const db = await getDb();
      // `isNull` is the "nothing has moved on" guard: if the user scheduled a
      // fresh follow-up in the meantime, undoing an old completion must not
      // overwrite it.
      await db
        .update(contacts)
        .set({ nextFollowUpAt: at, followUpStatus: "pending", updatedAt: new Date() })
        .where(
          and(
            eq(contacts.id, completion.contactId),
            eq(contacts.userId, userId),
            isNull(contacts.nextFollowUpAt)
          )
        );
    }
  }
  return { restored };
}
