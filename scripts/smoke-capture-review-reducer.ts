/**
 * The pure derivations the review UI and the runner share. No DB, no React.
 * Run: npx tsx scripts/smoke-capture-review-reducer.ts
 */
import {
  acceptedPeople,
  countDecisions,
  defaultMergeId,
  defaultReminderKeys,
  firstPendingIndex,
  initialPhaseFor,
  parseTagNames,
  setAsidePeople,
} from "../src/lib/capture/review-reducer";
import type { BulkNotePersonPreview, CaptureDecisions } from "../src/lib/capture/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const item = (key: string, over: Partial<BulkNotePersonPreview> = {}): BulkNotePersonPreview => ({
  key, notes: "", parsed: {} as BulkNotePersonPreview["parsed"], duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: null, interactionType: null, ...over,
});
const items = [item("a"), item("b"), item("c")];
const dec = (decision: "accept" | "reject" | "skip", index: number) => ({ decision, index, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt: "" });

check("no decisions → first card", firstPendingIndex(items, {}) === 0);
check("null decisions → first card", firstPendingIndex(items, null) === 0);
check("resumes at the first undecided card", firstPendingIndex(items, { people: { a: dec("accept", 0) } }) === 1);
check("skips over decided cards in the middle", firstPendingIndex(items, { people: { a: dec("accept", 0), b: dec("skip", 1) } }) === 2);
check("-1 when everything is decided", firstPendingIndex(items, { people: { a: dec("accept", 0), b: dec("skip", 1), c: dec("reject", 2) } }) === -1);

const mixed: CaptureDecisions = { people: { a: dec("accept", 0), b: dec("skip", 1) } };
check("counts", JSON.stringify(countDecisions(items, mixed)) === JSON.stringify({ accepted: 1, rejected: 0, skipped: 1, pending: 1 }));
check("accepted people keep card order", acceptedPeople(items, mixed).map((a) => a.item.key).join() === "a");
check("set-aside people", setAsidePeople(items, mixed).map((s) => s.item.key).join() === "b");
check("set-aside filtered by kind", setAsidePeople(items, mixed, "reject").length === 0);

const dup = (id: string, confidence: number) => ({ id, fullName: id, company: null, title: null, reason: "name", confidence });
check("no matches → create new", defaultMergeId(item("x")) === null);
check("the server's confident suggestion wins", defaultMergeId(item("x", { duplicates: [dup("weak", 0.6), dup("strong", 0.9)], suggestedMergeId: "strong" })) === "strong");
check("any match beats creating a duplicate", defaultMergeId(item("x", { duplicates: [dup("weak", 0.6)] })) === "weak");
check("the profile you came from beats both", defaultMergeId(item("x", { duplicates: [dup("weak", 0.6), dup("pref", 0.6)], suggestedMergeId: "weak" }), "pref") === "pref");
check("…but only when it is actually a candidate", defaultMergeId(item("x", { duplicates: [dup("weak", 0.6)] }), "pref") === "weak");

const result = { items, sharedNotes: [], interactionDate: null, interactionType: "meeting_note", anchorIso: "2026-09-01", anchorBasis: "note" as const, hints: {}, suggestedReminders: [], suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 }, mentions: [], mentionedOnly: [] };
check("no job → input", initialPhaseFor(null) === "input");
check("queued → extracting", initialPhaseFor({ status: "queued", result: null, decisions: null }) === "extracting");
check("extracting → extracting", initialPhaseFor({ status: "extracting", result: null, decisions: null }) === "extracting");
check("ready → resume", initialPhaseFor({ status: "ready", result, decisions: {} }) === "resume");
check("ready with zero people → summary", initialPhaseFor({ status: "ready", result: { ...result, items: [] }, decisions: {} }) === "summary");
check("reviewing with a pending card → review", initialPhaseFor({ status: "reviewing", result, decisions: mixed }) === "review");
check("reviewing with nothing pending → summary", initialPhaseFor({ status: "reviewing", result, decisions: { people: { a: dec("accept", 0), b: dec("skip", 1), c: dec("reject", 2) } } }) === "summary");
check("saving → saving", initialPhaseFor({ status: "saving", result, decisions: {} }) === "saving");
check("saved → saved", initialPhaseFor({ status: "saved", result, decisions: {} }) === "saved");
for (const status of ["ingesting", "transcribed", "failed", "discarded"] as const) {
  check(`${status} → input`, initialPhaseFor({ status, result: null, decisions: null }) === "input");
}

check("confident reminders are ticked by default", defaultReminderKeys([{ key: "a", confidenceScore: 60 }, { key: "b", confidenceScore: 59 }]).join() === "a");
check("tags split, trim and dedupe case-insensitively", parseTagNames(" founder, AI ,ai,, ").join("|") === "founder|AI");

console.log("\nsmoke-capture-review-reducer: all checks passed");
