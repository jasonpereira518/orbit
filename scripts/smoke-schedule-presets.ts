/**
 * Scheduled-send presets and labels, in a fixed zone so the results don't depend on the machine.
 * Run: npx tsx scripts/smoke-schedule-presets.ts
 */
process.env.TZ = "America/New_York";

import { atLocal, formatScheduled, schedulePresets, timeOptions } from "../src/lib/email/schedule-presets";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const wed = new Date(2026, 8, 30, 15, 0); // Wed Sep 30 2026 15:00 local
const p = schedulePresets(wed);
check("tomorrow 8:00", p.tomorrowMorning.getDate() === 1 && p.tomorrowMorning.getHours() === 8 && p.tomorrowMorning.getMinutes() === 0);
check("Monday 8:00 is Oct 5", p.mondayMorning.getMonth() === 9 && p.mondayMorning.getDate() === 5 && p.mondayMorning.getDay() === 1 && p.mondayMorning.getHours() === 8);
const mon = new Date(2026, 9, 5, 7, 0);
check("on a Monday, Monday means next week", schedulePresets(mon).mondayMorning.getDate() === 12);
const sun = new Date(2026, 9, 4, 20, 0);
check("on a Sunday, Monday is tomorrow", schedulePresets(sun).mondayMorning.getDate() === 5);
check("atLocal is wall-clock local", atLocal("2026-11-01", "09:30").getHours() === 9 && atLocal("2026-11-01", "09:30").getMinutes() === 30);
check("DST day still lands at the wall time", atLocal("2026-11-01", "08:00").getHours() === 8);
check("time options every 30 min", timeOptions()[0] === "06:00" && timeOptions().includes("22:30") && timeOptions().length === 34);
check("label says around … tomorrow", /^around 8:00\s?AM tomorrow$/.test(formatScheduled(p.tomorrowMorning, wed)), formatScheduled(p.tomorrowMorning, wed));
check("a later day is named", /Mon, Oct 5$/.test(formatScheduled(p.mondayMorning, wed)), formatScheduled(p.mondayMorning, wed));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll schedule preset checks passed.");
