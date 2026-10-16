/**
 * Chat's calendar block (src/lib/chat-calendar.ts) and free time (src/lib/calendar-free.ts):
 * the window and the person, tenant isolation, attendees for the allowlist, local times, the
 * fenced prompt block — and the free gaps around meetings.
 *
 * Runs against a throwaway PGlite database, no AI key. Run: npx tsx scripts/smoke-chat-calendar.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarEvents, calendarSources, contacts } from "../src/db/schema";
import { loadChatCalendar } from "../src/lib/chat-calendar";
import { freeSlots } from "../src/lib/calendar-free";
import { buildChatPrompt } from "../src/lib/ai";
import { fromWallClockInput } from "../src/lib/events/wall-clock";
import { prepareChatContext } from "../src/lib/chat-context";

const USER = "smoke-chat-calendar-user";
const OTHER = "smoke-chat-calendar-other";
const TZ = "America/New_York";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const at = (day: string, hhmm: string) => fromWallClockInput(`${day}T${hhmm}`, TZ)!;

async function main() {
  // --- free time (pure) --------------------------------------------------------------------
  const day = "2026-10-20";
  const ev = (from: string, to: string, extra: Partial<{ allDay: boolean; selfResponse: string | null }> = {}) => ({
    startAt: at(day, from),
    endAt: at(day, to),
    allDay: false,
    selfResponse: null as string | null,
    ...extra,
  });
  const fmt = (slots: ReturnType<typeof freeSlots>) =>
    slots
      .map((s) =>
        [s.start, s.end]
          .map((d) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d))
          .join("–")
      )
      .join(", ");
  check("an empty day is free 9–18", fmt(freeSlots([], day, TZ)) === "09:00–18:00", fmt(freeSlots([], day, TZ)));
  const around = freeSlots([ev("10:00", "10:30"), ev("13:00", "14:00"), ev("13:30", "15:00")], day, TZ);
  check("gaps around meetings, overlaps merged", fmt(around) === "09:00–10:00, 10:30–13:00, 15:00–18:00", fmt(around));
  const ignored = freeSlots([ev("10:00", "11:00", { selfResponse: "declined" }), ev("00:00", "23:59", { allDay: true })], day, TZ);
  check("declined and all-day events are not busy", fmt(ignored) === "09:00–18:00", fmt(ignored));
  check("a gap under the minimum is not reported", fmt(freeSlots([ev("09:20", "18:00")], day, TZ)) === "", fmt(freeSlots([ev("09:20", "18:00")], day, TZ)));

  // --- the block ---------------------------------------------------------------------------
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(calendarSources).where(eq(calendarSources.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  const [priya] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman", email: "priya@acme.io" }).returning();
  const [src] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();
  const [otherSrc] = await db
    .insert(calendarSources)
    .values({ userId: OTHER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();

  const now = at("2026-10-19", "08:00");
  const row = (sourceId: string, userId: string, id: string, title: string, dayStr: string, from: string, to: string, attendees: Array<{ name: string; email: string; contactId: string | null }>) => ({
    userId,
    sourceId,
    providerEventId: id,
    title,
    startAt: at(dayStr, from),
    endAt: at(dayStr, to),
    attendees,
    attendeeCount: attendees.length,
    conferenceKind: "meet",
  });
  await db.insert(calendarEvents).values([
    row(src.id, USER, "e1", "Pilot sync", "2026-10-20", "10:00", "10:30", [
      { name: "Priya Raman", email: "priya@acme.io", contactId: priya.id },
      { name: "Sam Guest", email: "sam@acme.io", contactId: null },
    ]),
    row(src.id, USER, "e2", "Board meeting", "2026-10-22", "15:00", "16:00", [{ name: "Dana Wu", email: "dana@vc.example", contactId: null }]),
    row(src.id, USER, "e3", "Priya follow-up", "2026-10-29", "11:00", "11:30", [
      { name: "Priya Raman", email: "priya@acme.io", contactId: priya.id },
    ]),
    row(otherSrc.id, OTHER, "o1", "Their secret meeting", "2026-10-20", "12:00", "13:00", []),
  ]);

  const tomorrow = await loadChatCalendar(USER, { calendarWindow: { after: "2026-10-20", before: "2026-10-20" } }, false, now, TZ);
  check("a one-day window lists that day's meeting", tomorrow.text.includes("Pilot sync") && !tomorrow.text.includes("Board meeting"), tomorrow.text);
  check("times are local and say their zone", tomorrow.text.includes("Times are in America/New_York") && tomorrow.text.includes("10:00–10:30"), tomorrow.text);
  check(
    "known attendees by name, strangers counted, never an address",
    tomorrow.text.includes("with Priya Raman, +1 other") && !tomorrow.text.includes("@"),
    tomorrow.text
  );
  check("known attendees reach the allowlist", JSON.stringify(tomorrow.people) === JSON.stringify([{ id: priya.id, name: "Priya Raman" }]));
  check("another user's meetings never appear", !tomorrow.text.includes("Their secret meeting"));

  const week = await loadChatCalendar(USER, null, false, now, TZ);
  check("no window is the next week", week.text.includes("Board meeting") && !week.text.includes("Priya follow-up"), week.text);
  const nextPriya = await loadChatCalendar(USER, { person: "Priya" }, false, now, TZ);
  check(
    "a person looks two weeks out, only at meetings they are on",
    nextPriya.text.includes("Pilot sync") && nextPriya.text.includes("Priya follow-up") && !nextPriya.text.includes("Board meeting"),
    nextPriya.text
  );
  const dana = await loadChatCalendar(USER, { person: "Dana Wu" }, false, now, TZ);
  check("someone not in Orbit is found by the name on the invite", dana.text.includes("Board meeting"), dana.text);

  const free = await loadChatCalendar(USER, { calendarWindow: { after: "2026-10-20", before: "2026-10-21" } }, true, now, TZ);
  check(
    "availability adds the free gaps, and lists a day with no meetings",
    free.text.includes("Free (9:00–18:00): 09:00–10:00, 10:30–18:00") && /no meetings\n\s+Free \(9:00–18:00\): 09:00–18:00/.test(free.text),
    free.text
  );

  // --- the prompt --------------------------------------------------------------------------
  const prompt = buildChatPrompt({
    question: "what's on tomorrow?",
    contactsContext: [],
    priorTurns: [],
    orgRosters: [],
    attention: null,
    recruitersContext: [],
    focusProfile: null,
    attachedContext: null,
    goals: [],
    attentionLite: null,
    evidence: null,
    notePassages: [],
    calendar: tomorrow.text,
  });
  check(
    "the block is fenced as untrusted, with its rule in the system prompt",
    /Your calendar[^\n]*:\n\(UNTRUSTED DATA[^\n]*\n<<<CALENDAR_/.test(prompt.user) && prompt.systemCore.includes("\"Your calendar\" section is present"),
    prompt.user.slice(0, 400)
  );
  const without = buildChatPrompt({
    question: "who knows Go?",
    contactsContext: [],
    priorTurns: [],
    orgRosters: [],
    attention: null,
    recruitersContext: [],
    focusProfile: null,
    attachedContext: null,
    goals: [],
    attentionLite: null,
    evidence: null,
    notePassages: [],
  });
  check("no calendar, no block and no rule", !without.user.includes("CALENDAR") && !without.systemCore.includes("Your calendar"));

  // --- wired into the real context, on the free keyword route (no AI key here) ------------
  const soon = new Date(Date.now() + 2 * 3_600_000);
  await db.insert(calendarEvents).values({
    userId: USER,
    sourceId: src.id,
    providerEventId: "soon",
    title: "Coffee with Priya",
    startAt: soon,
    endAt: new Date(soon.getTime() + 1_800_000),
    attendees: [{ name: "Priya Raman", email: "priya@acme.io", contactId: priya.id }],
    attendeeCount: 1,
  });
  const ctx = await prepareChatContext(USER, "What's on my calendar this week?", {});
  check(
    "a schedule question loads the block in one pass, and its people join the allowlist",
    ctx.route?.calendar === true &&
      ctx.route?.depth.depth === "single" &&
      ctx.calendar?.text.includes("Coffee with Priya") === true &&
      ctx.allowedContacts.has(priya.id),
    JSON.stringify({ route: ctx.route, calendar: ctx.calendar?.text })
  );
  const plain = await prepareChatContext(USER, "Who do I know at Acme?", {});
  check("any other question loads no calendar", plain.calendar === null && !plain.route?.calendar);

  if (failures) {
    console.error(`\nsmoke-chat-calendar: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-chat-calendar: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
