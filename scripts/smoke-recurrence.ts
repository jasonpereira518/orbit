/**
 * The recurrence expander.
 *
 * Pure tier. `parseIcsEvents` has always ignored RRULE, so a weekly 1:1 in a subscribed feed
 * was recorded once, at its first occurrence. These checks pin the expansion — and the one
 * property that protects stored data: a NON-recurring event's uid must come out byte-identical,
 * because `cal:<uid>` is already written on every interaction Orbit has ever ingested.
 */
import { expandEvent, occurrenceUid, parseRRule, MAX_OCCURRENCES } from "../src/lib/recurrence";
import type { ParsedCalendarEvent } from "../src/lib/calendar-import";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function evt(start: string, over: Partial<ParsedCalendarEvent> = {}): ParsedCalendarEvent {
  return {
    uid: "u1",
    summary: "1:1 with Priya",
    description: "",
    location: "",
    start: new Date(start),
    end: new Date(new Date(start).getTime() + 30 * 60000),
    attendees: [{ name: "Priya", email: "priya@example.com" }],
    organizer: null,
    timezone: "America/New_York",
    ...over,
  };
}

const WINDOW = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") };

async function main() {
  // --- parseRRule ---
  const weekly = parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
  check("parses FREQ and BYDAY", weekly?.freq === "WEEKLY" && weekly?.byDay.join() === "TU");
  check("defaults INTERVAL to 1", parseRRule("RRULE:FREQ=DAILY")?.interval === 1);
  check("reads COUNT", parseRRule("RRULE:FREQ=DAILY;COUNT=3")?.count === 3);
  check(
    "reads UNTIL as a real date",
    parseRRule("RRULE:FREQ=DAILY;UNTIL=20260315T000000Z")?.until?.toISOString() ===
      "2026-03-15T00:00:00.000Z"
  );
  check("returns null for junk", parseRRule("RRULE:FREQ=NEVER") === null);

  // --- expansion ---
  const every = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW);
  check("weekly fills the window", every.length === 5, `got ${every.length}`);
  check("first occurrence keeps the master's start", every[0]?.start?.toISOString() === "2026-03-03T14:00:00.000Z");

  const counted = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY;COUNT=2"), WINDOW);
  check("COUNT stops expansion", counted.length === 2, `got ${counted.length}`);

  // NOTE: the plan's brief used UNTIL=20260318T000000Z here, which admits the Mar 17
  // occurrence (true count 3). Corrected per plan ruling to pin the Mar 10/Mar 17 boundary
  // with the count the brief intended (2).
  const untilled = expandEvent(
    evt("2026-03-03T14:00:00Z"),
    parseRRule("RRULE:FREQ=WEEKLY;UNTIL=20260311T000000Z"),
    WINDOW
  );
  check("UNTIL stops expansion", untilled.length === 2, `got ${untilled.length}`);

  const skipped = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW, {
    exDates: [new Date("2026-03-10T14:00:00Z")],
  });
  check("EXDATE removes that occurrence", skipped.length === 4 && !skipped.some((e) => e.start?.toISOString() === "2026-03-10T14:00:00.000Z"));

  // DST: America/New_York moves on 2026-03-08. A 09:00 local meeting stays 09:00 local,
  // which means its UTC hour changes from 14:00 to 13:00.
  const dst = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW);
  check(
    "keeps local wall-clock across a DST change",
    dst[1]?.start?.toISOString() === "2026-03-10T13:00:00.000Z",
    `got ${dst[1]?.start?.toISOString()}`
  );

  const capped = expandEvent(evt("2026-03-01T00:00:00Z"), parseRRule("RRULE:FREQ=DAILY"), {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2030-01-01T00:00:00Z"),
  });
  check("caps runaway rules", capped.length === MAX_OCCURRENCES, `got ${capped.length}`);

  // --- ids ---
  check(
    "a non-recurring event is returned untouched",
    expandEvent(evt("2026-03-03T14:00:00Z"), null, WINDOW)[0]?.uid === "u1"
  );
  check(
    "occurrences get a distinct, stable uid",
    occurrenceUid("u1", new Date("2026-03-10T13:00:00Z")) === "u1_2026-03-10T13:00:00.000Z"
  );
  check(
    "expanded occurrences carry occurrence uids",
    every[1]?.uid === occurrenceUid("u1", every[1]!.start!)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll recurrence checks passed.");
}

main();
