/**
 * The pure derivations the review UI and the runner share. No DB, no React.
 * Run: npx tsx scripts/smoke-capture-review-reducer.ts
 */
import {
  acceptedPeople,
  choicesFromOpportunities,
  countDecisions,
  defaultMergeId,
  defaultReminderKeys,
  firstPendingIndex,
  initialPhaseFor,
  opportunityRows,
  parseTagNames,
  setAsidePeople,
} from "../src/lib/capture/review-reducer";
import type {
  BulkNotePersonPreview,
  CaptureDecisions,
  CaptureOpportunityPreview,
} from "../src/lib/capture/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const item = (key: string, over: Partial<BulkNotePersonPreview> = {}): BulkNotePersonPreview => ({
  key, notes: "", parsed: {} as BulkNotePersonPreview["parsed"], duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: null, interactionType: null, opportunities: [], impliedSteps: [], cadence: null, ...over,
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

console.log("\nopportunity ticks and kind corrections");

/**
 * These two live here rather than in the summary component because the RUNNER reads them
 * too. A default that existed in only one of them would show one set on screen and save
 * another, which is the single worst failure this review step can have.
 */
{
  const opp = (label: string, kind: CaptureOpportunityPreview["kind"]): CaptureOpportunityPreview => ({
    kind, label, direction: null, sourceExcerpt: `…${label}…`, rawDatePhrase: null, confidenceScore: 80, dueDateIso: null,
  });
  const named = (name: string) => ({ name } as BulkNotePersonPreview["parsed"]);
  const withOpps = [
    item("a", { parsed: named("Ada"), opportunities: [opp("forward my resume", "referral"), opp("summer internship", "internship")] }),
    item("b", { parsed: named("Bea"), opportunities: [opp("intro to their VP", "introduction")] }),
  ];
  const allAccepted: CaptureDecisions = { people: { a: dec("accept", 0), b: dec("accept", 1) } };
  const accepted = acceptedPeople(withOpps, allAccepted);

  // Absent choices are the defaults. A job whose decisions were written before this section
  // existed must keep everything the parse found, not silently save none of it.
  const fresh = opportunityRows(accepted, undefined);
  check("with no choices yet, everything is ticked", fresh.length === 3 && fresh.every((r) => r.checked));
  check("  keys are <personKey>:<index>", fresh.map((r) => r.key).join() === "a:0,a:1,b:0");
  check("  and each row names whose card produced it", fresh[2].personName === "Bea", fresh[2].personName);
  // A name corrected on the card is the name the row should show — the person edited it
  // because the extraction got it wrong, and showing the original here would contradict
  // the card they just fixed.
  const renamed = opportunityRows(
    acceptedPeople(withOpps, { people: { a: { ...dec("accept", 0), edits: { name: "Ada Lovelace" } }, b: dec("accept", 1) } }),
    undefined
  );
  check("  an edited name wins over the parsed one", renamed[0].personName === "Ada Lovelace", renamed[0].personName);

  const unticked = choicesFromOpportunities(
    fresh.map((r) => (r.key === "a:1" ? { ...r, checked: false } : r)),
    withOpps,
    undefined
  );
  check("unticking one drops just that key", unticked.checked.join() === "a:0,b:0");
  check("  and records no kind override", unticked.kinds === undefined, JSON.stringify(unticked.kinds));

  // The correction the Select exists for: a referral filed as an introduction is a referral
  // nobody will find when they search for one.
  const corrected = choicesFromOpportunities(
    fresh.map((r) => (r.key === "b:0" ? { ...r, kind: "referral" as const } : r)),
    withOpps,
    undefined
  );
  check("a changed kind is recorded", corrected.kinds?.["b:0"] === "referral", JSON.stringify(corrected.kinds));
  check("  and an unchanged one is not", Object.keys(corrected.kinds ?? {}).length === 1);
  check("the correction survives a re-read", opportunityRows(accepted, corrected).find((r) => r.key === "b:0")?.kind === "referral");

  // Setting somebody aside has to take their opportunities off the list — the runner
  // filters by the accepted set, so showing them would offer to save rows that can never
  // be written.
  const bAside: CaptureDecisions = { people: { a: dec("accept", 0), b: dec("reject", 1) } };
  const visible = opportunityRows(acceptedPeople(withOpps, bAside), corrected);
  check("a set-aside person's opportunities leave the list", visible.map((r) => r.key).join() === "a:0,a:1");

  // …but the write that happens while they are off screen must not forget them, or changing
  // your mind brings them back unticked and re-corrected to nothing.
  const whileAside = choicesFromOpportunities(visible, withOpps, corrected);
  check("  their tick is carried through anyway", whileAside.checked.includes("b:0"), JSON.stringify(whileAside.checked));
  check("  as is their corrected kind", whileAside.kinds?.["b:0"] === "referral", JSON.stringify(whileAside.kinds));
  const restored = opportunityRows(accepted, whileAside);
  check("  so re-accepting them restores both", restored.find((r) => r.key === "b:0")?.checked === true && restored.find((r) => r.key === "b:0")?.kind === "referral");
}

console.log("\nsmoke-capture-review-reducer: all checks passed");
