/**
 * Calendar reminders (`src/lib/calendar-reminders.ts`): prep before a meeting worth preparing
 * for, a follow-up after a one-off meeting, and cleanup when a meeting moves or is cancelled.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-calendar-reminders.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarSources, contacts, interactions, meetingSessions, reminders } from "../src/db/schema";
import { refreshCalendarWindow } from "../src/lib/calendar-events";
import { prepDue } from "../src/lib/calendar-reminders";

const USER = "smoke-calendar-reminders-user";
const OWNER = "me@example.com";
const H = 3_600_000;
const DAY = 24 * H;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOW = new Date();
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function event(id: string, startMs: number, guests: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    iCalUID: `${id}@ical`,
    summary: id,
    start: { dateTime: at(startMs) },
    end: { dateTime: at(startMs + H / 2) },
    attendees: [{ email: OWNER, self: true }, ...guests.map((email) => ({ email, displayName: email.split("@")[0] }))],
    ...extra,
  };
}

async function main() {
  const db = await getDb();
  await db.delete(calendarSources).where(eq(calendarSources.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(meetingSessions).where(eq(meetingSessions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const person = async (name: string) =>
    (await db.insert(contacts).values({ userId: USER, fullName: name, email: `${name}@x.example` }).returning())[0];
  const ada = await person("ada"); // never met
  const bo = await person("bo"); // last spoke 200 days ago
  const cy = await person("cy"); // recent, but owed a to-do
  const di = await person("di"); // recent, nothing open

  await db.insert(interactions).values([
    { userId: USER, contactId: bo.id, interactionType: "meeting", interactionDate: new Date(NOW.getTime() - 200 * DAY) },
    { userId: USER, contactId: cy.id, interactionType: "meeting", interactionDate: new Date(NOW.getTime() - 5 * DAY) },
    { userId: USER, contactId: di.id, interactionType: "meeting", interactionDate: new Date(NOW.getTime() - 5 * DAY) },
    // Calendar sync logs an UPCOMING meeting as an interaction; it must not count as having met.
    { userId: USER, contactId: ada.id, interactionType: "meeting", interactionDate: new Date(NOW.getTime() + 30 * H) },
  ]);
  await db.insert(reminders).values({ userId: USER, contactId: cy.id, title: "Send Cy the deck", status: "pending" });
  // The ICS path already followed up on p-ics. No contact: its dedupe is by description, and an
  // open reminder for Di would (rightly) make Di's next meeting worth a prep reminder.
  await db.insert(reminders).values({
    userId: USER,
    title: "Follow up after p-ics",
    description: "You met with them. Event p-ics@ical",
    reminderType: "post_meeting",
    status: "pending",
  });

  const [source] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();
  await db.insert(meetingSessions).values({ userId: USER, title: "p-recorded", calendarEventKey: "p-recorded" });

  const crowd = Array.from({ length: 30 }, (_, i) => `guest${i}@x.example`);
  const items = [
    event("e-first", 30 * H, ["ada@x.example"]),
    event("e-quiet", 10 * H, ["di@x.example"]),
    event("e-gap", 5 * H, ["bo@x.example"]),
    event("e-open", 20 * H, ["cy@x.example"]),
    event("e-far", 5 * DAY, ["ada@x.example"]),
    event("e-webinar", 8 * H, ["ada@x.example", ...crowd]),
    event("p-oneoff", -2 * H, ["di@x.example"]),
    event("p-series", -3 * H, ["di@x.example"], { recurringEventId: "series" }),
    event("p-recorded", -4 * H, ["di@x.example"]),
    event("p-declined", -5 * H, ["di@x.example"], {
      attendees: [{ email: OWNER, self: true, responseStatus: "declined" }, { email: "di@x.example" }],
    }),
    event("p-ics", -6 * H, ["di@x.example"]),
    event("p-stranger", -2 * H, ["nobody@else.example"]),
  ];

  await refreshCalendarWindow(USER, source.id, { items, complete: true }, NOW);
  const all = async () =>
    db.select().from(reminders).where(and(eq(reminders.userId, USER), eq(reminders.createdBy, "calendar_sync")));
  let rows = await all();
  const byKey = (k: string) => rows.filter((r) => r.calendarEventKey === k);

  const first = byKey("e-first")[0];
  check("a first meeting gets a prep reminder", first?.reminderType === "pre_meeting" && first.contactId === ada.id, JSON.stringify(first));
  check("…saying why, despite a future interaction logged for it", first?.description === "First meeting with ada", String(first?.description));
  check("…due the day before", first?.dueDate?.getTime() === NOW.getTime() + 6 * H, String(first?.dueDate));
  check(
    "a 200-day gap gets one, due now (under a day away)",
    byKey("e-gap")[0]?.description === "Last spoke with bo 7 months ago" && byKey("e-gap")[0]?.dueDate?.getTime() === NOW.getTime(),
    JSON.stringify(byKey("e-gap")[0])
  );
  check("an open to-do gets one", byKey("e-open")[0]?.description === "1 open to-do with cy", String(byKey("e-open")[0]?.description));
  check("a recent contact with nothing open gets none", byKey("e-quiet").length === 0);
  check("beyond three days: none yet", byKey("e-far").length === 0);
  check("a webinar-sized meeting gets none", byKey("e-webinar").length === 0);

  const post = byKey("p-oneoff")[0];
  check(
    "a one-off past meeting gets a follow-up",
    post?.reminderType === "post_meeting" && post.contactId === di.id && post.title === "Follow up after p-oneoff",
    JSON.stringify(post)
  );
  check("a recurring meeting does not", byKey("p-series").length === 0);
  check("a recorded meeting does not", byKey("p-recorded").length === 0);
  check("a declined meeting does not", byKey("p-declined").length === 0);
  check("one the ICS path already followed up does not", byKey("p-ics").length === 0);
  check("a meeting with no known contact does not", byKey("p-stranger").length === 0);

  const count = rows.length;
  await refreshCalendarWindow(USER, source.id, { items, complete: true }, NOW);
  rows = await all();
  check("a second pass creates nothing new", rows.length === count, `${count} -> ${rows.length}`);

  // e-first moves out a day; e-gap is cancelled; then a partial read drops e-open.
  const moved = items
    .map((e) => (e.id === "e-first" ? event("e-first", 54 * H, ["ada@x.example"]) : e))
    .filter((e) => e.id !== "e-gap");
  await refreshCalendarWindow(USER, source.id, { items: moved, complete: true }, NOW);
  rows = await all();
  check(
    "a moved meeting's prep reminder follows it",
    byKey("e-first")[0]?.dueDate?.getTime() === NOW.getTime() + 30 * H,
    String(byKey("e-first")[0]?.dueDate)
  );
  check("a cancelled meeting's prep reminder is dismissed", byKey("e-gap")[0]?.status === "dismissed");

  await refreshCalendarWindow(USER, source.id, { items: moved.filter((e) => e.id !== "e-open"), complete: false }, NOW);
  rows = await all();
  check("a partial read dismisses nothing", byKey("e-open")[0]?.status === "pending");

  check("prepDue clamps to now", prepDue(new Date(NOW.getTime() + H), NOW).getTime() === NOW.getTime());

  if (failures) {
    console.error(`\nsmoke-calendar-reminders: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-calendar-reminders: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
