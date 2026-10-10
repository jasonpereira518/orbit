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
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders, type ReminderActionKind } from "@/db/schema";
import {
  inferReminderActionKind,
  isReminderActionKind,
} from "@/lib/reminder-action-kind";
import { findReminderListForUser, getInboxListId } from "@/lib/reminder-lists";
import { revalidatePathIfRequestScoped, revalidateReminderPaths } from "@/lib/reminder-paths";
import { completeReminder, reopenReminder, type CompletionSnapshot } from "@/lib/reminders";
import { settle, unwrap } from "@/lib/settled";

export type CreateReminderInput = {
  contactId?: string;
  title: string;
  description?: string;
  dueDate?: string;
  reminderType?: string;
  listId?: string;
  actionKind?: ReminderActionKind;
};

/**
 * The tenant check every contact-scoped reminder write needs. A reminder's contactId is a
 * client-supplied reference, and a foreign one would pull another account's contact name
 * into this user's reminders and calendar feed.
 */
export async function assertReminderContactOwned(userId: string, contactId: string | null | undefined) {
  if (!contactId) return;
  const db = await getDb();
  const owned = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true },
  });
  if (!owned) throw new Error("Contact not found");
}

export async function createReminderForUser(userId: string, input: CreateReminderInput) {
  const db = await getDb();
  // Moved in from the MCP tool's own ad hoc version of it: a caller that reaches this
  // function some other way — the proposed-action commit in `chat-actions.ts`, today — must
  // not be able to skip it by construction.
  await assertReminderContactOwned(userId, input.contactId);
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
  // The inbox lookup (which lazily creates the Inbox, before any not-found check — as it
  // always has), the contact and its pending reminder need nothing from each other, so all
  // three start together. Outcomes are taken in the old order: an inbox failure first, then
  // the contact read and its not-found, then the reminder. The reminder read is scoped to
  // this user, so starting it before the ownership check reads nothing foreign.
  const inboxRead = settle(getInboxListId(userId));
  const contactRead = settle(db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  }));
  const existingRead = settle(db.query.reminders.findFirst({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.contactId, contactId),
      eq(reminders.status, "pending")
    ),
  }));
  const inboxId = unwrap(await inboxRead);

  const contact = unwrap(await contactRead);
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

  const existing = unwrap(await existingRead);

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

/** What `clearContactFollowUpForUser` changed, so an Undo can put exactly that back. */
export type ClearFollowUpSnapshot = {
  contactId: string;
  previousNextFollowUpAt: string | null;
  previousFollowUpStatus: string | null;
  completions: CompletionSnapshot[];
};

/**
 * Clears a contact's due follow-up and completes every pending reminder for them. Takes a
 * `userId` so the email dispatcher can call it from the drain, where there is no request;
 * `clearContactFollowUp` (the action) is a wrapper. Revalidation is a no-op outside a request.
 */
export async function clearContactFollowUpForUser(
  userId: string,
  contactId: string
): Promise<{ remindersClosed: number; snapshot: ClearFollowUpSnapshot }> {
  const db = await getDb();
  const before = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { nextFollowUpAt: true, followUpStatus: true },
  });
  await db
    .update(contacts)
    .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  const open = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.contactId, contactId), eq(reminders.status, "pending")),
  });
  const completions: CompletionSnapshot[] = [];
  for (const r of open) {
    const snap = await completeReminder(userId, r.id);
    if (snap) completions.push(snap);
  }
  revalidateReminderPaths(contactId);
  revalidatePathIfRequestScoped("/contacts");
  return {
    remindersClosed: open.length,
    snapshot: {
      contactId,
      previousNextFollowUpAt: before?.nextFollowUpAt ? before.nextFollowUpAt.toISOString() : null,
      previousFollowUpStatus: before?.followUpStatus ?? null,
      completions,
    },
  };
}

/**
 * Reverse a `clearContactFollowUpForUser`: each reminder through `reopenReminder` (its own
 * still-done guard), and the clock only while it is still cleared — a follow-up booked since
 * is newer and wins.
 */
export async function undoClearContactFollowUpForUser(
  userId: string,
  snap: ClearFollowUpSnapshot
): Promise<{ restored: boolean }> {
  const db = await getDb();
  let reopened = 0;
  for (const c of snap.completions) {
    if ((await reopenReminder(userId, c)).restored) reopened++;
  }
  const clock = snap.previousNextFollowUpAt
    ? await db
        .update(contacts)
        .set({
          nextFollowUpAt: new Date(snap.previousNextFollowUpAt),
          followUpStatus: snap.previousFollowUpStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, snap.contactId), eq(contacts.userId, userId), isNull(contacts.nextFollowUpAt)))
        .returning() // bare: a field selector breaks over the Db union
    : [];
  return { restored: reopened > 0 || clock.length > 0 };
}
