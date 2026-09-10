/**
 * Pins `nextPassAt` in `src/lib/follow-ups/scheduler.ts` — a pure function, no database.
 *
 * This is the trickiest single expression in the follow-up engine:
 *
 *     const hoursUntil = (PASS_HOUR_LOCAL - localHour + 24) % 24 || 24;
 *
 * The `|| 24` is load-bearing: `%` on equal operands is `0`, which is falsy, so `|| 24`
 * rewrites "already at the target hour" to "24 hours from now" rather than "right now". A
 * well-meaning cleanup to `?? 24` (the more modern-looking operator) would silently break
 * this — `??` only falls back on `null`/`undefined`, and `0` is neither, so a user claimed
 * at exactly local 07:00 would get `next_pass_at = now` and be re-claimed on every
 * invocation forever. The exactly-07:00 case below asserts against this directly, and the
 * mutation check run during verification (swap `|| 24` for `?? 24`, confirm this file goes
 * red, revert) proves the assertion is actually live rather than vacuously true.
 *
 * Run: npx tsx scripts/smoke-follow-up-scheduler.ts
 */
import { nextPassAt, PASS_HOUR_LOCAL } from "../src/lib/follow-ups/scheduler";

let count = 0;
function check(label: string, condition: boolean, detail?: string) {
  count++;
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Same technique `nextPassAt` itself uses, so the test can verify against it independently. */
function localHourAt(date: Date, zone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(
      date
    )
  );
}

const HOUR = 60 * 60 * 1000;

function main() {
  console.log("Fallback behavior...");

  // A null timezone must fall back to UTC rather than throwing.
  const NOW_UTC0 = new Date("2026-09-10T00:00:00Z");
  let nullResult: Date | undefined;
  let nullThrew = false;
  try {
    nullResult = nextPassAt(null, NOW_UTC0);
  } catch {
    nullThrew = true;
  }
  check("a null timezone does not throw", !nullThrew);
  check(
    "a null timezone lands on the target hour in UTC",
    nullResult !== undefined && localHourAt(nullResult, "UTC") === PASS_HOUR_LOCAL,
    nullResult?.toISOString()
  );

  // A malformed IANA string must fall back rather than throwing.
  let malformedResult: Date | undefined;
  let malformedThrew = false;
  try {
    malformedResult = nextPassAt("Not/AReal_Zone", NOW_UTC0);
  } catch {
    malformedThrew = true;
  }
  check("a malformed IANA string does not throw", !malformedThrew);
  check(
    "a malformed IANA string falls back to the UTC-hour calculation",
    malformedResult?.getTime() === (nullResult?.getTime() ?? NaN),
    `malformed=${malformedResult?.toISOString()} null=${nullResult?.toISOString()}`
  );

  console.log("\nReal zones land on the intended local hour...");

  // Positive whole-hour offset, no DST.
  const tokyo = nextPassAt("Asia/Tokyo", NOW_UTC0);
  check(
    "Asia/Tokyo (UTC+9) lands on local 07:00",
    localHourAt(tokyo, "Asia/Tokyo") === PASS_HOUR_LOCAL,
    tokyo.toISOString()
  );

  // Negative whole-hour offset (PDT in September).
  const losAngeles = nextPassAt("America/Los_Angeles", NOW_UTC0);
  check(
    "America/Los_Angeles (UTC-7 in September) lands on local 07:00",
    localHourAt(losAngeles, "America/Los_Angeles") === PASS_HOUR_LOCAL,
    losAngeles.toISOString()
  );

  // Half-hour offset, no DST. The algorithm targets the HOUR, not the minute, so 07:30
  // local is the correct (documented) outcome here, not a bug — this pins that behavior
  // rather than an exact top-of-hour landing.
  const kolkata = nextPassAt("Asia/Kolkata", NOW_UTC0);
  check(
    "Asia/Kolkata (UTC+5:30) lands on local hour 07 (07:30 wall clock)",
    localHourAt(kolkata, "Asia/Kolkata") === PASS_HOUR_LOCAL,
    kolkata.toISOString()
  );

  console.log("\nThe exactly-07:00-local edge case...");

  // A user whose local clock reads exactly 07:00 at claim time. `localHour === PASS_HOUR_LOCAL`
  // makes `(PASS_HOUR_LOCAL - localHour + 24) % 24` evaluate to `0`, which is what the `|| 24`
  // exists to catch — the pass must land a full day out, never immediately.
  const NOW_UTC7 = new Date("2026-09-10T07:00:00Z");
  check(
    "local hour is actually 7 at this instant (sanity-checking the fixture, not the function)",
    localHourAt(NOW_UTC7, "UTC") === PASS_HOUR_LOCAL
  );
  const atTarget = nextPassAt("UTC", NOW_UTC7);
  check(
    "07:00-local schedules exactly 24 hours out",
    atTarget.getTime() === NOW_UTC7.getTime() + 24 * HOUR,
    `got ${atTarget.toISOString()}, expected ${new Date(NOW_UTC7.getTime() + 24 * HOUR).toISOString()}`
  );
  check(
    "07:00-local does NOT schedule for right now (the `?? 24` regression this guards against)",
    atTarget.getTime() !== NOW_UTC7.getTime()
  );

  console.log(`\nAll ${count} follow-up scheduler checks passed.`);
}

main();
