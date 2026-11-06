/**
 * Saving a note into an EXISTING contact keeps the closeness someone set by hand, unless they
 * picked a new one on the card. The profile's "Log interaction" sheet has no closeness
 * control, yet used to write the model's guess over the rating.
 * Run: npx tsx scripts/smoke-merge-closeness.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-merge-closeness";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-merge-closeness";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, noteBatches, reminders, userSettings } from "../src/db/schema";
import { saveNoteBatch, type NoteBatchParticipantInput } from "../src/lib/note-batch-save";
import { saveInputFromParse } from "../src/lib/capture-job-runner";
import type { BulkNotePersonPreview, CaptureParseResult } from "../src/lib/capture/types";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-merge-closeness-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

function parsed(name: string) {
  return {
    name, company: null, role: null, presence: "participant" as const, location: null, email: null, linkedin_url: null, met_at: null,
    topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null,
    relationship_score_suggestion: 2, relevance: null, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01", low_confidence_fields: [],
  };
}

async function save(note: string, p: Omit<NoteBatchParticipantInput, "notes" | "parsed" | "createReminder" | "tagNames">) {
  await saveNoteBatch(USER, {
    sourceText: note, sourceHash: hashSourceNote(note), anchorIso: "2026-09-01", anchorBasis: "note", entryPoint: "profile",
    participants: [{ notes: note, parsed: parsed("Priya Raman"), createReminder: false, tagNames: [], ...p }],
    commitments: [], skipped: { relative: 0, unverifiable: 0, past: 0 },
  });
}

async function main() {
  await reset();
  const db = await getDb();
  const [priya] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman", relationshipScore: 5, statedCloseness: 5 }).returning();
  const read = async () => (await db.query.contacts.findFirst({ where: eq(contacts.id, priya.id) }))!;

  // 1. The profile sheet's call shape: a model suggestion, no control touched.
  await save("Coffee with Priya.", { mergeContactId: priya.id, relationshipScore: 2 });
  let row = await read();
  check("a logged note keeps the hand-set closeness", row.relationshipScore === 5 && row.statedCloseness === 5, JSON.stringify([row.relationshipScore, row.statedCloseness]));

  // 2. A closeness the person picked on the card still lands.
  await save("Dinner with Priya.", { mergeContactId: priya.id, relationshipScore: 4, closenessChosen: true });
  row = await read();
  check("a chosen closeness is written on merge", row.relationshipScore === 4 && row.statedCloseness === 4, JSON.stringify([row.relationshipScore, row.statedCloseness]));

  // 3. The capture deck: the decision's flag reaches the participant; absent means not chosen.
  const item = { key: "0-Priya Raman", notes: "x", parsed: parsed("Priya Raman"), duplicates: [], suggestedMergeId: priya.id, interactionDate: null, interactionType: "note" } as unknown as BulkNotePersonPreview;
  const result = { items: [item, { ...item, key: "1-Priya Raman" }], sharedNotes: [], interactionDate: null, interactionType: "note", anchorIso: "2026-09-01", anchorBasis: "note", hints: {}, sourceText: "x", sourceHash: hashSourceNote("x"), suggestedReminders: [], suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 }, mentions: [], mentionedOnly: [] } as unknown as CaptureParseResult;
  const built = await saveInputFromParse({
    userId: USER, result, sourceText: "x", sourceHash: null, entryPoint: "capture", seedContactId: null, inputSources: [], meetingSessionId: null,
    decisions: { people: {
      "0-Priya Raman": { decision: "accept", index: 0, mergeContactId: priya.id, relationshipScore: 3, tagNames: [], decidedAt: "" },
      "1-Priya Raman": { decision: "accept", index: 1, mergeContactId: priya.id, relationshipScore: 3, tagNames: [], decidedAt: "", closenessChosen: true },
    } },
  });
  check("deck: an untouched card is not a choice", built.participants[0].closenessChosen !== true);
  check("deck: a touched card carries the choice", built.participants[1].closenessChosen === true);

  await reset();
  console.log("\nsmoke-merge-closeness: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
