/**
 * The capture summary's Save button counts every reminder the save writes — action items
 * and fallback follow-ups included — and the save writes exactly that many. Fixture: the
 * 2026-09-15 audit note, whose button said "1 reminder" before a save that wrote 4.
 * Run: npx tsx scripts/smoke-capture-reminder-count.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-reminder-count";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-reminder-count";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contacts, ignoredPeople, noteBatches, reminders, userSettings } from "../src/db/schema";
import { createCaptureJob, getCaptureJobById, recordCaptureDecisionRow } from "../src/lib/capture-jobs";
import { runCaptureJobById } from "../src/lib/capture-job-runner";
import { defaultReminderKeys, plannedCaptureReminders, saveButtonLabel } from "../src/lib/capture/review-reducer";
import type { CaptureParseResult } from "../src/lib/capture/types";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-capture-reminder-count-user";
const NOTE =
  "Founders dinner in Durham last night. Sat next to Priya Raman, who runs growth at Loom and used to be at Stripe with Tom. She's hiring a PM and offered to intro me to their head of partnerships. Also met Sarah Chen again (OpenAI) - she wants the retrieval write-up by Friday and mentioned her colleague Devon is working on evals. Devon didn't give a last name. Follow up with Priya next week about the PM role.";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Parsed = CaptureParseResult["items"][number]["parsed"];
function person(name: string, over: Partial<Parsed> = {}): Parsed {
  return {
    name, company: null, role: null, presence: "participant", location: null, email: null, linkedin_url: null,
    met_at: "Founders dinner in Durham", topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null,
    relationship_score_suggestion: 3, relevance: null, tags: [], summary: null, key_facts: [], opportunities: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-14", low_confidence_fields: [],
    ...over,
  };
}

function fakeParse(corpus: string): CaptureParseResult {
  const card = (key: string, parsed: Parsed) => ({ key, notes: NOTE, parsed, duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-14", interactionType: "meeting_note" });
  return {
    items: [
      card("0-Priya Raman", person("Priya Raman", { company: "Loom", role: "Head of Growth", action_items: ["Follow up with Priya next week about the PM role"], follow_up_recommendation: "Follow up about the PM role" })),
      card("1-Sarah Chen", person("Sarah Chen", { company: "OpenAI", action_items: ["Send Sarah the retrieval write-up"] })),
      card("2-Devon", person("Devon", { relationship_score_suggestion: 2 })),
    ],
    sharedNotes: [],
    interactionDate: "2026-09-14",
    interactionType: "meeting_note",
    anchorIso: "2026-09-15",
    anchorBasis: "note",
    hints: {},
    sourceText: corpus,
    sourceHash: hashSourceNote(corpus),
    suggestedReminders: [
      { key: "0-next week", title: "Follow up with Priya about the PM role", description: null, rawDatePhrase: "next week", dueDateIso: "2026-09-21", yearInferred: false, personName: "Priya Raman", actionKind: "follow_up", confidenceScore: 80, sourceExcerpt: "Follow up with Priya next week about the PM role.", dateBasis: "relative", anchorIso: "2026-09-15" },
    ],
    suggestionsSkipped: { relative: 1, unverifiable: 0, past: 0, relativePhrases: ["by Friday"] },
    mentions: [{ text: "Tom", context: "used to be at Stripe with Tom", nearPerson: "Priya Raman", contactId: null, confidence: 0, matchedBy: null }],
    mentionedOnly: [],
  };
}

const deps = { parse: async (_userId: string, corpus: string) => fakeParse(corpus), enrich: false };

run(async () => {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const job = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: NOTE });
  await runCaptureJobById(job.id, deps);
  const decidedAt = new Date().toISOString();
  await recordCaptureDecisionRow(USER, job.id, "0-Priya Raman", { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt });
  await recordCaptureDecisionRow(USER, job.id, "1-Sarah Chen", { decision: "accept", index: 1, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt });
  await recordCaptureDecisionRow(USER, job.id, "2-Devon", { decision: "accept", index: 2, mergeContactId: null, relationshipScore: 2, tagNames: [], decidedAt });

  const row = (await getCaptureJobById(job.id))!;
  const ticked = new Set(defaultReminderKeys(row.result!.suggestedReminders));
  const planned = plannedCaptureReminders(
    row.result!,
    row.decisions,
    row.result!.suggestedReminders.filter((s) => ticked.has(s.key)).map((s) => ({ title: s.title, dueDateIso: s.dueDateIso, dateBasis: s.dateBasis, personName: s.personName }))
  );
  console.log("Planned…");
  check("two reminders planned: Priya's dated follow-up and Sarah's action item", planned.length === 2, JSON.stringify(planned.map((p) => [p.kind, p.title])));
  check("Priya's duplicate action item is not planned", !planned.some((p) => p.title === "Follow up with Priya next week about the PM role"));
  check("the button says so", saveButtonLabel({ meeting: false, contacts: 3, reminders: planned.length }) === "Save 3 contacts + 2 reminders");
  check("label: singular and meeting forms", saveButtonLabel({ meeting: true, contacts: 1, reminders: 1 }) === "Save meeting + 1 contact + 1 reminder");
  check("label: nothing to count", saveButtonLabel({ meeting: false, contacts: 0, reminders: 0 }) === "Save");

  console.log("\nSaved…");
  await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, job.id));
  const saved = await runCaptureJobById(job.id, deps);
  check("the save lands", saved?.status === "saved", `${saved?.status} ${saved?.error}`);
  check("the save writes exactly what the button promised", saved?.result?.saved?.remindersCreated === planned.length, JSON.stringify(saved?.result?.saved));
  const rows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check(
    "the rows are the planned titles",
    JSON.stringify(rows.map((r) => r.title).sort()) === JSON.stringify(planned.map((p) => p.title).sort()),
    JSON.stringify(rows.map((r) => r.title))
  );
});
