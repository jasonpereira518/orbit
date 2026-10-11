/**
 * Every follow-up quick choice reads the shared preset list. Fails if a surface grows its own
 * day list again, or if one of them stops importing the shared module.
 * Pure: reads source files.
 * Run: npx tsx scripts/smoke-follow-up-preset-surfaces.ts
 */
import { readFileSync } from "node:fs";

const SURFACES = [
  "src/components/contacts/contact-follow-up-section.tsx",
  "src/components/follow-up/easy-follow-up.tsx",
  "src/components/radar/recommendation-card.tsx",
  "src/components/radar/morning-briefing.tsx",
  "src/components/notifications/notifications-panel.tsx",
];
let failures = 0;
for (const file of SURFACES) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("@/lib/follow-up-presets")) { failures++; console.error(`  FAIL ${file} does not import the shared presets`); }
  if (/\{\s*days:\s*\d+,\s*label:/.test(src)) { failures++; console.error(`  FAIL ${file} defines its own day presets`); }
  if (/schedule\((3|7|14)\)/.test(src)) { failures++; console.error(`  FAIL ${file} hard-codes a schedule day count`); }
  if (/snoozeReminderAction\([^,]+,\s*7\)/.test(src)) { failures++; console.error(`  FAIL ${file} hard-codes a 7-day snooze`); }
}
for (const gone of ["SCHEDULE_DAYS", "REMIND_PRESETS"]) {
  for (const file of [...SURFACES, "src/lib/radar/actions-core.ts", "src/actions/radar.ts"]) {
    if (readFileSync(file, "utf8").includes(gone)) { failures++; console.error(`  FAIL ${file} still names ${gone}`); }
  }
}
if (failures) { console.error(`\n${failures} preset surface check(s) failed`); process.exit(1); }
console.log("all preset surface checks passed");
process.exit(0);
