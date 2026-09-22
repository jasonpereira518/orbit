/**
 * The panel's Home (what's due, who you touched lately) and its search.
 *
 * Home's "due" must be the reminders page's Today view exactly — pending, on or
 * before the viewer's today — or the panel and /reminders disagree about what the
 * user owes. Search must stay free as keyword, rank on Pro, and never lose the
 * user their results when ranking fails.
 *
 * Run: npx tsx scripts/smoke-extension-home.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, reminders } from "../src/db/schema";
import { loadHome } from "../src/lib/extension/home";
import { keywordSearch, searchContactsForExtension } from "../src/lib/extension/search";

const USER = "smoke-ext-home-user";
const OTHER = "smoke-ext-home-other";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(reminders).where(eq(reminders.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

/** UTC midnight of today's UTC date — a date-only due, the way createReminder stores it. */
function todayDateOnly() {
  const d = new Date();
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

run(async () => {
  await cleanup();
  const db = await getDb();

  const [amara] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Amara Osei",
      company: "Stripe",
      profileImageUrl: "https://media.example.com/amara.jpg",
      updatedAt: new Date(Date.now() - 1 * DAY),
    })
    .returning();
  const [ben] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Ben Tate",
      company: "Acme",
      // 120 KB of base64 is exactly what must never cross the wire.
      profileImageUrl: "data:image/png;base64,AAAA",
      updatedAt: new Date(),
    })
    .returning();

  const past = (days: number) => new Date(Date.now() - days * DAY);
  const pending = (title: string, dueDate: Date, extra: Partial<typeof reminders.$inferInsert> = {}) => ({
    userId: USER,
    title,
    dueDate,
    ...extra,
  });

  // 11 overdue (so the cap of 10 bites), one due today, one in the future, one done.
  await db.insert(reminders).values([
    ...Array.from({ length: 11 }, (_, i) =>
      pending(`Overdue ${i + 1}`, past(20 - i), i === 0 ? { contactId: amara.id } : {})
    ),
    pending("Due today", todayDateOnly()),
    pending("Next week", new Date(Date.now() + 5 * DAY)),
    pending("Already done", past(3), { status: "done" }),
  ]);
  await db.insert(reminders).values({ userId: OTHER, title: "Someone else's", dueDate: past(2) });

  console.log("Home: due");
  const home = await loadHome(USER, "UTC");
  check("the list is capped at 10", home.dueReminders.length === 10, String(home.dueReminders.length));
  check(
    "…but the total is exact: 11 overdue + 1 today",
    home.dueReminderTotal === 12,
    String(home.dueReminderTotal)
  );
  check("oldest first", home.dueReminders[0]?.title === "Overdue 1", home.dueReminders[0]?.title);
  check("overdue rows say so", home.dueReminders[0]?.overdue === true);
  check(
    "a reminder carries its contact, for the row",
    home.dueReminders[0]?.contact?.fullName === "Amara Osei"
  );
  check(
    "a reminder without one says so",
    home.dueReminders.slice(1).every((r) => r.contact === null)
  );
  const titles = (await loadHome(USER, "UTC")).dueReminders.map((r) => r.title);
  check("future reminders are not due", !titles.includes("Next week"));
  check("done reminders are not due", !titles.includes("Already done"));
  check("another user's reminders never appear", !titles.includes("Someone else's"));

  // The date-only "today" row sits past the 10-row cap above, so check it alone.
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.insert(reminders).values([pending("Due today", todayDateOnly())]);
  const onlyToday = await loadHome(USER, "UTC");
  check(
    "a date-only reminder for today is due today, not overdue",
    onlyToday.dueReminders.length === 1 && onlyToday.dueReminders[0].overdue === false,
    JSON.stringify(onlyToday.dueReminders)
  );

  const hostile = await loadHome(USER, "UTC'; DROP TABLE reminders; --");
  check("a nonsense timezone falls back to UTC instead of reaching SQL", hostile.today === onlyToday.today);

  console.log("Home: recent");
  check(
    "most recently touched first",
    home.recentContacts[0]?.id === ben.id && home.recentContacts[1]?.id === amara.id,
    JSON.stringify(home.recentContacts.map((c) => c.fullName))
  );
  check(
    "an inline data: photo never crosses the wire",
    home.recentContacts.find((c) => c.id === ben.id)?.photoUrl === null
  );
  check(
    "an https photo does",
    home.recentContacts.find((c) => c.id === amara.id)?.photoUrl === "https://media.example.com/amara.jpg"
  );

  console.log("Search");
  const kw = await keywordSearch(USER, "stripe");
  check("keyword finds by company", kw.length === 1 && kw[0].id === amara.id, JSON.stringify(kw));

  const free = await searchContactsForExtension(USER, "stripe", { ranked: false });
  check("free search is keyword, and says so", free.mode === "keyword" && free.results.length === 1);

  const pro = await searchContactsForExtension(USER, "Amara", { ranked: true });
  check(
    "Pro search runs the app's ranked search, and says so",
    pro.mode === "hybrid" && pro.results[0]?.id === amara.id,
    JSON.stringify(pro)
  );

  const broken = await searchContactsForExtension(USER, "stripe", {
    ranked: true,
    rank: async () => {
      throw new Error("ranker down");
    },
  });
  check(
    "when ranking fails, the user still gets keyword results — labeled keyword",
    broken.mode === "keyword" && broken.results.length === 1,
    JSON.stringify(broken)
  );

  const slow = await searchContactsForExtension(USER, "stripe", {
    ranked: true,
    rankedBudgetMs: 20,
    rank: () => new Promise((resolve) => setTimeout(() => resolve([]), 500)),
  });
  check(
    "when ranking runs past its budget, keyword answers instead",
    slow.mode === "keyword" && slow.results.length === 1,
    JSON.stringify(slow)
  );

  const otherUser = await keywordSearch(OTHER, "stripe");
  check("search never crosses accounts", otherUser.length === 0);

  await cleanup();
  if (failures) {
    console.error(`\nsmoke-extension-home: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-home: all checks passed");
});
