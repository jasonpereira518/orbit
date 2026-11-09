/**
 * Recurrence expansion at month ends and across DST (`src/lib/recurrence.ts`). Pure.
 *
 *   npx tsx stress-tests/recurrence-edge.ts
 */
import { check, finding, run, summary } from "./_harness";
import { expandEvent, parseRRule, MAX_OCCURRENCES } from "../src/lib/recurrence";
import type { ParsedCalendarEvent } from "../src/lib/calendar-import";

function ev(start: string, tz: string | null, rrule: string, uid = "u1"): ParsedCalendarEvent {
  const s = new Date(start);
  return { uid, summary: "s", description: "", location: "", start: s, end: new Date(s.getTime() + 3600_000), attendees: [], organizer: null, timezone: tz, rrule } as ParsedCalendarEvent;
}
const wall = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false }).format(d);

run(async () => {
  console.log("Monthly on the 31st...");
  {
    const e = ev("2026-01-31T17:00:00Z", "UTC", "FREQ=MONTHLY;COUNT=6");
    const out = expandEvent(e, parseRRule("RRULE:FREQ=MONTHLY;COUNT=6"), { from: new Date("2026-01-01"), to: new Date("2027-01-01") });
    const days = out.map((o) => o.start!.toISOString().slice(0, 10));
    check(`occurrences: ${days.join(", ")}`, true);
    finding("REC-1", "Jan 31 monthly never lands on Mar 3 / Feb 28 spill (RFC 5545 says skip months without the day)", !days.includes("2026-03-03") && !days.includes("2026-03-02"), days.join(","));
  }

  console.log("\nWeekly 09:00 America/New_York across the March DST change...");
  {
    const rule = parseRRule("RRULE:FREQ=WEEKLY;COUNT=4");
    const e = ev("2026-03-02T14:00:00Z", "America/New_York", "FREQ=WEEKLY;COUNT=4"); // 09:00 EST
    const out = expandEvent(e, rule, { from: new Date("2026-03-01"), to: new Date("2026-04-01") });
    const walls = out.map((o) => wall(o.start!, "America/New_York"));
    check(`wall clocks: ${walls.join(" | ")}`, true);
    finding("REC-2", "every occurrence stays at 09:00 local across DST", walls.every((w) => w.endsWith("09:00")), walls.join(","));
  }

  console.log("\nAn occurrence that falls inside the spring-forward gap...");
  {
    const rule = parseRRule("RRULE:FREQ=DAILY;COUNT=3");
    const e = ev("2026-03-07T07:30:00Z", "America/New_York", "FREQ=DAILY;COUNT=3"); // 02:30 EST on Mar 7; Mar 8 02:30 does not exist
    const out = expandEvent(e, rule, { from: new Date("2026-03-01"), to: new Date("2026-04-01") });
    const walls = out.map((o) => `${o.start!.toISOString()} = ${wall(o.start!, "America/New_York")}`);
    check(`gap handling: ${walls.join(" | ")}`, true);
    check("no NaN starts", out.every((o) => !Number.isNaN(o.start!.getTime())));
  }

  console.log("\nRunaway rules...");
  {
    const rule = parseRRule("RRULE:FREQ=DAILY");
    const e = ev("2000-01-01T10:00:00Z", "UTC", "FREQ=DAILY");
    const t0 = Date.now();
    const out = expandEvent(e, rule, { from: new Date("2000-01-01"), to: new Date("2100-01-01") });
    check(`DAILY with no COUNT/UNTIL over 100 years is capped at MAX_OCCURRENCES=${MAX_OCCURRENCES} (${out.length} in ${Date.now() - t0}ms)`, out.length <= MAX_OCCURRENCES);
  }
  {
    const rule = parseRRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=31;INTERVAL=1");
    const e = ev("2026-01-31T10:00:00Z", "UTC", "x");
    const t0 = Date.now();
    const out = expandEvent(e, rule, { from: new Date("2026-01-01"), to: new Date("2036-01-01") });
    check(`BYMONTHDAY=31 for 10 years terminates (${out.length} occurrences, ${Date.now() - t0}ms)`, Date.now() - t0 < 2000);
  }
  {
    // Run in a child process with a hard timeout: on the current code this never returns.
    const { spawnSync } = await import("node:child_process");
    const t0 = Date.now();
    const res = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "stress-tests/_probes/recurrence-hang.ts", "1000000000"], { timeout: 10_000, encoding: "utf8" });
    const hung = res.signal === "SIGTERM" || res.error?.message.includes("ETIMEDOUT");
    finding("REC-3", "RRULE:FREQ=MONTHLY;INTERVAL=1000000000 (a line in any subscribed ICS feed) terminates in under 10s", !hung, hung ? `still running after ${Date.now() - t0}ms — stepMonths() loops INTERVAL times per candidate and a 5-digit year never matches fromWallClockInput, so the 50,000-candidate bound costs 5e13 iterations` : `${res.stdout.trim()} in ${Date.now() - t0}ms`);
  }
  {
    const rule = parseRRule("RRULE:FREQ=YEARLY;INTERVAL=0;COUNT=3");
    check("INTERVAL=0 is normalised to 1 rather than looping", rule?.interval === 1);
    const r2 = parseRRule("RRULE:FREQ=DAILY;COUNT=-5");
    const out = expandEvent(ev("2026-01-01T10:00:00Z", "UTC", "x"), r2, { from: new Date("2026-01-01"), to: new Date("2026-02-01") });
    check(`COUNT=-5 yields ${out.length} occurrences`, out.length <= MAX_OCCURRENCES);
  }
  summary();
});
