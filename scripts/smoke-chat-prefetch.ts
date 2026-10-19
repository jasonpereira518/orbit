/**
 * The always-on chat sections in `src/lib/chat-prefetch.ts` — reminders across views, open
 * commitments and events — and the calendar's recent past (`loadChatCalendar`'s
 * `recentPast`). What each section says, that each stays under its cap, and that another
 * user's rows never reach it.
 *
 * Runs against a throwaway PGlite database, no AI key. Run: npx tsx scripts/smoke-chat-prefetch.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  calendarEvents,
  calendarSources,
  contacts,
  events,
  interactions,
  reminders,
} from "../src/db/schema";
import {
  capLines,
  loadChatPrefetch,
  PREFETCH_CAPS,
  renderCommitments,
  renderEvents,
} from "../src/lib/chat-prefetch";
import { loadChatCalendar } from "../src/lib/chat-calendar";
import { isSurfaceLive } from "../src/lib/surface-visibility";

const USER = "smoke-chat-prefetch-user";
const OTHER = "smoke-chat-prefetch-other";
const TZ = "UTC";
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
  // --- pure renderers ---------------------------------------------------------------------
  console.log("Capping");
  {
    const lines = Array.from({ length: 50 }, (_, i) => `- line ${i} ${"x".repeat(40)}`);
    const capped = capLines("Head:", lines, 500);
    check("a capped section fits its cap", capped.length <= 500, String(capped.length));
    check("…and says how many lines it left out", /\(\d+ more not shown\)$/.test(capped), capped.slice(-40));
    check("a section under its cap is untouched", capLines("Head:", ["- a"], 500) === "Head:\n- a");
  }

  console.log("\nCommitments say who owes whom");
  {
    const text = renderCommitments(
      [
        { id: "a1", text: "Send the deck", contactId: "c1", contactName: "Maya Chen", owedBy: "me" },
        { id: "a2", text: "Intro to their CTO", contactId: "c2", contactName: "Omar Ali", owedBy: "them" },
        { id: "a3", text: "Coffee in Nov", contactId: "c3", contactName: "Sam Lee", owedBy: null },
      ],
      3
    )!;
    check("the user's own promise", text.includes("Send the deck · the user owes Maya Chen [id=c1]"), text);
    check("a promise made to the user", text.includes("Intro to their CTO · Omar Ali owes the user [id=c2]"), text);
    check("an unattributed item", text.includes("Coffee in Nov · with Sam Lee [id=c3]"), text);
    check("nothing open is no section", renderCommitments([], 0) === null);
  }

  console.log("\nEvents carry ids and how much of each roster the user knows");
  {
    const row = (id: string, title: string, startsAt: Date | null, attendeeCount = 0, connectedCount = 0) => ({
      id, title, startsAt, endsAt: null, venue: "Moscone", city: "San Francisco", url: null, role: "hosted" as const,
      source: "manual" as const, coverImageUrl: null, themeColor: null, discoveredVia: null, rsvpStatus: null,
      attendeeCount, connectedCount,
    });
    const text = renderEvents(
      [row("e1", "AWS Summit", new Date("2026-11-02T16:00:00Z"), 120, 8)],
      [row("e2", "Founders mixer", new Date("2026-10-10T01:00:00Z"))]
    )!;
    check(
      "an upcoming event with its roster",
      text.includes("[event_id=e1] AWS Summit · 2026-11-02 · Moscone, San Francisco · the user hosts it · 120 on the roster, 8 of them in your contacts"),
      text
    );
    check("past events under their own heading", text.indexOf("Recently:") < text.indexOf("Founders mixer"), text);
    check("no events is no section", renderEvents([], []) === null);
  }

  // --- the loaders ------------------------------------------------------------------------
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(reminders).where(eq(reminders.userId, u));
    await db.delete(actionItems).where(eq(actionItems.userId, u));
    await db.delete(events).where(eq(events.userId, u));
    await db.delete(calendarSources).where(eq(calendarSources.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  const now = new Date();
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  const [maya] = await db.insert(contacts).values({ userId: USER, fullName: "Maya Chen" }).returning();
  const [theirs] = await db.insert(contacts).values({ userId: OTHER, fullName: "Their Contact" }).returning();

  const rem = (over: Partial<typeof reminders.$inferInsert>) => ({
    userId: USER, title: "r", status: "pending", reminderType: "manual", ...over,
  });
  await db.insert(reminders).values([
    rem({ title: "Overdue: send Maya the deck", contactId: maya.id, dueDate: at(-3) }),
    rem({ title: "Next week: AWS prep", dueDate: at(6) }),
    rem({ title: "Someday: write the blog post", dueDate: null }),
    rem({ title: "Already done", status: "completed", dueDate: at(-1) }),
    ...Array.from({ length: 30 }, (_, i) => rem({ title: `Filler upcoming ${i}`, dueDate: at(10 + i) })),
    { userId: OTHER, title: "Their private reminder", status: "pending", reminderType: "manual", dueDate: at(-1) },
  ]);

  const [note] = await db
    .insert(interactions)
    .values({ userId: USER, contactId: maya.id, interactionType: "note", rawNotes: "coffee", interactionDate: at(-2) })
    .returning();
  const [theirNote] = await db
    .insert(interactions)
    .values({ userId: OTHER, contactId: theirs.id, interactionType: "note", rawNotes: "x", interactionDate: at(-2) })
    .returning();
  await db.insert(actionItems).values([
    { userId: USER, contactId: maya.id, interactionId: note.id, text: "Send Maya the Series A memo", itemHash: "h1", owedBy: "me" },
    { userId: USER, contactId: maya.id, interactionId: note.id, text: "Closed item", itemHash: "h2", status: "done" },
    { userId: OTHER, contactId: theirs.id, interactionId: theirNote.id, text: "Their private promise", itemHash: "h3" },
  ]);

  await db.insert(events).values([
    { userId: USER, title: "AWS Summit", startsAt: at(5), endsAt: at(5) },
    { userId: USER, title: "Founders mixer", startsAt: at(-9), endsAt: at(-9) },
    { userId: OTHER, title: "Their private event", startsAt: at(5), endsAt: at(5) },
  ]);

  console.log("\nThe prefetch, from the database");
  const prefetch = await loadChatPrefetch(USER, { tz: TZ, now });
  const r = prefetch.reminders ?? "";
  check("the reminders section counts every view", /Overdue or due today: 1 · coming up: 31 · no date: 1/.test(r), r.split("\n")[0]);
  check("…lists the overdue one first, marked overdue", r.split("\n")[1]?.includes("Overdue: send Maya the deck") && r.includes("(overdue)"), r);
  check("…lists what is coming up", r.includes("Next week: AWS prep"), r);
  check("…carries the contact's name", r.includes("· Maya Chen"));
  check("…never a completed reminder", !r.includes("Already done"));
  check("…never another user's reminder", !r.includes("Their private reminder"));
  check("…stays under its cap", r.length <= PREFETCH_CAPS.reminders, String(r.length));
  check(
    "every listed reminder is in the proposal allowlist, at most twelve",
    prefetch.reminderRows.length > 0 &&
      prefetch.reminderRows.length <= 12 &&
      prefetch.reminderRows.every((row) => r.includes(`[reminder_id=${row.id}]`))
  );

  const c = prefetch.commitments ?? "";
  check("open commitments are listed", c.includes("Send Maya the Series A memo · the user owes Maya Chen"), c);
  check("…not a done one, not another user's", !c.includes("Closed item") && !c.includes("Their private promise"), c);
  check("…with the open total", c.startsWith("1 open"), c);

  if (await isSurfaceLive(USER, "page.events")) {
    const e = prefetch.events ?? "";
    check("events: the next one and a recent one", e.includes("AWS Summit") && e.includes("Founders mixer"), e);
    check("…never another user's", !e.includes("Their private event"));
  } else {
    check("events stay out while the events page is not live for the account", prefetch.events === null, String(prefetch.events));
  }

  const empty = await loadChatPrefetch("smoke-chat-prefetch-nobody", { tz: TZ, now });
  check(
    "a user with nothing gets no sections at all",
    empty.reminders === null && empty.commitments === null && empty.events === null && empty.reminderRows.length === 0,
    JSON.stringify(empty)
  );

  console.log("\nThe calendar's recent past");
  {
    const [src] = await db
      .insert(calendarSources)
      .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
      .returning();
    const ev = (id: string, title: string, startAt: Date) => ({
      userId: USER,
      sourceId: src.id,
      providerEventId: id,
      title,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60_000),
      attendees: [{ name: "Maya Chen", email: "maya@x.example", contactId: maya.id }],
      attendeeCount: 1,
    });
    await db.insert(calendarEvents).values([
      ev("p1", "Yesterday's coffee with Maya", at(-1)),
      ev("f1", "Tomorrow's pilot sync", at(1)),
    ]);
    const withPast = await loadChatCalendar(USER, null, false, now, TZ, { recentPast: true });
    check("what already happened is shown", withPast.text.includes("Already happened:") && withPast.text.includes("Yesterday's coffee with Maya"), withPast.text);
    check("…before what is coming up", withPast.text.indexOf("Yesterday's coffee") < withPast.text.indexOf("Tomorrow's pilot sync"), withPast.text);
    check("…and its people reach the allowlist", withPast.people.some((p) => p.id === maya.id));
    const without = await loadChatCalendar(USER, null, false, now, TZ);
    check("without recentPast the block is forward-only, as before", !without.text.includes("Yesterday's coffee"), without.text);
    const nextWeek = await loadChatCalendar(
      USER,
      { calendarWindow: { after: at(3).toISOString().slice(0, 10), before: at(5).toISOString().slice(0, 10) } },
      false,
      now,
      TZ,
      { recentPast: true }
    );
    check("a question about later never gets the past", !nextWeek.text.includes("Already happened"), nextWeek.text);
  }

  for (const u of [USER, OTHER]) {
    await db.delete(reminders).where(eq(reminders.userId, u));
    await db.delete(actionItems).where(eq(actionItems.userId, u));
    await db.delete(events).where(eq(events.userId, u));
    await db.delete(calendarSources).where(eq(calendarSources.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }

  if (failures) {
    console.error(`\n${failures} chat-prefetch check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-prefetch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
