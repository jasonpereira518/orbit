/**
 * Follow-up scheduling for the extension.
 *
 * A follow-up has to exist in two places to be real: `contacts.nextFollowUpAt`
 * drives the dashboard's "due follow-ups" list, while a `reminders` row is what
 * shows up on /reminders and in the notification panel. Writing only the
 * contact column produces a follow-up that is invisible in half the app, so
 * this mirrors what `snoozeReminder` already does and keeps both in step.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { snoozeReminder } from "@/lib/reminders";
import { ContactNotFoundError } from "@/lib/contact-writes";
import type { FollowUpInput } from "./contract";

export type ScheduleResult = {
  contactId: string;
  nextFollowUpAt: Date | null;
  reminderId: string | null;
};

/** Resolve `{ at }` / `{ inDays }` into a concrete timestamp, or null to clear. */
export function resolveFollowUpDate(input: FollowUpInput): Date | null {
  if ("inDays" in input) {
    const due = new Date();
    due.setDate(due.getDate() + input.inDays);
    return due;
  }
  if (!input.at) return null;
  const parsed = new Date(
    input.at.length <= 10 ? `${input.at}T12:00:00` : input.at
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function scheduleContactFollowUp(
  userId: string,
  params: {
    contactId: string;
    followUp: FollowUpInput;
    /** Snooze this existing reminder rather than creating another one. */
    reminderId?: string;
    title?: string;
  }
): Promise<ScheduleResult> {
  const db = await getDb();
  const due = resolveFollowUpDate(params.followUp);

  const contact = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.id, params.contactId),
      eq(contacts.userId, userId)
    ),
    columns: { id: true, fullName: true },
  });
  if (!contact) throw new ContactNotFoundError();

  // Snoozing an existing reminder is already handled, including the contact
  // column — don't reimplement it.
  if (params.reminderId && due) {
    const days = Math.max(
      0,
      Math.round((due.getTime() - Date.now()) / 86_400_000)
    );
    await snoozeReminder(userId, params.reminderId, days);
    return {
      contactId: contact.id,
      nextFollowUpAt: due,
      reminderId: params.reminderId,
    };
  }

  await db
    .update(contacts)
    .set({
      nextFollowUpAt: due,
      followUpStatus: due ? "pending" : "none",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

  // Clearing: drop the generated reminders we own so the two views agree.
  if (!due) {
    await db
      .delete(reminders)
      .where(
        and(
          eq(reminders.userId, userId),
          eq(reminders.contactId, contact.id),
          eq(reminders.createdBy, "extension"),
          eq(reminders.status, "pending")
        )
      );
    return { contactId: contact.id, nextFollowUpAt: null, reminderId: null };
  }

  const [reminder] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: contact.id,
      title: params.title?.trim() || `Follow up with ${contact.fullName}`,
      dueDate: due,
      status: "pending",
      reminderType: "manual",
      actionKind: "follow_up",
      createdBy: "extension",
    })
    .returning();

  return {
    contactId: contact.id,
    nextFollowUpAt: due,
    reminderId: reminder?.id ?? null,
  };
}
