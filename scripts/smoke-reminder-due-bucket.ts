/**
 * Pins `src/lib/reminder-due-bucket.ts` — the one definition of "what day is this reminder
 * due, and is that today" shared by the reminders query, its rail and every row label.
 * Pure: pinned instants, no database. (The SQL twin is held to it by
 * `smoke-reminders-page.ts`.)
 *
 * Run: npx tsx scripts/smoke-reminder-due-bucket.ts
 */
import {
  addDaysYmd,
  bucketForDay,
  daysBetweenYmd,
  dueDayOf,
  dueLabelFor,
  isDateOnlyDue,
  isValidTimeZone,
  resolveTimeZone,
  snoozePresets,
  weekdayOfYmd,
  ymdInZone,
} from "../src/lib/reminder-due-bucket";

let failures = 0;
function eq<T>(label: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

console.log("timezone validation");
eq("IANA zone accepted", isValidTimeZone("America/New_York"), true);
eq("UTC accepted", isValidTimeZone("UTC"), true);
eq("unknown zone refused", isValidTimeZone("Mars/Olympus_Mons"), false);
eq("SQL-shaped input refused", isValidTimeZone("UTC'; drop table reminders;--"), false);
eq("empty refused", isValidTimeZone(""), false);
eq("non-string refused", isValidTimeZone(42), false);
eq("resolve falls back to UTC", resolveTimeZone("nope/nope"), "UTC");

console.log("\ndate-only detection");
eq("UTC midnight is date-only", isDateOnlyDue(new Date("2026-09-18T00:00:00Z")), true);
eq("UTC noon is date-only", isDateOnlyDue(new Date("2026-09-18T12:00:00Z")), true);
eq("a timed instant is not", isDateOnlyDue(new Date("2026-09-18T09:00:00Z")), false);
eq("one millisecond past midnight is not", isDateOnlyDue(new Date("2026-09-18T00:00:00.001Z")), false);

console.log("\ndue day");
// The bug this module exists for: read in New York, UTC midnight on the 18th is 8pm on the
// 17th. A date-only value must keep its own date.
eq("date-only keeps its date west of UTC", dueDayOf("2026-09-18T00:00:00Z", "America/New_York"), "2026-09-18");
eq("date-only keeps its date east of UTC", dueDayOf("2026-09-18T12:00:00Z", "Pacific/Auckland"), "2026-09-18");
eq("a timed value is read in the viewer's zone (west)", dueDayOf("2026-09-18T03:00:00Z", "America/Los_Angeles"), "2026-09-17");
eq("a timed value is read in the viewer's zone (east)", dueDayOf("2026-09-18T20:00:00Z", "Asia/Tokyo"), "2026-09-19");
eq("null is no day", dueDayOf(null, "UTC"), null);
eq("garbage is no day", dueDayOf("not a date", "UTC"), null);
eq("ymdInZone across a DST change (LA, Nov 1 2026)", ymdInZone(new Date("2026-11-01T08:30:00Z"), "America/Los_Angeles"), "2026-11-01");

console.log("\nday arithmetic");
eq("adds across a month end", addDaysYmd("2026-09-29", 3), "2026-10-02");
eq("adds across a leap day", addDaysYmd("2028-02-28", 1), "2028-02-29");
eq("subtracts across a year", addDaysYmd("2027-01-01", -1), "2026-12-31");
eq("days between, forward", daysBetweenYmd("2026-09-18", "2026-09-25"), 7);
eq("days between, backward", daysBetweenYmd("2026-09-18", "2026-09-15"), -3);
eq("weekday (Fri 2026-09-18)", weekdayOfYmd("2026-09-18"), 5);

console.log("\nbuckets (today = 2026-09-18)");
const T = "2026-09-18";
eq("yesterday → overdue", bucketForDay("2026-09-17", T), "overdue");
eq("today → today", bucketForDay(T, T), "today");
eq("tomorrow → tomorrow", bucketForDay("2026-09-19", T), "tomorrow");
eq("+2 → week", bucketForDay("2026-09-20", T), "week");
eq("+7 → week (inclusive)", bucketForDay("2026-09-25", T), "week");
eq("+8 → later", bucketForDay("2026-09-26", T), "later");
eq("no date → none", bucketForDay(null, T), "none");

console.log("\nlabels");
eq("overdue by one reads Yesterday", dueLabelFor("2026-09-17", T)?.text, "Yesterday");
eq("overdue by three", dueLabelFor("2026-09-15", T)?.text, "Overdue 3 days");
eq("today", dueLabelFor(T, T)?.text, "Today");
eq("tomorrow", dueLabelFor("2026-09-19", T)?.text, "Tomorrow");
eq("same year omits the year", dueLabelFor("2026-09-26", T)?.text, "Sat, Sep 26");
eq("another year shows it", dueLabelFor("2027-01-04", T)?.text, "Jan 4, 2027");
eq("undated has no label", dueLabelFor(null, T), null);

console.log("\nsnooze presets");
// 2026-09-18 is a Friday.
eq("from Friday", snoozePresets("2026-09-18"), { tomorrow: "2026-09-19", weekend: "2026-09-19", nextWeek: "2026-09-21" });
eq("from Saturday: weekend is Sunday", snoozePresets("2026-09-19"), { tomorrow: "2026-09-20", weekend: "2026-09-20", nextWeek: "2026-09-21" });
eq("from Sunday: weekend is next Saturday", snoozePresets("2026-09-20"), { tomorrow: "2026-09-21", weekend: "2026-09-26", nextWeek: "2026-09-21" });
eq("from Monday: next week is the following Monday", snoozePresets("2026-09-21"), { tomorrow: "2026-09-22", weekend: "2026-09-26", nextWeek: "2026-09-28" });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall due-bucket checks passed");
process.exit(0);
