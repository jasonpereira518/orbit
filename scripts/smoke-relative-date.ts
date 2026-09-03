/**
 * The relative-date grammar, pinned to a fixed anchor so every rule is checked against a
 * known calendar. No network, no DB.
 * Run: npx tsx scripts/smoke-relative-date.ts
 */
import { resolveRelativeDate } from "../src/lib/relative-date";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function iso(d: Date | null | undefined) {
  if (!d) return "null";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Tuesday 2026-09-01, 9:30 local — not noon, so the noon pin is exercised.
const ANCHOR = new Date(2026, 8, 1, 9, 30, 0, 0);

const table: Array<[phrase: string, expectedIso: string, basis: string, rule: string]> = [
  ["tomorrow", "2026-09-02", "relative", "tomorrow"],
  ["in 3 days", "2026-09-04", "relative", "in-n-units"],
  ["in two weeks", "2026-09-15", "relative", "in-n-units"],
  ["in a couple of weeks", "2026-09-15", "relative", "in-n-units"],
  ["in a few days", "2026-09-04", "relative", "in-n-units"],
  ["in 2 months", "2026-11-01", "relative", "in-n-units"],
  ["Friday", "2026-09-04", "relative", "weekday"],
  ["next Friday", "2026-09-04", "relative", "weekday"],
  ["this Tuesday", "2026-09-08", "relative", "weekday"], // strictly after the anchor Tuesday
  ["next week", "2026-09-07", "relative", "next-week"],
  ["next month", "2026-10-01", "relative", "next-month"],
  ["end of the week", "2026-09-04", "relative", "end-of-week"],
  ["EOW", "2026-09-04", "relative", "end-of-week"],
  ["end of month", "2026-09-30", "relative", "end-of-month"],
  ["eom", "2026-09-30", "relative", "end-of-month"],
  ["end of the quarter", "2026-09-30", "relative", "end-of-quarter"],
  ["end of year", "2026-12-31", "relative", "end-of-year"],
  ["Q4", "2026-10-01", "relative", "quarter"],
  ["Q3", "2027-07-01", "relative", "quarter"], // Q3 2026 already started → next year
  ["after the holidays", "2027-01-02", "relative", "after-holidays"],
  ["soon", "2026-09-15", "vague", "vague"],
  ["at some point", "2026-09-15", "vague", "vague"],
  ["when you get a chance", "2026-09-15", "vague", "vague"],
  ["next time", "2026-09-15", "vague", "vague"],
];

for (const [phrase, expected, basis, rule] of table) {
  const r = resolveRelativeDate(phrase, ANCHOR);
  check(`"${phrase}" → ${expected}`, r !== null && iso(r.date) === expected, iso(r?.date));
  check(`  basis ${basis}`, r?.basis === basis, r?.basis);
  check(`  rule ${rule}`, r?.rule === rule, r?.rule);
  check(`  pinned to noon`, r?.date.getHours() === 12, String(r?.date.getHours()));
}

// Unknown phrasing is a null, never a guess.
check('"Sept 2" is not relative', resolveRelativeDate("Sept 2", ANCHOR) === null);
check('"the deck" is null', resolveRelativeDate("the deck", ANCHOR) === null);
check('"last week" is null (past)', resolveRelativeDate("last week", ANCHOR) === null);

// Vague window is configurable.
{
  const r = resolveRelativeDate("soon", ANCHOR, { defaultWindowDays: 7 });
  check("vague window honors defaultWindowDays", iso(r?.date) === "2026-09-08", iso(r?.date));
}

// Month arithmetic clamps instead of overflowing: Jan 31 + 1 month is Feb 28, not Mar 3.
{
  const jan31 = new Date(2026, 0, 31, 12);
  const r = resolveRelativeDate("in 1 month", jan31);
  check("in 1 month from Jan 31 → Feb 28", iso(r?.date) === "2026-02-28", iso(r?.date));
}

// Case and surrounding whitespace do not matter.
check("case-insensitive", iso(resolveRelativeDate("  Next FRIDAY ", ANCHOR)?.date) === "2026-09-04");

console.log("\nsmoke-relative-date: all checks passed");
