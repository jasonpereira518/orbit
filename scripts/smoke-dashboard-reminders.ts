/**
 * The dashboard's reminder card and stat, now answered in SQL (`dashboardReminderFilter`).
 *
 * The dashboard used to read EVERY pending reminder and filter in JS, and generated
 * follow-up reminders grow with the network. The rule is unchanged: a generated reminder
 * whose contact is already due for a follow-up is left to the follow-up card. The card
 * shows the first twenty by due date; the stat counts all of them.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-dashboard-reminders.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, reminders } from "../src/db/schema";
import { getDashboardData } from "../src/lib/reminders";

const USER = "smoke-dashboard-reminders";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const now = Date.now();
  const [due] = await db.insert(contacts).values({ userId: USER, fullName: "Due Dana", nextFollowUpAt: new Date(now - DAY) }).returning();
  const [later] = await db.insert(contacts).values({ userId: USER, fullName: "Later Lee", nextFollowUpAt: new Date(now + 30 * DAY) }).returning();

  const rows: Array<typeof reminders.$inferInsert> = [
    // Left to the follow-up card: generated, and its contact is due.
    { userId: USER, contactId: due!.id, title: "hidden: generated for a due contact", reminderType: "generated", dueDate: new Date(now - 10 * DAY) },
    // Shown: generated, contact not due; manual for the due contact; no contact at all.
    { userId: USER, contactId: later!.id, title: "shown: generated, not due", reminderType: "generated", dueDate: new Date(now - 9 * DAY) },
    { userId: USER, contactId: due!.id, title: "shown: manual for a due contact", reminderType: "manual", dueDate: new Date(now - 8 * DAY) },
    // Not pending at all.
    { userId: USER, contactId: later!.id, title: "hidden: done", status: "done", dueDate: new Date(now - 7 * DAY) },
    // Twenty-five more, so the card has to cap and the count has to see past the cap.
    ...Array.from({ length: 25 }, (_, i) => ({ userId: USER, title: `filler ${String(i).padStart(2, "0")}`, dueDate: new Date(now + i * DAY) })),
  ];
  await db.insert(reminders).values(rows);

  const data = await getDashboardData(USER);
  const titles = data.reminders.map((r) => r.title);
  check("the card shows twenty", titles.length === 20, String(titles.length));
  check("in due-date order, earliest first", titles[0] === "shown: generated, not due" && titles[1] === "shown: manual for a due contact", titles.slice(0, 3).join(" | "));
  check("never a generated reminder for someone already due", !titles.some((t) => t.startsWith("hidden")));
  check("the stat counts every pending one the card could show (27), not the card's twenty", data.stats.pendingReminders === 27, String(data.stats.pendingReminders));

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll dashboard reminder checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
