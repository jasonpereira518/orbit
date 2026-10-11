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
import { completeReminder, reopenReminder, restoreLastTouch, type CompletionSnapshot } from "@/lib/reminders";
import { cadenceDueAt, effectiveCadenceDays } from "@/lib/keep-in-touch";
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
 * Put a contact back on the calendar, `when` being a day count (clamped 1..90) or an exact
 * instant, reusing their pending reminder if one
 * exists.
 *
 * The 1..90 clamp is shared with `snoozeReminder`: both write `contacts.nextFollowUpAt` for
 * the same contact by different routes, so they must not disagree about what a day means.
 */
export async function scheduleContactFollowUpForUser(
  userId: string,
  contactId: string,
  when: number | Date = 7
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

  const due =
    when instanceof Date
      ? new Date(when.getTime())
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() + Math.max(1, Math.min(90, when)));
          return d;
        })();
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

  const days = Math.max(1, Math.round((due.getTime() - Date.now()) / 86_400_000));
  return { reminder: row, dueDate: due.toISOString(), days };
}

/** What `clearContactFollowUpForUser` changed, so an Undo can put exactly that back. */
export type ClearFollowUpSnapshot = {
  contactId: string;
  previousNextFollowUpAt: string | null;
  previousFollowUpStatus: string | null;
  completions: CompletionSnapshot[];
  /** Set when Clear rebooked the clock one cadence out instead of nulling it; Undo matches on it. */
  rebookedTo?: string;
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
    columns: {
      nextFollowUpAt: true, followUpStatus: true, cadenceDays: true, closenessTier: true,
      closenessEvidence: true, lastInteractionAt: true, dateMet: true, createdAt: true,
    },
  });
  // A lapsed cadence would bring the contact straight back as due, so Clear books the next
  // one a cadence out instead (spec C3). No cadence, or not lapsed: nothing booked, as before.
  const now = new Date();
  const days = before ? effectiveCadenceDays(before) : null;
  const lapsedAt = before && days !== null ? cadenceDueAt({ ...before, nextFollowUpAt: null }) : null;
  const rebookedTo = lapsedAt && days !== null && lapsedAt.getTime() <= now.getTime()
    ? new Date(now.getTime() + days * 86_400_000)
    : null;
  await db
    .update(contacts)
    .set({ nextFollowUpAt: rebookedTo, followUpStatus: rebookedTo ? "pending" : "none", updatedAt: now })
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
      ...(rebookedTo ? { rebookedTo: rebookedTo.toISOString() } : {}),
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
        .where(and(
          eq(contacts.id, snap.contactId),
          eq(contacts.userId, userId),
          snap.rebookedTo ? eq(contacts.nextFollowUpAt, new Date(snap.rebookedTo)) : isNull(contacts.nextFollowUpAt)
        ))
        .returning() // bare: a field selector breaks over the Db union
    : [];
  return { restored: reopened > 0 || clock.length > 0 };
}

/** What `markKeepInTouchDoneForUser` changed, for its Undo. */
export type KeepInTouchDoneSnapshot = {
  contactId: string;
  previousLastInteractionAt: string | null;
  touchedAt: string;
};

/**
 * Done on a cadence-due contact: the last touch moves to now (no interaction row), so the
 * cadence restarts. Null when the contact is not this user's.
 */
export async function markKeepInTouchDoneForUser(
  userId: string,
  contactId: string
): Promise<KeepInTouchDoneSnapshot | null> {
  const db = await getDb();
  const before = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { lastInteractionAt: true },
  });
  if (!before) return null;
  const touchedAt = new Date();
  await db
    .update(contacts)
    .set({ lastInteractionAt: touchedAt, updatedAt: touchedAt })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  return {
    contactId,
    previousLastInteractionAt: before.lastInteractionAt ? before.lastInteractionAt.toISOString() : null,
    touchedAt: touchedAt.toISOString(),
  };
}

/** Reverse a `markKeepInTouchDoneForUser`, only while the stamp is still the latest touch. */
export async function undoKeepInTouchDoneForUser(
  userId: string,
  snap: KeepInTouchDoneSnapshot
): Promise<{ restored: boolean }> {
  return { restored: await restoreLastTouch(userId, snap) };
}
