/**
 * Guards the follow-up write paths the dashboard's Due follow-ups row drives.
 *
 * Three defects motivated this file, all of them silent:
 *
 *   1. A day preset overwrote the reminder's TITLE. Pressing "7d" on a reminder
 *      you had written yourself ("Send Priya the deck") renamed it to the
 *      generated "Follow up with Priya" and reset its type to "manual".
 *   2. Clearing a follow-up also marks every pending reminder for the contact
 *      done — and said only "Follow-up cleared", so the count was invisible.
 *   3. The two paths that write `contacts.nextFollowUpAt` (the row's day presets
 *      and the reminder's snooze) clamped their day counts differently.
 *
 * Presets deliberately schedule from TODAY, not from the existing due date: on a
 * row reading "Overdue 31 days", a relative snooze would land three days ago and
 * still be overdue. That is asserted here so it cannot be "fixed" into a bug.
 *
 * Run: npx tsx scripts/smoke-follow-up-actions.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, reminders, userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { snoozeReminder } from "../src/lib/reminders";
import {
  clearContactFollowUp,
  scheduleContactFollowUp,
} from "../src/actions/reminders";

const USER = "demo-user";
const HANDWRITTEN = "Send Priya the deck";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Whole days between two dates, rounded — avoids DST/second-boundary flake. */
function daysFromToday(d: Date | null | undefined) {
  if (!d) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function seedContact(fullName: string, overdueDays: number) {
  const db = await getDb();
  const due = new Date();
  due.setDate(due.getDate() - overdueDays);
  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName,
      nextFollowUpAt: due,
      followUpStatus: "pending",
    })
    .returning();
  return contact;
}

async function main() {
  console.log("Follow-up actions");
  // These actions go through `requireUserId()`. With no Clerk keys AND
  // NODE_ENV=development, that resolves to demo mode's `demo-user` — the identity
  // seeded below. `.claude/preview-demo.sh` sets the same two for the same reason.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";

  await cleanup();
  const db = await getDb();
  await ensureUserSettings(USER);

  /* ---------------------------------- presets schedule from TODAY, not from the due date */

  const overdue = await seedContact("Olivia Brooks", 31);
  await scheduleContactFollowUp(overdue.id, 3);

  const afterPreset = await db.query.contacts.findFirst({
    where: eq(contacts.id, overdue.id),
  });
  check(
    "a 3d preset on a 31-day-overdue contact lands 3 days from today",
    daysFromToday(afterPreset?.nextFollowUpAt) === 3,
    `got ${daysFromToday(afterPreset?.nextFollowUpAt)}`
  );
  check(
    "…and is therefore no longer overdue",
    (afterPreset?.nextFollowUpAt as Date) > new Date()
  );

  /* --------------------------------------------- rescheduling changes WHEN, not WHAT */

  const named = await seedContact("Priya Nair", 5);
  const [handwritten] = await db
    .insert(reminders)
    .values({
      userId: USER,
      contactId: named.id,
      title: HANDWRITTEN,
      dueDate: new Date(),
      reminderType: "note_action",
      status: "pending",
      createdBy: "user",
    })
    .returning();

  await scheduleContactFollowUp(named.id, 7);

  const afterReschedule = await db.query.reminders.findFirst({
    where: eq(reminders.id, handwritten.id),
  });
  check(
    "a preset preserves a hand-written reminder title",
    afterReschedule?.title === HANDWRITTEN,
    `got ${JSON.stringify(afterReschedule?.title)}`
  );
  check(
    "a preset preserves the reminder's own type",
    afterReschedule?.reminderType === "note_action",
    `got ${afterReschedule?.reminderType}`
  );
  check(
    "…while still moving its due date to 7 days out",
    daysFromToday(afterReschedule?.dueDate) === 7,
    `got ${daysFromToday(afterReschedule?.dueDate)}`
  );

  /* ------------------------------------- preset and snooze agree on what "7 days" means */

  const viaSnooze = await seedContact("David Kim", 2);
  const [snoozeTarget] = await db
    .insert(reminders)
    .values({
      userId: USER,
      contactId: viaSnooze.id,
      title: "Follow up with David Kim",
      dueDate: new Date(),
      reminderType: "manual",
      status: "pending",
      createdBy: "user",
    })
    .returning();
  await snoozeReminder(USER, snoozeTarget.id, 7);

  const snoozed = await db.query.contacts.findFirst({
    where: eq(contacts.id, viaSnooze.id),
  });
  check(
    "the snooze clock and the 7d preset produce the same contact due date",
    daysFromToday(snoozed?.nextFollowUpAt) ===
      daysFromToday(afterPreset && (await db.query.contacts.findFirst({
        where: eq(contacts.id, named.id),
      }))?.nextFollowUpAt),
    `snooze=${daysFromToday(snoozed?.nextFollowUpAt)}`
  );

  /* ------------------------------------------ clearing reports what it actually closed */

  const toClear = await seedContact("Ben Carter", 4);
  await db.insert(reminders).values([
    {
      userId: USER,
      contactId: toClear.id,
      title: "One",
      dueDate: new Date(),
      reminderType: "manual",
      status: "pending" as const,
      createdBy: "user" as const,
    },
    {
      userId: USER,
      contactId: toClear.id,
      title: "Two",
      dueDate: new Date(),
      reminderType: "manual",
      status: "pending" as const,
      createdBy: "user" as const,
    },
  ]);

  const cleared = await clearContactFollowUp(toClear.id);
  check(
    "clearing reports the number of reminders it closed",
    cleared.remindersClosed === 2,
    `got ${cleared.remindersClosed}`
  );

  const stillPending = await db.query.reminders.findMany({
    where: and(eq(reminders.contactId, toClear.id), eq(reminders.status, "pending")),
  });
  check("…and actually closed them", stillPending.length === 0);

  const clearedContact = await db.query.contacts.findFirst({
    where: eq(contacts.id, toClear.id),
  });
  check(
    "…and cleared the contact's follow-up clock",
    clearedContact?.nextFollowUpAt === null &&
      clearedContact?.followUpStatus === "none"
  );

  const noReminders = await seedContact("Grace Whitfield", 1);
  const clearedEmpty = await clearContactFollowUp(noReminders.id);
  check(
    "clearing a contact with no reminders reports zero, not undefined",
    clearedEmpty.remindersClosed === 0,
    `got ${clearedEmpty.remindersClosed}`
  );

  await cleanup();
  console.log("Follow-up actions: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
