/**
 * A same-day interaction is never stored in the future, and a later-today "last touch"
 * reads "today". The audit saw "Last touch in about 9 hours" for a note logged at 3 a.m.
 * Pure. Run: npx tsx scripts/smoke-last-touch.ts
 */
import { clampSameDayToNow } from "../src/lib/interaction-date";
import { formatLastTouch } from "../src/lib/relative-date";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0, 0);
const THREE_AM = at(15, 3);

console.log("clampSameDayToNow…");
check("today's noon, logged at 3am, is stored as now", clampSameDayToNow("2026-09-15", at(15, 12), THREE_AM).getTime() === THREE_AM.getTime());
check("today's noon, logged at 3pm, stays noon", clampSameDayToNow("2026-09-15", at(15, 12), at(15, 15)).getTime() === at(15, 12).getTime());
check("yesterday keeps its noon", clampSameDayToNow("2026-09-14", at(14, 12), THREE_AM).getTime() === at(14, 12).getTime());
check("a later day chosen on purpose keeps its noon", clampSameDayToNow("2026-09-16", at(16, 12), THREE_AM).getTime() === at(16, 12).getTime());

console.log("\nformatLastTouch…");
check("later today reads today", formatLastTouch(at(15, 12), THREE_AM) === "today", formatLastTouch(at(15, 12), THREE_AM));
check("earlier today keeps its distance", formatLastTouch(at(15, 1), THREE_AM) === "about 2 hours ago", formatLastTouch(at(15, 1), THREE_AM));
check("days ago", formatLastTouch(at(10, 12), THREE_AM) === "5 days ago", formatLastTouch(at(10, 12), THREE_AM));
check("another day ahead is not hidden", formatLastTouch(at(17, 12), THREE_AM) === "in 2 days", formatLastTouch(at(17, 12), THREE_AM));

if (failures) {
  console.error(`\nsmoke-last-touch: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-last-touch: ok");
process.exit(0);
