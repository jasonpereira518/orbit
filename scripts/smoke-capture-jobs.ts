/**
 * The durable capture job, end to end against PGlite with the model stubbed out:
 * queue → claim → ready → decisions → save → saved, plus the properties that make it safe
 * to re-run from a re-kick, a second tab or the stall sweep.
 *
 * Run: npx tsx scripts/smoke-capture-jobs.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-jobs";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-jobs";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contactOpportunities, contacts, ignoredPeople, noteBatches, reminders, userSettings } from "../src/db/schema";
import {
  CAPTURE_CLAIM_STALE_MS,
  claimCaptureJob,
  createCaptureJob,
  discardCaptureJobRow,
  findActiveCaptureJob,
  recordCaptureChoicesRow,
  recordCaptureDecisionRow,
  queueCaptureJobRow,
  appendIngestedBlocks,
  markCaptureJobTranscribed,
  captureJobLooksStuck,
} from "../src/lib/capture-jobs";
import { assembleCaptureCorpus, runCaptureJobById } from "../src/lib/capture-job-runner";
import type { CaptureParseResult } from "../src/lib/capture/types";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-capture-jobs-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function person(name: string, over: Partial<CaptureParseResult["items"][number]["parsed"]> = {}) {
  return {
    name, company: "Acme", role: "Engineer", presence: "participant" as const, location: null, email: null, linkedin_url: null,
    met_at: "Demo day", topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null,
    relationship_score_suggestion: 3, relevance: null, tags: [], summary: `Met ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01", low_confidence_fields: [],
    ...over,
  };
}

function fakeParse(corpus: string): CaptureParseResult {
  return {
    items: [
      {
        key: "0-Ada Lovelace", notes: "Met Ada", parsed: person("Ada Lovelace"), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [],
        interactionDate: "2026-09-01", interactionType: "meeting_note", impliedSteps: [], cadence: null,
        opportunities: [
          // Filed as an introduction by the extraction. It is a referral, and the review's
          // Select is the only place that can say so.
          { kind: "introduction", label: "forward my resume to the infra team", direction: "they_offer", sourceExcerpt: "She offered to forward my resume to the infra team.", rawDatePhrase: null, confidenceScore: 85, dueDateIso: null },
          { kind: "speaker", label: "a slot at their internal talk series", direction: "they_offer", sourceExcerpt: "Mentioned a slot at their internal talk series.", rawDatePhrase: null, confidenceScore: 70, dueDateIso: null },
        ],
      },
      { key: "1-Grace Hopper", notes: "Met Grace", parsed: person("Grace Hopper", { relationship_score_suggestion: 5 }), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-01", interactionType: "meeting_note", opportunities: [], impliedSteps: [], cadence: null },
      { key: "2-Alan Turing", notes: "Met Alan", parsed: person("Alan Turing"), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-01", interactionType: "meeting_note", opportunities: [], impliedSteps: [], cadence: null },
    ],
    sharedNotes: [],
    interactionDate: "2026-09-01",
    interactionType: "meeting_note",
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    hints: {},
    sourceText: corpus,
    sourceHash: hashSourceNote(corpus),
    suggestedReminders: [],
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [{ text: "Charles Babbage", context: "her collaborator", nearPerson: "Ada Lovelace", contactId: null, confidence: 0, matchedBy: null }],
    mentionedOnly: [{ name: "Mary Somerville", context: "her tutor", company: null }],
  };
}

let parseCalls = 0;
const deps = {
  parse: async (_userId: string, corpus: string) => {
    parseCalls += 1;
    return fakeParse(corpus);
  },
  enrich: false,
};

async function reset() {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("Extraction…");
  const job = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "Met Ada, Grace and Alan at demo day." });
  check("a queued job is the active one", (await findActiveCaptureJob(USER))?.id === job.id);

  const [a, b] = await Promise.all([runCaptureJobById(job.id, deps), runCaptureJobById(job.id, deps)]);
  check("two concurrent runners parse once", parseCalls === 1, `parseCalls=${parseCalls}`);
  check("the loser returns without touching the row", [a?.status, b?.status].includes("extracting") || [a?.status, b?.status].every((s) => s === "ready"), `${a?.status}/${b?.status}`);
  const ready = (await findActiveCaptureJob(USER))!;
  check("and the row ends up ready", ready.status === "ready", ready.status);
  check("the corpus and its hash are stored server-side", ready.sourceText === "Met Ada, Grace and Alan at demo day." && ready.sourceHash === hashSourceNote(ready.sourceText!));
  check("three people extracted", ready.result?.items.length === 3);
  check("a ready job is not stuck", !captureJobLooksStuck(ready));

  console.log("\nClaims…");
  check("a ready job cannot be claimed for extraction", (await claimCaptureJob(job.id, "extracting")) === null);
  await db.update(captureJobs).set({ status: "extracting", updatedAt: new Date(Date.now() - CAPTURE_CLAIM_STALE_MS - 1000) }).where(eq(captureJobs.id, job.id));
  check("a stale extracting claim looks stuck", captureJobLooksStuck((await findActiveCaptureJob(USER))!));
  const reclaimed = await claimCaptureJob(job.id, "extracting");
  check("a stale extracting claim can be taken over", reclaimed !== null);
  check("a fresh extracting claim cannot", (await claimCaptureJob(job.id, "extracting")) === null);
  await runCaptureJobById(job.id, deps).catch(() => null);
  await db.update(captureJobs).set({ status: "queued", claimToken: null }).where(eq(captureJobs.id, job.id));
  await runCaptureJobById(job.id, deps);
  check("re-running from queued lands ready again", (await findActiveCaptureJob(USER))?.status === "ready");

  console.log("\nDecisions…");
  const other = "someone-else";
  check("another user cannot decide this job", (await recordCaptureDecisionRow(other, job.id, "0-Ada Lovelace", { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 4, tagNames: ["founder"], decidedAt: new Date().toISOString() })) === null);
  const d1 = await recordCaptureDecisionRow(USER, job.id, "0-Ada Lovelace", { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 4, tagNames: ["founder"], edits: { company: "Analytical Engines" }, decidedAt: new Date().toISOString() });
  check("the first decision moves the job to reviewing", d1?.status === "reviewing");
  const d2 = await recordCaptureDecisionRow(USER, job.id, "1-Grace Hopper", { decision: "skip", index: 1, mergeContactId: null, relationshipScore: 5, tagNames: [], decidedAt: new Date().toISOString() });
  check("decisions merge, they do not replace", Object.keys(d2?.decisions.people ?? {}).length === 2, JSON.stringify(d2?.decisions));
  const back = await recordCaptureDecisionRow(USER, job.id, "1-Grace Hopper", null);
  check("Back removes one key and keeps the rest", Object.keys(back?.decisions.people ?? {}).join() === "0-Ada Lovelace");
  await recordCaptureDecisionRow(USER, job.id, "1-Grace Hopper", { decision: "reject", index: 1, mergeContactId: null, relationshipScore: 5, tagNames: [], decidedAt: new Date().toISOString() });
  await recordCaptureDecisionRow(USER, job.id, "2-Alan Turing", { decision: "accept", index: 2, mergeContactId: null, relationshipScore: 2, tagNames: [], decidedAt: new Date().toISOString() });

  console.log("\nOpportunity ticks…");
  // One untick and one kind correction, written the way the summary writes them. Both have
  // to survive into `contact_opportunities` or the controls were decorative — and the kind
  // in particular is what a later search for "referral" matches on.
  const withChoices = await recordCaptureChoicesRow(USER, job.id, {
    opportunities: { checked: ["0-Ada Lovelace:0"], kinds: { "0-Ada Lovelace:0": "referral" } },
  });
  check("choices land in their own section", withChoices?.decisions.opportunities?.checked.join() === "0-Ada Lovelace:0", JSON.stringify(withChoices?.decisions.opportunities));
  check("  without disturbing the people section", Object.keys(withChoices?.decisions.people ?? {}).length === 3, JSON.stringify(Object.keys(withChoices?.decisions.people ?? {})));

  console.log("\nSaving…");
  // The action moves the row to `saving` before kicking; mirror that here.
  await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, job.id));
  const savedRow = await runCaptureJobById(job.id, deps);
  check("the save lands", savedRow?.status === "saved" && Boolean(savedRow?.noteBatchId), `${savedRow?.status} ${savedRow?.error}`);
  const people = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  check("only the accepted people became contacts", people.map((p) => p.fullName).sort().join() === "Ada Lovelace,Alan Turing", people.map((p) => p.fullName).join());
  const ada = people.find((p) => p.fullName === "Ada Lovelace")!;
  check("the card's edits reach the contact", ada.company === "Analytical Engines", ada.company ?? "null");
  check("closeness comes from the card, not the model", ada.statedCloseness === 4 && ada.relationshipScore === 4);
  const alan = people.find((p) => p.fullName === "Alan Turing")!;
  check("a 'met once' person with no goals gets no automatic follow-up", alan.nextFollowUpAt == null);
  check("a 'strong' person does", ada.nextFollowUpAt != null);
  const adaDays = Math.round((new Date(ada.nextFollowUpAt!).getTime() - new Date("2026-09-01T12:00:00").getTime()) / 86_400_000);
  check("…on the closeness cadence (4 → 30 days)", adaDays === 30, `${adaDays}`);
  check("the saved summary maps cards to contacts", savedRow?.result?.saved?.contactIdByKey["0-Ada Lovelace"] === ada.id, JSON.stringify(savedRow?.result?.saved));

  const opps = await db.query.contactOpportunities.findMany({ where: eq(contactOpportunities.userId, USER) });
  check("only the ticked opportunity is written", opps.length === 1, JSON.stringify(opps.map((o) => o.label)));
  check("  with the kind the review corrected it to", opps[0]?.kind === "referral", opps[0]?.kind);
  check("  on the person whose card produced it", opps[0]?.contactId === ada.id);
  check("  keeping the note's own words", opps[0]?.label === "forward my resume to the infra team", opps[0]?.label);

  const ignored = await db.query.ignoredPeople.findMany({ where: eq(ignoredPeople.userId, USER) });
  const byName = Object.fromEntries(ignored.map((r) => [r.displayName, r.reason]));
  check("the rejected card is on the ignored list", byName["Grace Hopper"] === "rejected", JSON.stringify(byName));
  check("the mentioned-only person is too", byName["Mary Somerville"] === "mentioned");
  check("and the unresolved mention", byName["Charles Babbage"] === "mentioned");
  check("accepted people never are", !("Ada Lovelace" in byName));

  console.log("\nIdempotent save…");
  const batchesBefore = await db.query.noteBatches.findMany({ where: eq(noteBatches.userId, USER) });
  // Pretend the first attempt crashed after the batch insert but before the stamp.
  await db.update(captureJobs).set({ status: "saving", noteBatchId: null, claimToken: null, updatedAt: new Date(Date.now() - CAPTURE_CLAIM_STALE_MS - 1000) }).where(eq(captureJobs.id, job.id));
  const again = await runCaptureJobById(job.id, deps);
  const batchesAfter = await db.query.noteBatches.findMany({ where: eq(noteBatches.userId, USER) });
  check("a resumed save adopts the existing batch", again?.status === "saved" && again.noteBatchId === batchesBefore[0]!.id, `${again?.status} ${again?.noteBatchId}`);
  check("and writes no second batch", batchesAfter.length === batchesBefore.length && batchesAfter.length === 1);
  check("and no second contact", (await db.query.contacts.findMany({ where: eq(contacts.userId, USER) })).length === 2);
  check("a saved job is no longer active", (await findActiveCaptureJob(USER)) === null);

  console.log("\nMedia jobs…");
  const media = await createCaptureJob(USER, { sourceKind: "voice", status: "ingesting" });
  await appendIngestedBlocks(media.id, [{ text: "First block.", source: "audio:a.wav" }], { sources: ["audio:a.wav"], transcriptionEngine: "whisper" });
  await appendIngestedBlocks(media.id, [{ text: "Second block.", source: "photos:1/1" }], { sources: ["photos:1/1"] });
  await markCaptureJobTranscribed(media.id);
  const transcribed = (await findActiveCaptureJob(USER))!;
  check("blocks append in order", transcribed.ingestedBlocks.map((b) => b.text).join(" ") === "First block. Second block.");
  check("a transcribed job is the active one, waiting on Extract", transcribed.status === "transcribed" && transcribed.id === media.id);
  check("the corpus is typed text then blocks", assembleCaptureCorpus({ inputText: "Typed.", ingestedBlocks: transcribed.ingestedBlocks }) === "Typed.\n\n---\n\nFirst block.\n\n---\n\nSecond block.");
  const queued = await queueCaptureJobRow(USER, media.id, { inputText: "Edited transcript." });
  check("Extract on a transcribed job queues it with the edited text", queued?.status === "queued" && queued.inputText === "Edited transcript.");
  check("a wrong user cannot queue it", (await queueCaptureJobRow("nope", media.id, {})) === null);

  console.log("\nHeartbeat…");
  {
    // Four minutes of silence pass in the middle of a long parse: back-date the claim, then
    // ask whether a stall sweep could take it over.
    const backdate = (id: string) =>
      db.update(captureJobs).set({ updatedAt: new Date(Date.now() - CAPTURE_CLAIM_STALE_MS - 1000) }).where(eq(captureJobs.id, id));

    const silent = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "A long note, no heartbeat." });
    let stolenWithout: unknown = null;
    await runCaptureJobById(silent.id, {
      parse: async (_u, corpus) => {
        await backdate(silent.id);
        stolenWithout = await claimCaptureJob(silent.id, "extracting");
        return fakeParse(corpus);
      },
      enrich: false,
    });
    check("control: a silent long parse CAN be re-claimed mid-flight", stolenWithout !== null);

    const beating = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "A long note that reports progress." });
    let stolenWith: unknown = "not tried";
    await runCaptureJobById(beating.id, {
      parse: async (_u, corpus, _h, opts) => {
        await backdate(beating.id);
        await opts?.onProgress?.(); // one of the parse's model calls just finished
        stolenWith = await claimCaptureJob(beating.id, "extracting");
        return fakeParse(corpus);
      },
      enrich: false,
    });
    check("a heartbeat between model calls keeps the claim, so the parse is never paid for twice", stolenWith === null);
    check("and the parse still lands", (await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, beating.id) }))?.status === "ready");
    await db.delete(captureJobs).where(inArray(captureJobs.id, [silent.id, beating.id]));
  }

  console.log("\nFailure and discard…");
  const broken = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "x" });
  const failed = await runCaptureJobById(broken.id, { parse: async () => { throw new Error("model exploded"); }, enrich: false });
  check("a parse failure is recorded as failed with a message", failed?.status === "failed" && Boolean(failed.error), failed?.error ?? "");
  check("a recently failed job is still surfaced to the page", (await findActiveCaptureJob(USER))?.id === broken.id);
  check("discarding it works", await discardCaptureJobRow(USER, broken.id));
  check("a discarded job cannot be discarded twice", !(await discardCaptureJobRow(USER, broken.id)));
  await discardCaptureJobRow(USER, media.id);
  check("nothing active remains", (await findActiveCaptureJob(USER)) === null);

  await db.delete(captureJobs).where(and(eq(captureJobs.userId, USER), eq(captureJobs.status, "discarded")));
  await reset();
  console.log("\nsmoke-capture-jobs: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
