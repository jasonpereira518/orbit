/**
 * The recurrence expander.
 *
 * Pure tier. `parseIcsEvents` has always ignored RRULE, so a weekly 1:1 in a subscribed feed
 * was recorded once, at its first occurrence. These checks pin the expansion — and the one
 * property that protects stored data: a NON-recurring event's uid must come out byte-identical,
 * because `cal:<uid>` is already written on every interaction Orbit has ever ingested.
 */
import { expandEvent, occurrenceUid, parseRRule, MAX_OCCURRENCES } from "../src/lib/recurrence";
import { parseIcsEvents, type ParsedCalendarEvent } from "../src/lib/calendar-import";

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

  // EXDATE matches by exact instant (RFC 5545) — this value is the DST-correct Mar 10
  // occurrence (13:00Z, not the naive 14:00Z a fixed-offset producer would write; see the
  // DST check just below for why).
  const skipped = expandEvent(evt("2026-03-03T14:00:00Z"), parseRRule("RRULE:FREQ=WEEKLY"), WINDOW, {
    exDates: [new Date("2026-03-10T13:00:00Z")],
  });
  check("EXDATE removes exactly one occurrence", skipped.length === 4, `got ${skipped.length}`);
  check(
    "EXDATE removes the Mar 10 occurrence specifically",
    !skipped.some((e) => e.start?.toISOString() === "2026-03-10T13:00:00.000Z")
  );

  // DST: America/New_York moves on 2026-03-08. A 09:00 local meeting stays 09:00 local,
  // which means its UTC hour changes from 14:00 to 13:00.
  check(
    "keeps local wall-clock across a DST change",
    every[1]?.start?.toISOString() === "2026-03-10T13:00:00.000Z",
    `got ${every[1]?.start?.toISOString()}`
  );

  const capped = expandEvent(evt("2026-03-01T00:00:00Z"), parseRRule("RRULE:FREQ=DAILY"), {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2030-01-01T00:00:00Z"),
  });
  check("caps runaway rules", capped.length === MAX_OCCURRENCES, `got ${capped.length}`);

  // --- the occurrence cap must not be consumed by candidates before the window ---
  //
  // Regression pin for the bug where `n` was both the COUNT tally and the emit cap, and
  // incremented for every candidate EARLIER than `window.from` too — so a rolling
  // 90-days-back/60-forward window plus a DTSTART well in the past silently produced fewer
  // occurrences than the window should hold, or none at all, with no fallback (`expandEvent`
  // returns `[]` rather than the master). Anchored to a fixed "now" so the suite stays
  // deterministic.
  const ROLLING_NOW = new Date("2026-09-23T00:00:00Z");
  const ROLLING_WINDOW = {
    from: new Date(ROLLING_NOW.getTime() - 90 * 86400000),
    to: new Date(ROLLING_NOW.getTime() + 60 * 86400000),
  };
  function daysAgo(n: number): string {
    return new Date(ROLLING_NOW.getTime() - n * 86400000).toISOString();
  }
  function assertFillsWindow(label: string, occurrences: ParsedCalendarEvent[]) {
    const futureCount = occurrences.filter((e) => (e.start?.getTime() ?? 0) >= ROLLING_NOW.getTime()).length;
    check(`${label}: produces occurrences`, occurrences.length > 0, `got ${occurrences.length}`);
    check(
      `${label}: includes at least one FUTURE occurrence`,
      futureCount > 0,
      `${futureCount} of ${occurrences.length} are future`
    );
  }

  // A daily standup that started 400 days ago used to have zero future occurrences (the cap
  // was exhausted by the ~400 skipped-but-counted candidates before window.from).
  assertFillsWindow(
    "daily series, DTSTART 400 days back",
    expandEvent(evt(daysAgo(400)), parseRRule("RRULE:FREQ=DAILY"), ROLLING_WINDOW)
  );

  // A daily standup that started 500 days ago used to produce NOTHING at all.
  assertFillsWindow(
    "daily series, DTSTART 500 days back",
    expandEvent(evt(daysAgo(500)), parseRRule("RRULE:FREQ=DAILY"), ROLLING_WINDOW)
  );

  // A three-year-old MWF series used to vanish entirely too.
  assertFillsWindow(
    "weekly MWF series, DTSTART 3 years back",
    expandEvent(evt(daysAgo(3 * 365)), parseRRule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"), ROLLING_WINDOW)
  );

  // An eight-year-old weekly series, same failure.
  assertFillsWindow(
    "weekly series, DTSTART 8 years back",
    expandEvent(evt(daysAgo(8 * 365)), parseRRule("RRULE:FREQ=WEEKLY"), ROLLING_WINDOW)
  );

  // A runaway-old DTSTART (well before any realistic calendar) must still terminate quickly —
  // the independent iteration bound, not just the emit cap, is what stops it.
  {
    const t0 = Date.now();
    const ancient = expandEvent(
      evt("1970-01-05T14:00:00Z"),
      parseRRule("RRULE:FREQ=DAILY"),
      ROLLING_WINDOW
    );
    const elapsedMs = Date.now() - t0;
    assertFillsWindow("daily series, DTSTART in 1970", ancient);
    check("a 1970 DTSTART expands in well under a second", elapsedMs < 5000, `${elapsedMs}ms`);
  }

  // --- MONTHLY ---
  const SIX_MONTH_WINDOW = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") };

  const monthlyByMonthDay = expandEvent(
    evt("2026-01-15T14:00:00Z"),
    parseRRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15"),
    SIX_MONTH_WINDOW
  );
  check("MONTHLY BYMONTHDAY fills six months", monthlyByMonthDay.length === 6, `got ${monthlyByMonthDay.length}`);
  check(
    "MONTHLY BYMONTHDAY keeps the 15th every month, DST notwithstanding",
    monthlyByMonthDay.every((e) => e.start?.getUTCDate() === 15),
    monthlyByMonthDay.map((e) => e.start?.toISOString()).join(",")
  );

  // "Last Friday of the month": Jan 30, Feb 27, Mar 27, 2026 — crossing the same DST change.
  const lastFriday = expandEvent(
    evt("2026-01-30T14:00:00Z"),
    parseRRule("RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1"),
    { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") }
  );
  check("MONTHLY BYDAY+BYSETPOS finds one Friday per month", lastFriday.length === 3, `got ${lastFriday.length}`);
  check(
    "MONTHLY BYDAY+BYSETPOS finds the LAST Friday each month",
    lastFriday.map((e) => e.start?.toISOString()).join(",") ===
      ["2026-01-30T14:00:00.000Z", "2026-02-27T14:00:00.000Z", "2026-03-27T13:00:00.000Z"].join(","),
    lastFriday.map((e) => e.start?.toISOString()).join(",")
  );

  // Out of the documented subset (negative BYMONTHDAY — "last day of the month" — is real
  // RFC 5545 but not one this module implements): falls back to the master alone. The point
  // of this check is as much that it RETURNS at all as what it returns — a rule like this
  // used to be able to hang the generator forever.
  const negativeMonthDay = expandEvent(
    evt("2026-01-15T14:00:00Z"),
    parseRRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"),
    SIX_MONTH_WINDOW
  );
  check(
    "out-of-subset BYMONTHDAY=-1 returns the master alone",
    negativeMonthDay.length === 1 && negativeMonthDay[0]?.uid === "u1"
  );

  // BYSETPOS=6 is a supported rule SHAPE (MONTHLY + BYDAY + BYSETPOS) but no month has a 6th
  // Friday, so it can never match. isSupportedRule can't reject this by range the way it
  // rejects BYMONTHDAY; the generator's own empty-period bail-out is what stops this from
  // hanging, and this pins that it stops with zero occurrences rather than hanging or throwing.
  const neverMatchingSetPos = expandEvent(
    evt("2026-01-30T14:00:00Z"),
    parseRRule("RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=6"),
    SIX_MONTH_WINDOW
  );
  check(
    "a BYSETPOS that can never match terminates with no occurrences",
    neverMatchingSetPos.length === 0,
    `got ${neverMatchingSetPos.length}`
  );

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

  // --- through the ICS parser ---
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "SUMMARY:1:1 with Priya",
    "DTSTART;TZID=America/New_York:20260303T090000",
    "DTEND;TZID=America/New_York:20260303T093000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;TZID=America/New_York:20260310T090000",
    "ATTENDEE;CN=Priya:mailto:priya@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const parsed = parseIcsEvents(ics);
  check("parser keeps the rule", parsed[0]?.rrule === "FREQ=WEEKLY;COUNT=3");
  check("parser keeps EXDATE", parsed[0]?.exDates?.length === 1);

  const fromFeed = expandEvent(parsed[0]!, parseRRule(`RRULE:${parsed[0]!.rrule}`), WINDOW, {
    exDates: parsed[0]!.exDates ?? [],
  });
  check("a weekly feed event yields its occurrences minus EXDATE", fromFeed.length === 2, `got ${fromFeed.length}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll recurrence checks passed.");
}

main();
