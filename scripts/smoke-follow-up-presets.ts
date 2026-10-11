/**
 * Pins `src/lib/follow-up-presets.ts`: every preset on every weekday, around 9 am, across the
 * America/New_York DST changes, and the server-side date validation.
 * Pure: pinned instants, no database.
 * Run: npx tsx scripts/smoke-follow-up-presets.ts
 */
import {
  FOLLOW_UP_PRESETS,
  resolvePreset,
  validateFollowUpDate,
  type FollowUpPresetId,
} from "../src/lib/follow-up-presets";

let failures = 0;
function eq<T>(label: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

const NY = "America/New_York";
/** Local wall time in `tz`, as "YYYY-MM-DD HH:mm". */
function wall(d: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const at = (id: FollowUpPresetId, iso: string, tz = NY) => wall(resolvePreset(id, new Date(iso), tz), tz);

console.log("order and labels");
eq("ids", FOLLOW_UP_PRESETS.map((p) => p.id), ["1d", "2d", "next-business-day", "next-business-week", "2w"]);
eq("labels", FOLLOW_UP_PRESETS.map((p) => p.label), ["1 day", "2 days", "Next business day", "Next week", "2 weeks"]);
eq("short", FOLLOW_UP_PRESETS.map((p) => p.short), ["1d", "2d", "Next day", "Next wk", "2w"]);

// Week of Mon 2026-10-12 … Sun 2026-10-18 (EDT, UTC-4). 15:30 local = 19:30Z.
const WEEK: [string, string][] = [
  ["Mon", "2026-10-12T19:30:00Z"], ["Tue", "2026-10-13T19:30:00Z"], ["Wed", "2026-10-14T19:30:00Z"],
  ["Thu", "2026-10-15T19:30:00Z"], ["Fri", "2026-10-16T19:30:00Z"], ["Sat", "2026-10-17T19:30:00Z"],
  ["Sun", "2026-10-18T19:30:00Z"],
];
const NEXT_BIZ = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-19", "2026-10-19"];
const NEXT_WEEK = ["2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19"];

console.log("every weekday");
WEEK.forEach(([day, iso], i) => {
  eq(`${day} 1d keeps the time`, at("1d", iso).slice(11), "15:30");
  eq(`${day} next business day`, at("next-business-day", iso), `${NEXT_BIZ[i]} 09:00`);
  eq(`${day} next week`, at("next-business-week", iso), `${NEXT_WEEK[i]} 09:00`);
});
eq("Mon next week is 7 days later", at("next-business-week", "2026-10-12T13:00:00Z"), "2026-10-19 09:00");
eq("Sun next week is tomorrow", at("next-business-week", "2026-10-18T13:00:00Z"), "2026-10-19 09:00");

console.log("around 9 am");
eq("Tue 08:59 next business day is Wed", at("next-business-day", "2026-10-13T12:59:00Z"), "2026-10-14 09:00");
eq("Tue 09:01 next business day is Wed", at("next-business-day", "2026-10-13T13:01:00Z"), "2026-10-14 09:00");
eq("Fri 23:59 local is still Friday", at("next-business-day", "2026-10-17T03:59:00Z"), "2026-10-19 09:00");

console.log("calendar-day presets");
eq("2d", at("2d", "2026-10-13T19:30:00Z"), "2026-10-15 15:30");
eq("2w", at("2w", "2026-10-13T19:30:00Z"), "2026-10-27 15:30");

console.log("DST, America/New_York");
// Fall back Sun 2026-11-01 02:00 EDT -> 01:00 EST.
eq("1d across fall-back keeps wall time", at("1d", "2026-10-31T19:30:00Z"), "2026-11-01 15:30");
eq("2w across fall-back keeps wall time", at("2w", "2026-10-25T19:30:00Z"), "2026-11-08 15:30");
eq("next week across fall-back is 09:00 EST", at("next-business-week", "2026-10-30T19:30:00Z"), "2026-11-02 09:00");
eq("next week 09:00 EST is 14:00Z", resolvePreset("next-business-week", new Date("2026-10-30T19:30:00Z"), NY).toISOString(), "2026-11-02T14:00:00.000Z");
// Spring forward Sun 2027-03-14 02:00 EST -> 03:00 EDT.
eq("1d across spring-forward keeps wall time", at("1d", "2027-03-13T20:30:00Z"), "2027-03-14 15:30");
eq("next business day after spring-forward is 13:00Z", resolvePreset("next-business-day", new Date("2027-03-12T20:30:00Z"), NY).toISOString(), "2027-03-15T13:00:00.000Z");

console.log("other zones");
eq("UTC next business day", at("next-business-day", "2026-10-16T10:00:00Z", "UTC"), "2026-10-19 09:00");
eq("Tokyo Saturday morning is Monday", at("next-business-day", "2026-10-16T23:00:00Z", "Asia/Tokyo"), "2026-10-19 09:00");

console.log("validateFollowUpDate");
const NOW = new Date("2026-10-13T19:30:00Z");
eq("future accepted", validateFollowUpDate("2026-10-14T13:00:00.000Z", NOW).ok, true);
eq("now refused", validateFollowUpDate(NOW.toISOString(), NOW).ok, false);
eq("past refused", validateFollowUpDate("2026-10-12T13:00:00.000Z", NOW).ok, false);
eq("366 days accepted", validateFollowUpDate(new Date(NOW.getTime() + 366 * 86_400_000).toISOString(), NOW).ok, true);
eq("367 days refused", validateFollowUpDate(new Date(NOW.getTime() + 367 * 86_400_000).toISOString(), NOW).ok, false);
eq("garbage refused", validateFollowUpDate("tomorrow", NOW).ok, false);
eq("number refused", validateFollowUpDate(7, NOW).ok, false);
const bad = validateFollowUpDate("2026-10-12T13:00:00.000Z", NOW);
eq("refusal copy", bad.ok ? "" : bad.message, "Pick a time in the future");

if (failures) {
  console.error(`\n${failures} follow-up preset check(s) failed`);
  process.exit(1);
}
console.log("\nall follow-up preset checks passed");
process.exit(0);
