/**
 * The numbers the LinkedIn import card shows before anyone opts in to timeline events, and
 * the rule that keeps one-message threads away from the model (audit A6).
 * Run: npx tsx scripts/smoke-timeline-cost.ts
 */
import {
  TIMELINE_DAILY_CONTACT_CAP,
  estimateTimelineCostMicros,
  qualifiesForTimelineAi,
  timelineEstimateLabel,
  usableTimelineMessageCount,
  utcDayKey,
} from "../src/lib/timeline-cost";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

check("blank and missing messages do not count", usableTimelineMessageCount(["hi", "  ", "", null, undefined, "yo"]) === 2);
check("one message does not reach the model", !qualifiesForTimelineAi(1));
check("two messages do", qualifiesForTimelineAi(2));
check("the daily cap is 300 conversations", TIMELINE_DAILY_CONTACT_CAP === 300);

// 2,500 in + 150 out per conversation. flash-lite ($0.25/$1.50): 625 + 225 = 850 micro-dollars each.
check("10,000 conversations on Gemini flash-lite is $8.50", estimateTimelineCostMicros(10_000, "gemini-3.1-flash-lite") === 8_500_000, String(estimateTimelineCostMicros(10_000, "gemini-3.1-flash-lite")));
// gpt-4o-mini: 375 + 90 = 465 each.
check("10,000 on gpt-4o-mini is $4.65", estimateTimelineCostMicros(10_000, "gpt-4o-mini") === 4_650_000);
check("an unpriced model estimates nothing rather than guessing", estimateTimelineCostMicros(5, "mystery-model") === null);
check("no conversations cost nothing", estimateTimelineCostMicros(0, "gpt-4o-mini") === 0);

check("the label for a big export", timelineEstimateLabel(10_000, "gemini-3.1-flash-lite") === "Derive timeline events for 10,000 conversations — about $8.50 on your key", timelineEstimateLabel(10_000, "gemini-3.1-flash-lite"));
check("the label for a tiny one", timelineEstimateLabel(1, "gemini-3.1-flash-lite") === "Derive timeline events for 1 conversation — under a cent on your key");
check("the label for an unpriced model", timelineEstimateLabel(3, "mystery-model") === "Derive timeline events for 3 conversations — cost depends on your model");
check("the label with nothing waiting", timelineEstimateLabel(0, "gpt-4o-mini") === "Derive timeline events from your LinkedIn conversations");

check("the UTC day key ignores local time", utcDayKey(new Date("2026-09-15T23:59:59.000Z")) === "2026-09-15");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll timeline cost checks passed.");
process.exit(0);
