/**
 * One definition of "due": the dashboard's Due reminders tile, the Reminders rail's Today, the
 * bell and the Cosmo chip all read `getDueCounts` (src/lib/due-counts.ts), so the numbers agree.
 *
 * Seed: 3 reminders due today, 1 due later today, 2 overdue, 2 upcoming, 1 undated, 2 met
 * contacts with a due follow-up; plus three that must NOT be counted as due reminders: a
 * generated reminder about an unmet contact (not alertable), a generated reminder paired with a
 * due follow-up, and the "Follow up with" twin of the other due follow-up.
 * Due reminders = 6 (today + later today + overdue), follow-ups = 2, total = 8. Each count equals
 * the list it opens: the rail's Today is the Today view's total, and the bell's "Due now" rows
 * are the breakdown's total.
 *
 * Run: npx tsx scripts/smoke-due-counts.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, reminders } from "../src/db/schema";
import { getDueCounts } from "../src/lib/due-counts";
import { getDashboardData } from "../src/lib/reminders";
import { desktopNotificationItems, loadNotificationPanel } from "../src/lib/notification-panel";
import { queryReminderRailCounts, queryRemindersPage } from "../src/lib/reminders-page-query";
import { allNudges, nudgeInput } from "../src/lib/cosmo/nudge";
import { checker } from "./smoke/check";

const USER = "smoke-due-counts-user";
const TZ = "UTC";
const t = checker();

async function main() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  // Noon UTC of the real UTC day, so the seed rows sit on fixed sides of "now" (10:30 before it,
  // 23:30 after it) whatever the wall clock says. Every read below is handed this same `now`.
  const now = new Date();
  now.setUTCHours(12, 0, 0, 0);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 5, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays: number) => {
    const d = new Date(now.getTime() + offsetDays * day);
    d.setUTCHours(10, 30, 0, 0);
    return d;
  };
  const rows: { title: string; dueDate: Date | null }[] = [
    ...[1, 2, 3].map((n) => ({ title: `today ${n}`, dueDate: at(0) })),
    ...[1, 2].map((n) => ({ title: `overdue ${n}`, dueDate: at(-n - 1) })),
    ...[1, 2].map((n) => ({ title: `upcoming ${n}`, dueDate: at(n + 1) })),
    { title: "undated", dueDate: null },
  ];
  await db.insert(reminders).values(rows.map((r) => ({ userId: USER, ...r, status: "pending" as const })));

  const laterToday = new Date(now);
  laterToday.setUTCHours(23, 30, 0, 0);
  await db.insert(reminders).values({ userId: USER, title: "later today", dueDate: laterToday, status: "pending" });

  const people: { id: string; name: string; due: Date }[] = [];
  for (const name of ["Ada Due", "Grace Due"]) {
    const [c] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: name, nextFollowUpAt: dayStart })
      .returning();
    people.push({ id: c.id, name, due: c.nextFollowUpAt! });
    // Met people may alert (met-contact.ts).
    await db.insert(interactions).values({
      userId: USER,
      contactId: c.id,
      interactionType: "meeting",
      interactionDate: new Date(now.getTime() - 30 * day),
    });
  }

  const [unmet] = await db.insert(contacts).values({ userId: USER, fullName: "Never Met" }).returning();
  await db.insert(reminders).values([
    // Generated about someone never met: may not alert, so not due work.
    { userId: USER, title: "Send Never the write-up", dueDate: at(0), status: "pending", contactId: unmet.id, createdBy: "system", reminderType: "generated" },
    // Generated beside a due follow-up: the follow-up row already shows it.
    { userId: USER, title: "Send Ada the write-up", dueDate: at(0), status: "pending", contactId: people[0].id, createdBy: "system", reminderType: "generated" },
    // The day preset's twin of the clock: same instant, the scheduler's wording.
    { userId: USER, title: `Follow up with ${people[1].name}`, dueDate: people[1].due, status: "pending", contactId: people[1].id },
  ]);

  const due = await getDueCounts(USER, TZ, now);
  t.check("getDueCounts: 6 reminders, 2 follow-ups, 8 total", due.reminders === 6 && due.followUps === 2 && due.total === 8, JSON.stringify(due));

  const dash = await getDashboardData(USER, { tz: TZ, now });
  t.check("dashboard Due reminders = 6", dash.stats.dueReminders === 6, String(dash.stats.dueReminders));
  t.check("dashboard Due follow-ups = 2", dash.stats.dueFollowUps === 2, String(dash.stats.dueFollowUps));

  const rail = await queryReminderRailCounts(db, USER, { tz: TZ, inboxId: null, now });
  const todayList = await queryRemindersPage(db, USER, { view: "today", listId: null, tz: TZ, limit: 200 }, { inboxId: null, now });
  t.check("Reminders rail Today = the Today view's total", rail.counts.today === todayList.total, `${rail.counts.today} vs ${todayList.total}`);

  const panel = await loadNotificationPanel(USER, now, { withAlerts: false, tz: TZ });
  t.check("bell breakdown = 6 reminders + 2 follow-ups", panel.dueBreakdown.reminders === 6 && panel.dueBreakdown.followUps === 2, JSON.stringify(panel.dueBreakdown));
  t.check("bell dueCount = 8", panel.dueCount === 8, String(panel.dueCount));
  const dueRows = panel.items.filter((i) => i.urgency === "due").length;
  t.check('the bell\'s "Due now" rows = the breakdown total', dueRows === panel.dueBreakdown.reminders + panel.dueBreakdown.followUps, `${dueRows} rows`);

  // A reminder due at 23:30 counts as due today in the bell, but must not raise an OS notification
  // at noon (and spend its id); one due at 10:30 may.
  const desktop = desktopNotificationItems(panel.items, now, new Set(), 50);
  t.check("a reminder due later today is not in the desktop list", !desktop.some((i) => i.title === "later today"), JSON.stringify(desktop.map((i) => i.title)));
  t.check("a reminder already past its time is", desktop.some((i) => i.title === "today 1"));
  t.check("the later reminder still counts in the bell", panel.items.some((i) => i.title === "later today" && i.urgency === "due"));

  const chip = allNudges(nudgeInput({ nextMeeting: null, unloggedMeeting: null, radarNew: 0, panel }), now.getTime()).find((n) => n.kind === "due");
  t.check('chip says "8 things due"', chip?.chip === "8 things due", chip?.chip ?? "none");

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  t.done("due-counts smoke tests");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
