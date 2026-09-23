/**
 * Plan caps and threshold maths for Deepgram minutes. Pure: no DB, no clock beyond what is
 * passed in. Run: npx tsx scripts/smoke-speech-limits.ts
 */
import { SPEECH_LIMITS, limitFor, monthWindow, quotaState } from "../src/lib/speech-limits";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

console.log("\nlimits");
check("free gets no meeting minutes", limitFor("meeting", "free") === 0);
check("Pro gets 5 meeting hours", limitFor("meeting", "orbit") === 18_000);
check("Lifetime gets 10 meeting hours", limitFor("meeting", "lifetime") === 36_000);
check("free short-form is 60 minutes", limitFor("shortform", "free") === 3_600);
check("paid short-form is 300 minutes", limitFor("shortform", "orbit") === 18_000 && limitFor("shortform", "lifetime") === 18_000);
check("every plan is covered", Object.keys(SPEECH_LIMITS.meeting).length === 3);

console.log("\nquotaState");
{
  const fresh = quotaState(0, 18_000);
  check("nothing used is not a warning", fresh.remaining === 18_000 && !fresh.warn && !fresh.exhausted);
  const most = quotaState(16_300, 18_000);
  check("90.5% warns", most.warn && !most.exhausted, `${most.fraction}`);
  check("89% does not warn", !quotaState(16_000, 18_000).warn);
  const done = quotaState(18_000, 18_000);
  check("exactly at the cap is exhausted", done.exhausted && done.remaining === 0);
  check("over the cap never goes negative", quotaState(20_000, 18_000).remaining === 0);
  const none = quotaState(0, 0);
  check("a zero limit is exhausted, not a division by zero", none.exhausted && none.fraction === 1);
}

console.log("\nmonthWindow");
{
  const w = monthWindow(new Date("2026-09-22T18:30:00.000Z"));
  check("starts at the first of the month, UTC", w.start.toISOString() === "2026-09-01T00:00:00.000Z");
  check("resets on the first of the next month", w.resetsAt.toISOString() === "2026-10-01T00:00:00.000Z");
  const dec = monthWindow(new Date("2026-12-31T23:59:59.000Z"));
  check("december rolls into january", dec.resetsAt.toISOString() === "2027-01-01T00:00:00.000Z");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll speech limit checks passed");
process.exit(0);
