/**
 * The stated-cadence grammar, and the roll-forward that makes "next occurrence only" real.
 *
 * Two things are load-bearing here. First, unknown phrasing must return null rather than a
 * guess — a wrong cadence silently retunes the dormancy thresholds for that person, which is
 * worse than having none. Second, the next occurrence must never be created already overdue:
 * a note from three months ago saying "monthly" has to schedule the NEXT check-in, because a
 * reminder that arrives pre-overdue trains people to ignore the list.
 *
 * Run: npx tsx scripts/smoke-cadence.ts
 */

import {
  MAX_CADENCE_DAYS,
  MIN_CADENCE_DAYS,
  nextCadenceOccurrence,
  parseCadencePhrase,
} from "../src/lib/cadence-phrase";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

console.log("\nphrases that resolve");

{
  const cases: Array<[string, number]> = [
    ["weekly", 7],
    ["monthly", 30],
    ["quarterly", 91],
    ["yearly", 365],
    ["annually", 365],
    ["fortnightly", 14],
    ["biweekly", 14],
    ["bi-weekly", 14],
    ["bimonthly", 60],
    ["every week", 7],
    ["every two weeks", 14],
    ["every 2 weeks", 14],
    ["every three months", 90],
    ["every other week", 14],
    ["every other month", 60],
    ["each quarter", 91],
    ["once a month", 30],
    ["once a quarter", 91],
    ["twice a year", 183],
    ["4 times a year", 91],
    // A verb in front must not change the answer — this is how people actually write it.
    ["check in monthly", 30],
    ["ping me every two weeks", 14],
    ["touch base quarterly", 91],
    ["catch up every 6 weeks", 42],
    ["  Check In   MONTHLY  ", 30],
  ];
  for (const [phrase, days] of cases) {
    const r = parseCadencePhrase(phrase);
    check(`"${phrase}" -> ${days}d`, r?.days === days, String(r?.days));
  }
}

// The phrase is preserved verbatim so the UI can quote the person back to themselves
// rather than saying "every 30 days", which nobody said.
{
  const r = parseCadencePhrase("  check in   monthly ");
  check("phrase is preserved, whitespace-collapsed", r?.phrase === "check in monthly", r?.phrase);
}

console.log("\nphrases that must NOT resolve");

{
  const rejects = [
    "daily", // 1 day: below MIN_CADENCE_DAYS, a reminder treadmill
    "every day",
    "every 400 days", // above MAX_CADENCE_DAYS: indistinguishable from no cadence
    "every 2 years",
    "a few times a year", // a vibe, not a commitment
    "several times a year",
    "sometimes",
    "soon",
    "when I get a chance",
    "next Tuesday", // a one-off date, not a rhythm
    "in two weeks",
    "every so often",
    "regularly",
    "",
    "   ",
  ];
  for (const phrase of rejects) {
    check(`"${phrase}" -> null`, parseCadencePhrase(phrase) === null, JSON.stringify(parseCadencePhrase(phrase)));
  }
  check(`MIN is ${MIN_CADENCE_DAYS}`, MIN_CADENCE_DAYS === 3);
  check(`MAX is ${MAX_CADENCE_DAYS}`, MAX_CADENCE_DAYS === 365);
}

console.log("\nnext occurrence rolls forward, never lands overdue");

// A three-month-old note saying "monthly": the next check-in is ahead of today, not the one
// that came due six weeks ago.
{
  const anchor = new Date(2026, 5, 1, 12, 0, 0, 0); // 2026-06-01
  const today = new Date(2026, 8, 16, 12, 0, 0, 0); // 2026-09-16
  const next = nextCadenceOccurrence(anchor, 30, today);
  check("monthly from 3 months ago is in the future", next >= new Date(2026, 8, 16, 0, 0, 0, 0), isoDay(next));
  check("  and is the NEXT one, not a distant one", isoDay(next) === "2026-09-29", isoDay(next));
}

// A fresh note just schedules anchor + cadence.
{
  const anchor = new Date(2026, 8, 16, 12, 0, 0, 0);
  const next = nextCadenceOccurrence(anchor, 14, anchor);
  check("a fresh note is anchor + cadence", isoDay(next) === "2026-09-30", isoDay(next));
}

// Exactly on the boundary: the occurrence that lands ON today is acceptable, not skipped.
{
  const anchor = new Date(2026, 8, 2, 12, 0, 0, 0); // 2026-09-02
  const today = new Date(2026, 8, 16, 12, 0, 0, 0); // 2026-09-16 == anchor + 14
  const next = nextCadenceOccurrence(anchor, 14, today);
  check("an occurrence landing on today is kept", isoDay(next) === "2026-09-16", isoDay(next));
}

// A very stale anchor still terminates and still lands ahead of today.
{
  const anchor = new Date(2016, 0, 1, 12, 0, 0, 0);
  const today = new Date(2026, 8, 16, 12, 0, 0, 0);
  const next = nextCadenceOccurrence(anchor, 7, today);
  check("a decade-old weekly anchor still resolves forward", next >= new Date(2026, 8, 16, 0, 0, 0, 0), isoDay(next));
}

console.log("\nAll cadence checks passed.");
