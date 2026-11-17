/**
 * One definition of "due": the dashboard's Due reminders tile, the Reminders rail's Today, the
 * bell and the Cosmo chip all read `getDueCounts` (src/lib/due-counts.ts), so the numbers agree.
 *
 * Seed: 3 reminders due today, 2 overdue, 2 upcoming, 1 undated, 2 contacts with a due
 * follow-up. Due reminders = 5 (today + overdue), follow-ups = 2, total = 7.
 *
 * Run: npx tsx scripts/smoke-due-counts.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, reminders } from "../src/db/schema";
import { getDueCounts } from "../src/lib/due-counts";
import { getDashboardData } from "../src/lib/reminders";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { queryReminderRailCounts } from "../src/lib/reminders-page-query";
import { allNudges, nudgeInput } from "../src/lib/cosmo/nudge";
import { checker } from "./smoke/check";

const USER = "smoke-due-counts-user";
const TZ = "UTC";
const t = checker();

async function main() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const now = new Date();
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

  for (const name of ["Ada Due", "Grace Due"]) {
    const [c] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: name, nextFollowUpAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .returning();
    // Met people may alert (met-contact.ts).
    await db.insert(interactions).values({
      userId: USER,
      contactId: c.id,
      interactionType: "meeting",
      interactionDate: new Date(now.getTime() - 30 * day),
    });
  }

  const due = await getDueCounts(USER, TZ, now);
  t.check("getDueCounts: 5 reminders, 2 follow-ups, 7 total", due.reminders === 5 && due.followUps === 2 && due.total === 7, JSON.stringify(due));

  const dash = await getDashboardData(USER, { tz: TZ });
  t.check("dashboard Due reminders = 5", dash.stats.dueReminders === 5, String(dash.stats.dueReminders));
  t.check("dashboard Due follow-ups = 2", dash.stats.dueFollowUps === 2, String(dash.stats.dueFollowUps));

  const rail = await queryReminderRailCounts(db, USER, { tz: TZ, inboxId: null, now });
  t.check("Reminders rail Today = 5", rail.counts.today === 5, String(rail.counts.today));

  const panel = await loadNotificationPanel(USER, now, { withAlerts: false, tz: TZ });
  t.check("bell breakdown = 5 reminders + 2 follow-ups", panel.dueBreakdown.reminders === 5 && panel.dueBreakdown.followUps === 2, JSON.stringify(panel.dueBreakdown));
  t.check("bell dueCount = 7", panel.dueCount === 7, String(panel.dueCount));

  const chip = allNudges(nudgeInput({ nextMeeting: null, unloggedMeeting: null, radarNew: 0, panel }), now.getTime()).find((n) => n.kind === "due");
  t.check('chip says "7 things due"', chip?.chip === "7 things due", chip?.chip ?? "none");

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  t.done("due-counts smoke tests");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
