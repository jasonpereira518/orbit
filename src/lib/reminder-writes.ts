/**
 * Creating and rescheduling reminders, as functions that take a `userId`.
 *
 * These bodies used to live inside `src/actions/reminders.ts`. They moved here so the MCP
 * server can reach them: a server action starts with `requireUserId()`, which asks Clerk for
 * a browser session that an assistant's request does not have and never will. The actions are
 * now thin wrappers — they resolve the user, call these, and revalidate the paths a page
 * render needs. A tool call has no page to revalidate.
 *
 * Nothing about the writes changed in the move; the comments explaining *why* each write
 * looks the way it does travelled with the code.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders, type ReminderActionKind } from "@/db/schema";
import {
  inferReminderActionKind,
  isReminderActionKind,
} from "@/lib/reminder-action-kind";
import { findReminderListForUser, getInboxListId } from "@/lib/reminder-lists";

export type CreateReminderInput = {
  contactId?: string;
  title: string;
  description?: string;
  dueDate?: string;
  reminderType?: string;
  listId?: string;
  actionKind?: ReminderActionKind;
};

export async function createReminderForUser(userId: string, input: CreateReminderInput) {
  const db = await getDb();
  const inboxId = await getInboxListId(userId);

  let listId = input.listId || inboxId;
  if (input.listId) {
    const list = await findReminderListForUser(userId, input.listId);
    if (!list) throw new Error("List not found");
    listId = list.id;
  }

  const actionKind =
    input.actionKind && isReminderActionKind(input.actionKind)
      ? input.actionKind
      : inferReminderActionKind({
          title: input.title,
          description: input.description,
          reminderType: input.reminderType,
          contactId: input.contactId,
        });

  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      listId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      reminderType: input.reminderType || "manual",
      actionKind,
      createdBy: "user",
      status: "pending",
    })
    .returning();

  return row;
}

/**
 * Put a contact back on the calendar in `days` days, reusing their pending reminder if one
 * exists.
 *
 * The 1..90 clamp is shared with `snoozeReminder`: both write `contacts.nextFollowUpAt` for
 * the same contact by different routes, so they must not disagree about what a day means.
 */
export async function scheduleContactFollowUpForUser(
  userId: string,
  contactId: string,
  days = 7
) {
  const db = await getDb();
  const inboxId = await getInboxListId(userId);

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const due = new Date();
  due.setDate(due.getDate() + Math.max(1, Math.min(90, days)));
  const name = contact.preferredName || contact.fullName;
  const title = `Follow up with ${name}`;
  const actionKind = inferReminderActionKind({
    title,
    reminderType: "manual",
    contactId,
  });

  const existing = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.contactId, contactId),
      eq(reminders.status, "pending")
    ),
  });

  let row;
  if (existing) {
    // Rescheduling changes WHEN a follow-up is due, not WHAT it says.
    //
    // This used to also write `title`, `reminderType` and `actionKind`, which meant
    // pressing a day preset on the dashboard silently renamed the reminder: a
    // hand-written "Send Priya the deck" became "Follow up with Priya", and its type
    // was reset to "manual". The generated `title`/`actionKind` above are still
    // correct for the INSERT below, where there is no existing wording to protect.
    const [updated] = await db
      .update(reminders)
      .set({
        dueDate: due,
        listId: existing.listId || inboxId,
      })
      .where(eq(reminders.id, existing.id))
      .returning();
    row = updated;
  } else {
    const [created] = await db
      .insert(reminders)
      .values({
        userId,
        contactId,
        listId: inboxId,
        title,
        dueDate: due,
        reminderType: "manual",
        actionKind,
        createdBy: "user",
        status: "pending",
      })
      .returning();
    row = created;
  }

  await db
    .update(contacts)
    .set({
      nextFollowUpAt: due,
      followUpStatus: "pending",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  return { reminder: row, dueDate: due.toISOString(), days };
}
