/**
 * The write rules, case by case. `now` is fixed at 2026-09-30 12:00Z.
 *
 * Run: npx tsx scripts/smoke-relationship-rules.ts
 */
import "./smoke/_env";
import { openThreadKey, planDigestWrites, type RulesContext } from "../src/lib/relationship-engine/rules";
import type { ValidatedDigest, ValidatedDated, ValidatedUndated } from "../src/lib/relationship-engine/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-30T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const IID = "00000000-0000-4000-8000-000000000001";

function base(over: Partial<ValidatedDigest> = {}): ValidatedDigest {
  return { whatTheyDo: null, workingOn: null, summary: "s", topics: [], facts: [], dated: [], undated: [], closedKeys: [], jobChange: null, ...over };
}
function dated(dueIso: string, msgIso: string, over: Partial<ValidatedDated> = {}): ValidatedDated {
  return { text: "Send the deck", owedBy: "me", dueDate: day(dueIso), rawDatePhrase: "Friday", dateBasis: "relative", actionKind: "email", confidence: 90, excerpt: "send the deck Friday", messageAt: day(msgIso), interactionId: IID, ...over };
}
function undated(msgIso: string, over: Partial<ValidatedUndated> = {}): ValidatedUndated {
  return { text: "Intro to Priya", owedBy: "them", origin: "implied", confidence: 70, excerpt: "I know Priya", messageAt: day(msgIso), interactionId: IID, withinDays: null, ...over };
}
const ctx = (over: Partial<RulesContext> = {}): RulesContext => ({
  contactId: "c1", contactFirstName: "Maya", now: NOW, closeness: 3, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25, ...over,
});

// 1. Future stated date → action item + reminder on that date.
let p = planDigestWrites(base({ dated: [dated("2026-10-09", "2026-09-28")] }), ctx());
check("future dated → 1 action item", p.actionItems.length === 1);
check("future dated → reminder on the date", p.actionItems[0].reminder?.dueDate.toISOString().slice(0, 10) === "2026-10-09");
check("future dated → explicit origin", p.actionItems[0].reminder?.origin === "explicit");

// 2. Future stated date owed by them → check-in the day after.
p = planDigestWrites(base({ dated: [dated("2026-10-09", "2026-09-28", { owedBy: "them", text: "Send me the intro" })] }), ctx());
check("them dated → due the day after", p.actionItems[0].reminder?.dueDate.toISOString().slice(0, 10) === "2026-10-10");
check("them dated → check-in title", p.actionItems[0].reminder?.title === "Check in with Maya: Send me the intro");

// 3. Date passed 5 days ago, confidence 90 → flag only.
p = planDigestWrites(base({ dated: [dated("2026-09-25", "2026-09-20")] }), ctx());
check("just passed, confident → flag", p.flags.length === 1 && p.actionItems.length === 0);
// 4. Same but confidence 70 → open thread, no flag.
p = planDigestWrites(base({ dated: [dated("2026-09-25", "2026-09-20", { confidence: 70 })] }), ctx());
check("just passed, unsure → open thread", p.flags.length === 0 && p.openThreads.length === 1);
// 5. Passed 20 days ago → open thread.
p = planDigestWrites(base({ dated: [dated("2026-09-10", "2026-09-01")] }), ctx());
check("passed > 14 days → open thread", p.openThreads.length === 1 && p.flags.length === 0);

// 6. Undated, recent (10 days) → action item + window reminder (closeness 3 → 60 days from message, ≥ tomorrow).
p = planDigestWrites(base({ undated: [undated("2026-09-20")] }), ctx());
check("recent undated → action item", p.actionItems.length === 1 && p.actionItems[0].owedBy === "them");
check("recent undated → window due date", p.actionItems[0].reminder?.dueDate.toISOString().slice(0, 10) === "2026-11-19", p.actionItems[0].reminder?.dueDate.toISOString());
// 7. within_days 7 from a message 10 days ago → would be in the past → tomorrow.
p = planDigestWrites(base({ undated: [undated("2026-09-20", { withinDays: 7 })] }), ctx());
check("past window clamps to tomorrow", p.actionItems[0].reminder?.dueDate.toISOString().slice(0, 10) === "2026-10-01");
// 8. Undated, 46 days old → open thread.
p = planDigestWrites(base({ undated: [undated("2026-08-15")] }), ctx());
check("old undated → open thread", p.openThreads.length === 1 && p.actionItems.length === 0 && p.newOpenThreads === 1);
// 9. Exactly 45 days old → still recent.
p = planDigestWrites(base({ undated: [undated("2026-08-16")] }), ctx());
check("45 days → recent", p.actionItems.length === 1);

// 10. Per-contact cap: 5 recent items → 3 reminders, 2 overflow to open threads.
const five = [1, 2, 3, 4, 5].map((n) => undated("2026-09-25", { text: `Item ${n}`, excerpt: `item ${n}` }));
p = planDigestWrites(base({ undated: five }), ctx());
check("contact cap: 3 action items", p.actionItems.length === 3, String(p.actionItems.length));
check("contact cap: 2 overflow threads", p.openThreads.length === 2);
// 11. Run cap: 1 left → 1 reminder.
p = planDigestWrites(base({ undated: five }), ctx({ remindersLeftInRun: 1 }));
check("run cap honoured", p.actionItems.length === 1 && p.remindersPlanned === 1);

// 12. Closed keys remove threads and close action items.
const existing = [{ key: "t1", text: "Send deck", owedBy: "me" as const, sinceIso: "2025-01-01", interactionId: IID, excerpt: "deck" }];
p = planDigestWrites(base({ closedKeys: ["t1", "ai:11111111-1111-4111-8111-111111111111"] }), ctx({ existingThreads: existing }));
check("closed thread removed", p.openThreads.length === 0);
check("closed action item id extracted", p.closeActionItemIds[0] === "11111111-1111-4111-8111-111111111111");

// 13. Thread keys are stable and deduped against existing threads.
const k = openThreadKey(IID, "Intro to Priya");
check("thread key stable", k === openThreadKey(IID, "  intro to priya "));
p = planDigestWrites(base({ undated: [undated("2026-08-01")] }), ctx({ existingThreads: [{ ...existing[0], key: k }] }));
check("existing thread not duplicated", p.openThreads.length === 1 && p.newOpenThreads === 0);

// 14. Facts pass straight through, deduped.
p = planDigestWrites(base({ facts: ["Has two kids", "has two kids "] }), ctx());
check("facts deduped", p.facts.length === 1);

console.log("\nsmoke-relationship-rules: all checks passed");
process.exit(0);
