/**
 * The save path behind a confirmed note paste, with no AI: participants become contacts +
 * interactions, dated commitments become reminders immediately, a re-paste creates nothing
 * new, and Undo dismisses without deleting (so the re-paste guard survives it).
 *
 * Writes to the local PGlite file. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-note-batch.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-note-batch";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-note-batch";
delete process.env.DATABASE_URL;

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches, reminders, userSettings } from "../src/db/schema";
import { dismissNoteReminderForUser, saveNoteBatch, undoNoteBatchForUser, type SaveNoteBatchInput } from "../src/lib/note-batch-save";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-note-batch-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER)); // cascades interactions, mentions, action items
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

const NOTE = `Coffee with Sarah Chen (Stripe, PM). Kickoff is Sept 20. She'll intro me to Raj in two weeks.
Also met Dev Patel — wants the deck soon.`;

function parsed(name: string, company: string | null, actionItems: string[], followUpDays: number | null) {
  return {
    name, company, role: null, location: null, email: null, linkedin_url: null, met_at: null,
    topics: ["fundraising"], action_items: actionItems,
    follow_up_recommendation: followUpDays ? `Follow up with ${name}` : null, follow_up_days: followUpDays,
    relationship_score_suggestion: 3, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01",
    low_confidence_fields: [],
  };
}

function input(): SaveNoteBatchInput {
  return {
    sourceText: NOTE,
    sourceHash: hashSourceNote(NOTE),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      { notes: NOTE, parsed: parsed("Sarah Chen", "Stripe", ["Send Sarah the deck"], 14), createReminder: true, relationshipScore: 3, tagNames: [] },
      { notes: NOTE, parsed: parsed("Dev Patel", null, [], 7), createReminder: true, relationshipScore: 2, tagNames: [] },
    ],
    commitments: [
      { title: "Kickoff", description: null, rawDatePhrase: "Sept 20", dueDateIso: "2026-09-20", yearInferred: true, personName: "Sarah Chen", actionKind: "meet", confidenceScore: 90, sourceExcerpt: "Kickoff is Sept 20.", dateBasis: "absolute", anchorIso: "2026-09-01" },
      { title: "Intro to Raj", description: null, rawDatePhrase: "in two weeks", dueDateIso: "2026-09-15", yearInferred: false, personName: "Sarah Chen", actionKind: "follow_up", confidenceScore: 80, sourceExcerpt: "She'll intro me to Raj in two weeks.", dateBasis: "relative", anchorIso: "2026-09-01" },
    ],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
}

async function main() {
  await reset();
  const db = await getDb();

  // 1. First save: two contacts, two interactions, reminders auto-created.
  const first = await saveNoteBatch(USER, input());
  check("two contacts created", first.created === 2 && first.updated === 0, JSON.stringify({ c: first.created, u: first.updated }));
  const rows = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("two interactions", rows.length === 2, String(rows.length));
  check("interactions dated from the note", rows.every((r) => new Date(r.interactionDate).getMonth() === 8 && new Date(r.interactionDate).getDate() === 1));
  check("interactions carry the batch id", rows.every((r) => r.noteBatchId === first.batchId));
  check("externalId is notes:<hash>:<contactId>", rows.every((r) => r.externalId?.startsWith(`notes:${hashSourceNote(NOTE)}:`)));

  const rems = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.status, "pending")) });
  const titles = rems.map((r) => r.title).sort();
  // Sarah: Kickoff (absolute) + Intro to Raj (relative). Dev: no commitments → fallback "Follow up with Dev Patel".
  // Sarah's fallback follow-up is suppressed because she already has reminders from the note.
  check("three pending reminders", rems.length === 3, titles.join(" | "));
  check("  Sarah has no generic follow-up", !titles.includes("Follow up with Sarah Chen"), titles.join(" | "));
  check("  Dev got the fallback follow-up", titles.includes("Follow up with Dev Patel"));
  const kickoff = rems.find((r) => r.title === "Kickoff")!;
  check("  provenance recorded", kickoff.noteBatchId === first.batchId && kickoff.rawDatePhrase === "Sept 20" && kickoff.dateBasis === "absolute" && Boolean(kickoff.itemHash) && Boolean(kickoff.sourceInteractionId) && kickoff.sourceExcerpt === "Kickoff is Sept 20.");
  check("  reminderType extracted_date for dated", kickoff.reminderType === "extracted_date");
  const sarahId = first.contactIds[0];
  check("  linked to Sarah", kickoff.contactId === sarahId);
  check("  due at local noon", new Date(kickoff.dueDate!).getHours() === 12);
  check("result snapshot lists reminders", first.result.reminders.length === 3 && first.result.participants.length === 2);
  const touched = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  check("touched contacts stamped embeddingStaleAt (no inline embedding call)", touched.every((c) => c.embeddingStaleAt !== null));

  const batch = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, first.batchId) });
  check("batch row saved", batch?.status === "saved" && batch.anchorBasis === "note");

  // 1b. dismissNoteReminderForUser: dismisses one reminder, leaves the others alone, and is
  // user-scoped (a no-op for anyone but the owner). Flip it back so downstream counts hold.
  await dismissNoteReminderForUser(USER, kickoff.id);
  const afterDismiss = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  const kickoffAfterDismiss = afterDismiss.find((r) => r.id === kickoff.id)!;
  check("dismissNoteReminderForUser dismisses the target reminder", kickoffAfterDismiss.status === "dismissed");
  check("  other reminders stay pending", afterDismiss.filter((r) => r.id !== kickoff.id).every((r) => r.status === "pending"));
  await db.update(reminders).set({ status: "pending" }).where(eq(reminders.id, kickoff.id));
  await dismissNoteReminderForUser("someone-else", kickoff.id);
  const afterWrongUser = await db.query.reminders.findFirst({ where: eq(reminders.id, kickoff.id) });
  check("  dismissNoteReminderForUser is user-scoped (no-op for another user)", afterWrongUser?.status === "pending");

  // Re-baseline embeddingStaleAt so the merge path below (which never runs createContactForUser,
  // the only place that stamps it on create) is the thing proving the batch-level UPDATE fires.
  await db.update(contacts).set({ embeddingStaleAt: null }).where(eq(contacts.userId, USER));

  // 2. Re-paste with merge into the existing contacts: nothing new is created.
  const again = input();
  again.participants[0].mergeContactId = first.contactIds[0];
  again.participants[1].mergeContactId = first.contactIds[1];
  const second = await saveNoteBatch(USER, again);
  const rows2 = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  const rems2 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("re-paste: still two interactions", rows2.length === 2, String(rows2.length));
  check("re-paste: still three reminders", rems2.length === 3, String(rems2.length));
  check("re-paste: reported as duplicates", second.result.skipped.duplicate === 2 && second.result.participants.every((p) => p.duplicate), JSON.stringify(second.result.skipped));
  check("re-paste: updated, not created", second.updated === 2 && second.created === 0);
  check("merge path re-stamps embeddingStaleAt", (await db.query.contacts.findMany({ where: eq(contacts.userId, USER) })).every((c) => c.embeddingStaleAt !== null));

  // 3. Undo the first batch: reminders dismissed (not deleted), interactions untouched.
  const undo = await undoNoteBatchForUser(USER, first.batchId);
  check("undo dismissed three reminders", undo.remindersDismissed === 3, String(undo.remindersDismissed));
  const afterUndo = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("  rows still exist", afterUndo.length === 3);
  check("  all dismissed", afterUndo.every((r) => r.status === "dismissed"));
  check("  interactions survive", (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length === 2);
  const undone = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, first.batchId) });
  check("  batch marked undone", undone?.status === "undone" && undone.undoneAt !== null);

  // 4. Paste a third time after undo: the dismissed rows block re-creation.
  const third = await saveNoteBatch(USER, again);
  const rems3 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("post-undo re-paste creates no reminders", rems3.length === 3 && third.remindersCreated === 0, String(rems3.length));

  // 5. Undo of another user's batch is refused.
  let refused = false;
  try { await undoNoteBatchForUser("someone-else", first.batchId); } catch { refused = true; }
  check("undo is user-scoped", refused);

  // 6. A throw mid-loop must not orphan the batch: the first participant's write already
  // landed with this batch's noteBatchId, so the partial result must be persisted for undo
  // and the results page to find, even though saveNoteBatch itself rejects.
  const priorBatchIds = new Set((await db.query.noteBatches.findMany({ where: eq(noteBatches.userId, USER) })).map((b) => b.id));
  const partial = input();
  partial.participants[1] = { ...partial.participants[1], parsed: { ...partial.participants[1].parsed, name: null }, mergeContactId: null };
  let threw = false;
  try {
    await saveNoteBatch(USER, partial);
  } catch {
    threw = true;
  }
  check("partial batch: throws when a participant has no name and no merge target", threw);
  const batchesAfter = await db.query.noteBatches.findMany({ where: eq(noteBatches.userId, USER) });
  const partialBatch = batchesAfter.find((b) => !priorBatchIds.has(b.id));
  check(
    "  the failed batch persists the partial result (first participant only)",
    partialBatch !== undefined && partialBatch.result.participants.length === 1,
    JSON.stringify(partialBatch?.result.participants)
  );

  await reset();
  console.log("\nsmoke-note-batch: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
