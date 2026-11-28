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
 * Then importance (what Cosmo speaks of): every seed row is a normal reminder or an outer-circle
 * follow-up, so nothing is important and the Cosmo chip stays quiet. Marking one reminder
 * critical, one high and Ada inner-circle makes three important, and `loadTopDue` names exactly
 * those, critical first, never the unmet contact or the paired reminder.
 *
 * Run: npx tsx scripts/smoke-due-counts.ts
 */
import "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, reminders } from "../src/db/schema";
import { getDueCounts, loadTopDue } from "../src/lib/due-counts";
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
  t.check("all of it normal or outer circle: nothing important", due.important === 0, String(due.important));

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

  const quiet = allNudges(nudgeInput({ nextMeeting: null, unloggedMeeting: null, radarNew: 0, panel }), now.getTime()).find((n) => n.kind === "due");
  t.check("8 small things due: Cosmo's chip says nothing", quiet === undefined, quiet?.chip ?? "none");

  await db.update(reminders).set({ priority: "critical" }).where(and(eq(reminders.userId, USER), eq(reminders.title, "overdue 1")));
  await db.update(reminders).set({ priority: "high" }).where(and(eq(reminders.userId, USER), eq(reminders.title, "today 1")));
  // Priority on the generated twin must not leak in: the follow-up row already stands for it.
  await db.update(reminders).set({ priority: "critical" }).where(and(eq(reminders.userId, USER), eq(reminders.title, "Send Ada the write-up")));
  await db.update(reminders).set({ priority: "critical" }).where(and(eq(reminders.userId, USER), eq(reminders.title, "Send Never the write-up")));
  await db.execute(sql`update contacts set closeness_breakdown = '{"tier":"inner"}'::jsonb where id = ${people[0].id}`);

  const ranked = await getDueCounts(USER, TZ, now);
  t.check("important = critical + high + inner circle = 3; total unchanged", ranked.important === 3 && ranked.total === 8, JSON.stringify(ranked));
  const top = await loadTopDue(USER, TZ, now);
  const labels = top.items.map((i) => i.label);
  t.check(
    "top due: critical first, then the tier-1 items oldest first",
    JSON.stringify(labels) === JSON.stringify(["overdue 1", "Follow up with Ada Due", "today 1"]),
    JSON.stringify(labels)
  );
  t.check("never the unmet contact's or the paired reminder", !labels.some((l) => l.includes("write-up")));
  t.check("loadTopDue carries the same counts", top.important === 3 && top.total === 8, JSON.stringify(top));
  t.check("capped at the limit", (await loadTopDue(USER, TZ, now, 2)).items.length === 2);

  const loud = await loadNotificationPanel(USER, now, { withAlerts: false, tz: TZ });
  const chip = allNudges(nudgeInput({ nextMeeting: null, unloggedMeeting: null, radarNew: 0, panel: loud }), now.getTime()).find((n) => n.kind === "due");
  t.check('chip says "3 important"; the bell still counts 8', chip?.chip === "3 important" && loud.dueCount === 8, `${chip?.chip ?? "none"} / ${loud.dueCount}`);

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  t.done("due-counts smoke tests");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
