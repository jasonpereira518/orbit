/**
 * Guards every Undo the toasts offer.
 *
 * An Undo that quietly under-restores is worse than no Undo: the toast says "Undone",
 * the person believes it, and the state is subtly different from before. So each case
 * here performs an action, undoes it, and asserts the rows are back EXACTLY — including
 * the dependent rows an inverse is easy to forget.
 *
 * The two cases most worth keeping:
 *
 *   1. Completing a reminder closes its open action items. It used to close ALL of them,
 *      re-stamping `completedAt` on items finished days earlier. So a reopen that set
 *      every linked item back to open would have reopened work the person had already
 *      done. Asserted: only the items this completion closed come back, and an item that
 *      was already done keeps both its status and its original `completedAt`.
 *   2. Snooze writes `contacts.nextFollowUpAt`, which the dashboard's day presets also
 *      write. An Undo arriving after a newer reschedule must leave the newer value alone
 *      rather than clobber it.
 *
 * Run: npx tsx scripts/smoke-toast-undo.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  aiSuggestions,
  contacts,
  interactions,
  reminderLists,
  reminders,
  suggestedReminders,
  userGoals,
  userSettings,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  completeReminder,
  reopenReminder,
  snoozeReminder,
  unsnoozeReminder,
} from "../src/lib/reminders";
import {
  dismissSuggestion,
  restoreSuggestion,
  scheduleContactFollowUp,
  unsnoozeReminderAction,
  reopenReminderAction,
  bulkReminderAction,
  createReminderList,
  deleteReminderAction,
  rescheduleReminderAction,
  restoreReminderAction,
  undoBulkReminderAction,
} from "../src/actions/reminders";
import {
  discardSuggestedReminder,
  restoreSuggestedReminder,
} from "../src/actions/suggested-reminders";
import { deleteGoal, restoreGoal } from "../src/actions/goals";

const USER = "demo-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);

async function cleanup() {
  const db = await getDb();
  await db.delete(actionItems).where(eq(actionItems.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(reminderLists).where(eq(reminderLists.userId, USER));
  await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, USER));
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function seedReminder(fullName: string) {
  const db = await getDb();
  const originalDue = new Date();
  originalDue.setDate(originalDue.getDate() - 4);
  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName,
      nextFollowUpAt: originalDue,
      followUpStatus: "pending",
    })
    .returning();
  const [reminder] = await db
    .insert(reminders)
    .values({
      userId: USER,
      contactId: contact.id,
      title: `Follow up with ${fullName}`,
      dueDate: originalDue,
      status: "pending",
    })
    .returning();
  return { contact, reminder, originalDue };
}

async function main() {
  console.log("Toast Undo round-trips");
  // The action-level inverses go through `requireUserId()`, which resolves to demo
  // mode's `demo-user` with no Clerk keys and NODE_ENV=development.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";

  await cleanup();
  const db = await getDb();
  await ensureUserSettings(USER);

  /* ------------------------------------------------------------ snooze → unsnooze */

  {
    const { contact, reminder, originalDue } = await seedReminder("Sam Rivera");
    const snap = await snoozeReminder(USER, reminder.id, 7);
    check("snooze returns what it overwrote", !!snap && snap.previousDueDate !== null);

    const snoozed = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("snooze moved the due date", ms(snoozed?.dueDate) !== ms(originalDue));

    const result = await unsnoozeReminder(USER, snap!);
    check("unsnooze reports it restored", result.restored);

    const after = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("reminder due date is back exactly", ms(after?.dueDate) === ms(originalDue),
      `${after?.dueDate?.toISOString()} vs ${originalDue.toISOString()}`);
    check("reminder status is back", after?.status === "pending");

    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("contact's follow-up clock is back too", ms(c?.nextFollowUpAt) === ms(originalDue));
    check("contact's follow-up status is back", c?.followUpStatus === "pending");
  }

  /* -------------------------------------- an Undo never clobbers a newer reschedule */

  {
    const { contact, reminder } = await seedReminder("Jordan Lee");
    const snap = await snoozeReminder(USER, reminder.id, 7);
    // Something else reschedules the contact in the seconds before Undo is pressed.
    await scheduleContactFollowUp(contact.id, 3);
    const rescheduled = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });

    await unsnoozeReminder(USER, snap!);
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("the newer reschedule survives the Undo", ms(c?.nextFollowUpAt) === ms(rescheduled?.nextFollowUpAt),
      `${c?.nextFollowUpAt?.toISOString()} vs ${rescheduled?.nextFollowUpAt?.toISOString()}`);
  }

  /* ------------------------------------------------------------ complete → reopen */

  {
    const { contact, reminder } = await seedReminder("Priya Nair");
    const [interaction] = await db
      .insert(interactions)
      .values({ userId: USER, contactId: contact.id })
      .returning();
    const finishedEarlier = new Date("2026-08-01T12:00:00.000Z");
    const [alreadyDone] = await db
      .insert(actionItems)
      .values({
        userId: USER,
        contactId: contact.id,
        interactionId: interaction.id,
        reminderId: reminder.id,
        text: "Send the deck",
        itemHash: "hash-already-done",
        status: "done",
        completedAt: finishedEarlier,
      })
      .returning();
    const [stillOpen] = await db
      .insert(actionItems)
      .values({
        userId: USER,
        contactId: contact.id,
        interactionId: interaction.id,
        reminderId: reminder.id,
        text: "Intro her to Marcus",
        itemHash: "hash-still-open",
        status: "open",
      })
      .returning();

    const snap = await completeReminder(USER, reminder.id);
    check("completion reports only the item it closed",
      snap?.closedActionItemIds.length === 1 && snap.closedActionItemIds[0] === stillOpen.id,
      JSON.stringify(snap?.closedActionItemIds));

    const doneAfterComplete = await db.query.actionItems.findFirst({ where: eq(actionItems.id, alreadyDone.id) });
    check("completing no longer re-stamps an item finished earlier",
      ms(doneAfterComplete?.completedAt) === ms(finishedEarlier),
      `${doneAfterComplete?.completedAt?.toISOString()}`);

    const result = await reopenReminder(USER, snap!);
    check("reopen reports it restored", result.restored);

    const r = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("reminder is pending again", r?.status === "pending");

    const reopened = await db.query.actionItems.findFirst({ where: eq(actionItems.id, stillOpen.id) });
    check("the item it closed is open again", reopened?.status === "open" && reopened.completedAt === null);

    const untouched = await db.query.actionItems.findFirst({ where: eq(actionItems.id, alreadyDone.id) });
    check("the item done beforehand stays done", untouched?.status === "done");
    check("…with its original completedAt", ms(untouched?.completedAt) === ms(finishedEarlier));

    const again = await reopenReminder(USER, snap!);
    check("reopening a reminder that is no longer done does nothing", again.restored === false);
  }

  /* ------------------------------------------------ dismiss suggestion → restore */

  {
    const [s] = await db
      .insert(aiSuggestions)
      .values({ userId: USER, suggestionType: "follow_up", title: "Reconnect with Ana", status: "pending" })
      .returning();
    await dismissSuggestion(s.id);
    const dismissed = await db.query.aiSuggestions.findFirst({ where: eq(aiSuggestions.id, s.id) });
    check("dismiss marks it dismissed", dismissed?.status === "dismissed");

    const result = await restoreSuggestion(s.id);
    const back = await db.query.aiSuggestions.findFirst({ where: eq(aiSuggestions.id, s.id) });
    check("restore puts it back to pending", result.restored && back?.status === "pending");

    const noop = await restoreSuggestion(s.id);
    check("restoring one that is not dismissed does nothing", noop.restored === false);
  }

  /* ---------------------------------- discard suggested reminder → restore */

  {
    const [sr] = await db
      .insert(suggestedReminders)
      .values({
        userId: USER,
        captureBatchId: randomUUID(),
        title: "Send Ana the recording",
        rawDatePhrase: "Friday",
        dueDate: new Date(),
        sourceExcerpt: "I'll send Ana the recording Friday",
        sourceHash: "src-hash",
        itemHash: "item-hash-sr",
        status: "pending",
      })
      .returning();
    await discardSuggestedReminder(sr.id);
    const discarded = await db.query.suggestedReminders.findFirst({ where: eq(suggestedReminders.id, sr.id) });
    check("discard keeps the row, marked discarded", discarded?.status === "discarded" && discarded.resolvedAt !== null);

    const result = await restoreSuggestedReminder(sr.id);
    const back = await db.query.suggestedReminders.findFirst({ where: eq(suggestedReminders.id, sr.id) });
    check("restore returns it to pending", result.restored && back?.status === "pending");
    check("…and clears resolvedAt", back?.resolvedAt === null);
  }

  /* ------------------------------------------------------ delete goal → restore */

  {
    const createdAt = new Date("2026-07-15T09:30:00.000Z");
    const [goal] = await db
      .insert(userGoals)
      .values({ userId: USER, text: "Land a PM role at a climate company", createdAt })
      .returning();

    const snap = await deleteGoal(goal.id);
    const gone = await db.query.userGoals.findFirst({ where: eq(userGoals.id, goal.id) });
    check("delete removes the goal", !gone && !!snap);

    const result = await restoreGoal(snap!);
    const back = await db.query.userGoals.findFirst({ where: eq(userGoals.id, goal.id) });
    check("restore brings back the SAME id", result.restored && back?.id === goal.id);
    check("…with the same text", back?.text === goal.text);
    check("…and the same createdAt, so it keeps its place in the list", ms(back?.createdAt) === ms(createdAt));

    const twice = await restoreGoal(snap!);
    check("restoring twice does not duplicate or overwrite", twice.restored === false);
    const count = await db.query.userGoals.findMany({ where: and(eq(userGoals.userId, USER), eq(userGoals.id, goal.id)) });
    check("…exactly one row", count.length === 1);

    const forged = await restoreGoal({ ...snap!, id: randomUUID(), text: "" });
    check("a snapshot with no text is refused", forged.restored === false);
  }

  /* ------------------------------------------------ delete → restore (soft delete) */

  {
    const { reminder } = await seedReminder("Morgan Ellis");
    const snap = await deleteReminderAction(reminder.id);
    check("delete returns a snapshot", snap?.previousStatus === "pending");
    const gone = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("delete is soft: the row is dismissed, not removed", gone?.status === "dismissed");

    const again = await deleteReminderAction(reminder.id);
    check("deleting an already-deleted reminder is a no-op", again === null);

    const result = await restoreReminderAction(snap!);
    check("restore reports it restored", result.restored);
    const back = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("status is back exactly", back?.status === "pending");

    const twice = await restoreReminderAction(snap!);
    check("a second restore finds nothing to undo", twice.restored === false);

    const forged = await restoreReminderAction({ ...snap!, previousStatus: "exploded" });
    check("an unknown status in a delete snapshot is refused", forged.restored === false);
  }

  /* ---------------------------------------- reschedule to a day → unsnooze */

  {
    const { contact, reminder, originalDue } = await seedReminder("Robin Okafor");
    const target = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const snap = await rescheduleReminderAction(reminder.id, target);
    const moved = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("reschedule stores the day at noon UTC (date-only)",
      moved?.dueDate?.toISOString() === `${target}T12:00:00.000Z`, moved?.dueDate?.toISOString());
    const c1 = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("reschedule mirrors the contact's follow-up clock", ms(c1?.nextFollowUpAt) === ms(moved?.dueDate));

    await unsnoozeReminderAction(snap!);
    const back = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("its Undo is the snooze Undo", ms(back?.dueDate) === ms(originalDue));

    let refused = false;
    try {
      await rescheduleReminderAction(reminder.id, "2026-02-30");
    } catch {
      refused = true;
    }
    check("an impossible date is refused, not rolled into March", refused);
  }

  /* ------------------------------------------ bulk: one Undo reverses the lot */

  {
    const a = await seedReminder("Bulk A");
    const b = await seedReminder("Bulk B");
    const c = await seedReminder("Bulk C");
    const ids = [a.reminder.id, b.reminder.id, c.reminder.id];

    const done = await bulkReminderAction(ids, { op: "done" });
    check("bulk done succeeds", done.ok && done.value.count === 3);
    const doneRows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("all three are done", ids.every((id) => doneRows.find((r) => r.id === id)?.status === "done"));
    const undoneDone = await undoBulkReminderAction(done.ok ? done.value.snapshot : ({} as never));
    check("one Undo reopens all three", undoneDone.restored);
    const reopened = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("…every one is pending again", ids.every((id) => reopened.find((r) => r.id === id)?.status === "pending"));

    const del = await bulkReminderAction(ids, { op: "delete" });
    check("bulk delete succeeds", del.ok && del.value.count === 3);
    await undoBulkReminderAction(del.ok ? del.value.snapshot : ({} as never));
    const restoredRows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("one Undo restores every deleted row",
      ids.every((id) => restoredRows.find((r) => r.id === id)?.status === "pending"));

    const target = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const snoozed = await bulkReminderAction(ids, { op: "snooze", ymd: target });
    check("bulk snooze succeeds", snoozed.ok && snoozed.value.count === 3);
    await undoBulkReminderAction(snoozed.ok ? snoozed.value.snapshot : ({} as never));
    const unsnoozed = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("one Undo puts every due date back",
      [a, b, c].every((s) => ms(unsnoozed.find((r) => r.id === s.reminder.id)?.dueDate) === ms(s.originalDue)));

    const list = await createReminderList("Bulk target");
    check("list created", list.ok);
    const listId = list.ok ? list.value.id : "";
    const moved = await bulkReminderAction(ids, { op: "move", listId });
    check("bulk move succeeds", moved.ok && moved.value.count === 3);
    const movedRows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("all three are in the new list", ids.every((id) => movedRows.find((r) => r.id === id)?.listId === listId));
    await undoBulkReminderAction(moved.ok ? moved.value.snapshot : ({} as never));
    const movedBack = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check("one Undo puts every row back in its old list (unfiled stays unfiled)",
      ids.every((id) => movedBack.find((r) => r.id === id)?.listId === null));

    const foreign = await bulkReminderAction([randomUUID()], { op: "done" });
    check("ids that aren't yours touch nothing", foreign.ok && foreign.value.count === 0);
    const empty = await bulkReminderAction([], { op: "done" });
    check("an empty selection is refused with a readable message", !empty.ok);
  }

  /* ------------------------------------------------ forged snapshots are refused */

  {
    const { reminder } = await seedReminder("Casey Tran");
    const snap = await snoozeReminder(USER, reminder.id, 7);
    const forged = await unsnoozeReminderAction({ ...snap!, previousStatus: "exploded" });
    check("an unknown status in a snooze snapshot is refused", forged.restored === false);

    const completion = await completeReminder(USER, reminder.id);
    const forgedReopen = await reopenReminderAction({ ...completion!, previousStatus: "done" });
    check("a completion snapshot claiming it was already done is refused", forgedReopen.restored === false);
  }

  await cleanup();
  console.log("\nAll toast Undo round-trips passed");
}

run(main);
