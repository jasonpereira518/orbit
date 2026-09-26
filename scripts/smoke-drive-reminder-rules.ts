/**
 * The stricter reminder rules for Drive imports. A doc can be years old, so capture's own
 * defaults would turn every stale "send the deck by March 3" into an overdue reminder.
 *
 * Run: npx tsx scripts/smoke-drive-reminder-rules.ts
 */
import {
  applyDriveReminderRules,
  followUpStillAhead,
} from "../src/lib/imports/drive-reminder-rules";
import type { SuggestedReminderPreview } from "../src/lib/capture/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-21T12:00:00Z");

function s(key: string, over: Partial<SuggestedReminderPreview>): SuggestedReminderPreview {
  return {
    key,
    title: `Do ${key}`,
    description: null,
    rawDatePhrase: "on October 3",
    dueDateIso: "2026-10-03",
    yearInferred: false,
    personName: "Priya Raman",
    actionKind: "task",
    confidenceScore: 90,
    sourceExcerpt: "send the deck on October 3",
    dateBasis: "absolute",
    anchorIso: "2026-09-01",
    origin: "explicit",
    rationale: null,
    ...over,
  };
}

const r = applyDriveReminderRules(
  [
    s("future", {}),
    s("past-unimportant", { dueDateIso: "2026-09-10", confidenceScore: 70 }),
    s("past-important", { dueDateIso: "2026-09-10", confidenceScore: 92 }),
    s("past-too-old", { dueDateIso: "2026-06-01", confidenceScore: 95 }),
    s("past-relative", { dueDateIso: "2026-09-10", confidenceScore: 95, dateBasis: "relative" }),
    s("implied", { origin: "implied", rawDatePhrase: null }),
    s("vague", { dateBasis: "vague" }),
    s("no-phrase", { rawDatePhrase: null }),
    s("year-guessed", { yearInferred: true }),
  ],
  NOW,
);
check("a future explicit date is kept", r.keep.includes("future"));
check("a past, ordinary one is dropped", !r.keep.includes("past-unimportant") && !r.flags.some((f) => f.key === "past-unimportant"));
check("a past, important one is flagged, not kept", !r.keep.includes("past-important") && r.flags.some((f) => f.key === "past-important"));
check("a past one outside 30 days is not flagged", !r.flags.some((f) => f.key === "past-too-old"));
check("a past relative date is not flagged", !r.flags.some((f) => f.key === "past-relative"));
for (const k of ["implied", "vague", "no-phrase", "year-guessed"]) {
  check(`${k} is dropped`, !r.keep.includes(k) && !r.flags.some((f) => f.key === k));
}
check("only one kept overall", r.keep.length === 1, JSON.stringify(r.keep));

// Cap: at most three, highest confidence first.
const capped = applyDriveReminderRules(
  [
    s("a", { confidenceScore: 70 }),
    s("b", { confidenceScore: 95 }),
    s("c", { confidenceScore: 80 }),
    s("d", { confidenceScore: 90 }),
  ],
  NOW,
);
check("capped at three", capped.keep.length === 3);
check("lowest confidence is the one dropped", !capped.keep.includes("a"), JSON.stringify(capped.keep));

// Today counts as not past.
check("due today is kept", applyDriveReminderRules([s("today", { dueDateIso: "2026-09-21" })], NOW).keep.includes("today"));

// Follow-ups.
check("follow-up still ahead", followUpStillAhead("2026-09-15", 14, NOW));
check("follow-up already passed", !followUpStillAhead("2025-01-10", 14, NOW));

if (failures) {
  console.error(`smoke-drive-reminder-rules: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-drive-reminder-rules: all checks passed");
process.exit(0);
