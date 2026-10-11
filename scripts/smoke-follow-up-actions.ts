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
import { aiSuggestions, contacts, recommendations, reminders, userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { getDashboardData, loadDashboardReminders, reopenReminder, snoozeReminder } from "../src/lib/reminders";
import { loadDueFollowUps } from "../src/lib/due-follow-ups";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import {
  clearContactFollowUp,
  markKeepInTouchDone,
  markReminderDone,
  scheduleContactFollowUp,
  scheduleContactFollowUpAt,
  scheduleFromSuggestion,
  undoClearContactFollowUpAction,
  undoKeepInTouchDoneAction,
} from "../src/actions/reminders";
import { markContactReachedOutForUser } from "../src/lib/radar/actions-core";

const USER = "demo-user";
const OTHER = "smoke-follow-up-actions-other";
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
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, OTHER));
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

  /* --------------- a booked follow-up is ONE item once due, not a reminder AND a row */

  const booked = await seedContact("Hannah Lowe", 0);
  await scheduleContactFollowUp(booked.id, 2);
  // Let it come due: move both halves of the pair back by the same instant, as time would.
  const past = new Date(Date.now() - 3_600_000);
  await db.update(reminders).set({ dueDate: past })
    .where(and(eq(reminders.contactId, booked.id), eq(reminders.status, "pending")));
  await db.update(contacts).set({ nextFollowUpAt: past }).where(eq(contacts.id, booked.id));

  const panel = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  const bookedDue = panel.items.filter((i) => i.contactId === booked.id && i.urgency === "due");
  check("a booked follow-up shows once in the bell once due", bookedDue.length === 1,
    JSON.stringify(bookedDue.map((i) => i.kind)));
  const dash = await loadDashboardReminders(USER, new Date());
  check("…and not again on the dashboard's Reminders card",
    !dash.rows.some((r) => r.contactId === booked.id));

  await db.insert(reminders).values({
    userId: USER, contactId: booked.id, title: HANDWRITTEN, dueDate: past,
    reminderType: "manual", status: "pending", createdBy: "user",
  });
  const panel2 = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  check("a hand-written reminder at the same instant is still listed",
    panel2.items.some((i) => i.contactId === booked.id && i.title === HANDWRITTEN));
  const dash2 = await loadDashboardReminders(USER, new Date());
  check("…on the dashboard too", dash2.rows.some((r) => r.title === HANDWRITTEN && r.contactId === booked.id));

  /* ------- a lapsed keep-in-touch cadence is on the due list too, so its generated reminder yields */

  const [cadenceDue] = await db.insert(contacts).values({
    userId: USER, fullName: "Cadence Lapsed", cadenceDays: 14,
    lastInteractionAt: new Date(Date.now() - 20 * 86_400_000),
  }).returning();
  await db.insert(reminders).values({
    userId: USER, contactId: cadenceDue.id, title: "Follow up with Cadence Lapsed", dueDate: past,
    reminderType: "generated", status: "pending", createdBy: "system",
  });
  const dash3 = await loadDashboardReminders(USER, new Date());
  check("a generated reminder on a cadence-due contact is dropped from the Reminders card",
    !dash3.rows.some((r) => r.contactId === cadenceDue.id));

  /* --------------- the date picker moves a hand-written reminder without renaming it */

  const pickerContact = await seedContact("Rowan Ellis", 0);
  const [pickerHandwritten] = await db.insert(reminders).values({
    userId: USER, contactId: pickerContact.id, title: HANDWRITTEN, dueDate: new Date(),
    reminderType: "note_action", status: "pending", createdBy: "user",
  }).returning();
  const inTen = new Date(); inTen.setDate(inTen.getDate() + 10);
  const ymd = `${inTen.getFullYear()}-${String(inTen.getMonth() + 1).padStart(2, "0")}-${String(inTen.getDate()).padStart(2, "0")}`;
  await scheduleContactFollowUpAt(pickerContact.id, ymd);
  const afterPicker = await db.query.reminders.findFirst({ where: eq(reminders.id, pickerHandwritten.id) });
  check("the date picker preserves a hand-written reminder title",
    afterPicker?.title === HANDWRITTEN, `got ${JSON.stringify(afterPicker?.title)}`);
  check("…and its type", afterPicker?.reminderType === "note_action", `got ${afterPicker?.reminderType}`);
  check("…while moving it to the picked day", daysFromToday(afterPicker?.dueDate) === 10,
    `got ${daysFromToday(afterPicker?.dueDate)}`);

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

  // LinkedIn has no send API: "Mark sent on LinkedIn" (`completeFollowUpWithTouch`) is how
  // that message is recorded, and it must close the Radar card and the congratulations nudge
  // just as a sent email does. The action itself logs through `logInteraction`, whose
  // revalidatePath needs a request, so the shared step it ends with is what runs here.
  const onLinkedIn = await seedContact("Priya LinkedIn", 1);
  const [card] = await db
    .insert(recommendations)
    .values({ userId: USER, contactId: onLinkedIn.id, kind: "heads_up", score: 40, bucket: "today", expiresAt: new Date(Date.now() + 86_400_000), inputsHash: "h" })
    .returning();
  const [nudge] = await db
    .insert(aiSuggestions)
    .values({ userId: USER, suggestionType: "job_change_congrats", title: "Priya joined Stripe", relatedContactIds: [onLinkedIn.id], status: "pending" })
    .returning();
  await markContactReachedOutForUser(USER, onLinkedIn.id, new Date());
  const answered = await db.query.recommendations.findFirst({ where: eq(recommendations.id, card!.id) });
  check("marking a LinkedIn message sent closes their Radar card", answered?.status === "accepted" && answered.actedAt !== null, answered?.status);
  const retired = await db.query.aiSuggestions.findFirst({ where: eq(aiSuggestions.id, nudge!.id) });
  check("…and retires the congratulations nudge", retired?.status === "dismissed", retired?.status);

  // Absolute instants from the shared presets.
  {
    const target = new Date(Date.now() + 3 * 86_400_000);
    target.setUTCHours(13, 0, 0, 0);
    const res = await scheduleContactFollowUp(booked.id, target.toISOString());
    check("an ISO instant books exactly that instant", res.dueDate === target.toISOString());
    let refused = "";
    try { await scheduleContactFollowUp(booked.id, new Date(Date.now() - 60_000).toISOString()); }
    catch (err) { refused = (err as Error).message; }
    check("a past instant is refused with friendly copy", refused === "Pick a time in the future", refused);
    const legacy = await scheduleContactFollowUp(booked.id, 2);
    check("a day count still works", Math.round((new Date(legacy.dueDate).getTime() - Date.now()) / 86_400_000) === 2);
  }

  /* ----- Done and Clear move a lapsed cadence on, so the contact does not come straight back */
  {
    const DAY = 86_400_000;
    const now = Date.now();
    // Reading the due list repairs unscored contacts' tiers, so every new contact is followed by
    // a recalibration and the tiers this block depends on are pinned again afterwards.
    const pinned = new Map<string, "inner" | "outer">();
    const pin = async (id: string, tier: "inner" | "outer") => {
      pinned.set(id, tier);
      await recalibrateCloseness(USER);
      for (const [cid, t] of pinned) {
        await db.update(contacts).set({ closenessTier: t, closenessEvidence: 0.5 }).where(eq(contacts.id, cid));
      }
    };
    // An evidenced Inner contact (default cadence 30d) last touched 40 days ago, with a booked
    // follow-up that is due: the reminder and the clock at the same instant, as booking writes them.
    const seedInnerDue = async (fullName: string) => {
      const dueAt = new Date(now - 3_600_000);
      const [c] = await db.insert(contacts).values({
        userId: USER, fullName, closenessTier: "inner", closenessEvidence: 0.5,
        lastInteractionAt: new Date(now - 40 * DAY), nextFollowUpAt: dueAt, followUpStatus: "pending",
      }).returning();
      const [r] = await db.insert(reminders).values({
        userId: USER, contactId: c.id, title: `Follow up with ${fullName}`, dueDate: dueAt,
        reminderType: "manual", status: "pending", createdBy: "user",
      }).returning();
      await pin(c.id, "inner");
      return { c, r };
    };
    const dueEverywhere = async (id: string) => {
      const loader = await loadDueFollowUps(USER);
      const dashboard = await getDashboardData(USER);
      const page = await listContactsPage(USER, { followUp: "due" });
      return {
        loader: loader.some((x) => x.id === id),
        dashboard: dashboard.dueFollowUps.some((x) => x.id === id),
        page: page.items.some((x) => x.id === id),
      };
    };

    // (a) Done on its follow-up reminder: the last touch moves, so the lapsed default cadence restarts.
    const done = await seedInnerDue("Inner Done");
    const before = await dueEverywhere(done.c.id);
    check("an evidenced Inner contact with a due booked follow-up starts out due",
      before.loader && before.dashboard && before.page, JSON.stringify(before));
    const snap = await markReminderDone(done.r.id);
    const afterDone = await dueEverywhere(done.c.id);
    check("Done on its follow-up reminder: not in loadDueFollowUps, the dashboard or followUp=due",
      !afterDone.loader && !afterDone.dashboard && !afterDone.page, JSON.stringify(afterDone));
    const touched = await db.query.contacts.findFirst({ where: eq(contacts.id, done.c.id) });
    check("…because Done moved last_interaction_at to now",
      Math.abs((touched?.lastInteractionAt?.getTime() ?? 0) - Date.now()) < 60_000);
    // Undo puts the last touch back along with the clock.
    await reopenReminder(USER, snap!);
    const reopened = await db.query.contacts.findFirst({ where: eq(contacts.id, done.c.id) });
    check("Undo restores the previous last_interaction_at",
      reopened?.lastInteractionAt?.getTime() === done.c.lastInteractionAt?.getTime(),
      reopened?.lastInteractionAt?.toISOString());

    // (b) Clear on a second such contact books the next one a cadence out instead of nulling it.
    const clr = await seedInnerDue("Inner Clear");
    const clearedRes = await clearContactFollowUp(clr.c.id);
    const afterClear = await dueEverywhere(clr.c.id);
    check("Clear on a lapsed-cadence contact: not due now",
      !afterClear.loader && !afterClear.dashboard && !afterClear.page, JSON.stringify(afterClear));
    const rebooked = await db.query.contacts.findFirst({ where: eq(contacts.id, clr.c.id) });
    const outDays = ((rebooked?.nextFollowUpAt?.getTime() ?? 0) - Date.now()) / DAY;
    check("…and next_follow_up_at is about now + 30 days", Math.abs(outDays - 30) < 0.01, String(outDays));
    const undone = await undoClearContactFollowUpAction(clearedRes.snapshot);
    const restoredClr = await db.query.contacts.findFirst({ where: eq(contacts.id, clr.c.id) });
    check("Undo of that Clear puts the original due date back",
      undone.restored && restoredClr?.nextFollowUpAt?.getTime() === clr.c.nextFollowUpAt?.getTime(),
      restoredClr?.nextFollowUpAt?.toISOString());

    // No effective cadence (outer tier): Clear leaves the clock null, as before.
    const [plain] = await db.insert(contacts).values({
      userId: USER, fullName: "Outer Plain", closenessTier: "outer", closenessEvidence: 0.5,
      lastInteractionAt: new Date(now - 400 * DAY), nextFollowUpAt: new Date(now - 3_600_000), followUpStatus: "pending",
    }).returning();
    await pin(plain.id, "outer");
    await clearContactFollowUp(plain.id);
    const plainAfter = await db.query.contacts.findFirst({ where: eq(contacts.id, plain.id) });
    check("Clear with no effective cadence leaves next_follow_up_at null", plainAfter?.nextFollowUpAt === null);

    /* ----- Done on a cadence-due row (nothing booked) */
    const [cadenceOnly] = await db.insert(contacts).values({
      userId: USER, fullName: "Inner Cadence Only", closenessTier: "inner", closenessEvidence: 0.5,
      lastInteractionAt: new Date(now - 40 * DAY),
    }).returning();
    await pin(cadenceOnly.id, "inner");
    check("a cadence-due contact is in loadDueFollowUps", (await loadDueFollowUps(USER)).some((x) => x.id === cadenceOnly.id));
    const kit = await markKeepInTouchDone(cadenceOnly.id);
    check("markKeepInTouchDone removes it from loadDueFollowUps",
      !(await loadDueFollowUps(USER)).some((x) => x.id === cadenceOnly.id));
    const kitUndo = await undoKeepInTouchDoneAction(kit);
    const kitBack = await db.query.contacts.findFirst({ where: eq(contacts.id, cadenceOnly.id) });
    check("…and its Undo restores the previous last touch",
      kitUndo.restored && kitBack?.lastInteractionAt?.getTime() === cadenceOnly.lastInteractionAt?.getTime());

    const [foreign] = await db.insert(contacts).values({
      userId: OTHER, fullName: "Someone Else", lastInteractionAt: new Date(now - 40 * DAY),
    }).returning();
    let refused = "";
    try { await markKeepInTouchDone(foreign.id); } catch (err) { refused = (err as Error).message; }
    const foreignAfter = await db.query.contacts.findFirst({ where: eq(contacts.id, foreign.id) });
    check("markKeepInTouchDone on another user's contact is not found and writes nothing",
      refused !== "" && foreignAfter?.lastInteractionAt?.getTime() === foreign.lastInteractionAt?.getTime(), refused);
  }

  /* ----- a suggestion's Schedule takes the shared presets' absolute instant */
  {
    const fromSuggestion = await seedContact("Sam Suggested", 0);
    const [sug] = await db.insert(aiSuggestions).values({
      userId: USER, suggestionType: "keep_in_touch", title: "Keep in touch with Sam",
      relatedContactIds: [fromSuggestion.id], status: "pending",
    }).returning();
    const target = new Date(Date.now() + 2 * 86_400_000);
    target.setUTCHours(14, 0, 0, 0);
    const res = await scheduleFromSuggestion(sug.id, target.toISOString());
    check("scheduleFromSuggestion books the ISO instant it is given", res.dueDate === target.toISOString(), res.dueDate);
  }

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
