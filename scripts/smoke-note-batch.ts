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

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactionMentions, interactions, noteBatches, reminders, userSettings } from "../src/db/schema";
import { dismissNoteReminderForUser, saveNoteBatch, undoNoteBatchForUser, type SaveNoteBatchInput } from "../src/lib/note-batch-save";
import { hashSourceNote, isoDay } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const isoDayOf = (d: Date | string) => isoDay(new Date(d));

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
    name, company, role: null, presence: "participant" as const, location: null, email: null, linkedin_url: null, met_at: null,
    topics: ["fundraising"], action_items: actionItems,
    follow_up_recommendation: followUpDays ? `Follow up with ${name}` : null, follow_up_days: followUpDays,
    relationship_score_suggestion: 3, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01",
    low_confidence_fields: [],
  };
}

function input(miraId: string): SaveNoteBatchInput {
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
    mentions: [
      { text: "Raj", context: "she'll intro me to Raj", nearPerson: "Sarah Chen", contactId: null, confidence: 0, matchedBy: null }, // unresolved
      { text: "Mira", context: null, nearPerson: "Sarah Chen", contactId: miraId, confidence: 0.7, matchedBy: "first_name_unique" },
    ],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
}

async function main() {
  await reset();
  const db = await getDb();

  // Seed a contact who will be resolved as a mention (not a participant of this note).
  const [mira] = await db.insert(contacts).values({ userId: USER, fullName: "Mira Okafor" }).returning();
  const miraId = mira.id;

  // 1. First save: two contacts, two interactions, reminders auto-created.
  const first = await saveNoteBatch(USER, input(miraId));
  check("two contacts created", first.created === 2 && first.updated === 0, JSON.stringify({ c: first.created, u: first.updated }));
  const rows = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("two interactions", rows.length === 2, String(rows.length));
  check("interactions dated from the note", rows.every((r) => new Date(r.interactionDate).getMonth() === 8 && new Date(r.interactionDate).getDate() === 1));
  check("interactions carry the batch id", rows.every((r) => r.noteBatchId === first.batchId));
  check("externalId is notes:<hash>:<contactId>", rows.every((r) => r.externalId?.startsWith(`notes:${hashSourceNote(NOTE)}:`)));

  // Spec §3: a capture that asked for a reminder also moves the contact's own follow-up
  // stamp. This is the column the profile and the follow-up queue read, and nothing else
  // in the note path writes it.
  const savedPeople = await db.query.contacts.findMany({ where: and(eq(contacts.userId, USER), inArray(contacts.id, first.contactIds)) });
  check("both participants got a nextFollowUpAt", savedPeople.length === 2 && savedPeople.every((c) => c.nextFollowUpAt !== null), JSON.stringify(savedPeople.map((c) => [c.fullName, c.nextFollowUpAt])));
  const devContact = savedPeople.find((c) => c.fullName === "Dev Patel")!;
  check("  Dev's is anchor + 7d (his follow_up_days)", isoDayOf(devContact.nextFollowUpAt!) === "2026-09-08", isoDayOf(devContact.nextFollowUpAt!));
  const sarahContact = savedPeople.find((c) => c.fullName === "Sarah Chen")!;
  check("  Sarah's is anchor + 14d", isoDayOf(sarahContact.nextFollowUpAt!) === "2026-09-15", isoDayOf(sarahContact.nextFollowUpAt!));

  const rems = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.status, "pending")) });
  const titles = rems.map((r) => r.title).sort();
  // Sarah: Kickoff (absolute) + Intro to Raj (relative) + "Send Sarah the deck" (her action
  // item, window). Dev: no commitments → fallback "Follow up with Dev Patel".
  // Sarah's fallback follow-up is suppressed because she already has reminders from the note.
  check("four pending reminders", rems.length === 4, titles.join(" | "));
  check("  Sarah has no generic follow-up", !titles.includes("Follow up with Sarah Chen"), titles.join(" | "));
  check("  Dev got the fallback follow-up", titles.includes("Follow up with Dev Patel"));
  const kickoff = rems.find((r) => r.title === "Kickoff")!;
  check("  provenance recorded", kickoff.noteBatchId === first.batchId && kickoff.rawDatePhrase === "Sept 20" && kickoff.dateBasis === "absolute" && Boolean(kickoff.itemHash) && Boolean(kickoff.sourceInteractionId) && kickoff.sourceExcerpt === "Kickoff is Sept 20.");
  check("  reminderType extracted_date for dated", kickoff.reminderType === "extracted_date");
  const sarahId = first.contactIds[0];
  check("  linked to Sarah", kickoff.contactId === sarahId);
  check("  due at local noon", new Date(kickoff.dueDate!).getHours() === 12);
  check("result snapshot lists reminders", first.result.reminders.length === 4 && first.result.participants.length === 2);

  const deck = rems.find((r) => r.title === "Send Sarah the deck")!;
  check("action item became a window reminder", Boolean(deck) && deck.dateBasis === "window" && deck.reminderType === "ai_suggested");
  check("  due anchor + 14d", isoDayOf(deck.dueDate!) === "2026-09-15");
  const items = await db.query.actionItems.findMany({ where: eq(actionItems.userId, USER) });
  check("action item row linked to its reminder", items.length === 1 && items[0].reminderId === deck.id && deck.actionItemId === items[0].id);
  check("result lists the action item", first.result.actionItems.length === 1 && first.result.actionItems[0].reminderId === deck.id);

  const mentionRows = await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) });
  check("one mention link written", mentionRows.length === 1 && mentionRows[0].contactId === miraId && mentionRows[0].matchedBy === "first_name_unique");
  check("  hangs on Sarah's interaction", mentionRows[0].interactionId === rows.find((r) => r.contactId === sarahId)!.id);
  check("unresolved mention recorded in result", first.result.unresolvedMentions.length === 1 && first.result.unresolvedMentions[0].text === "Raj");

  const touched = await db.query.contacts.findMany({ where: and(eq(contacts.userId, USER), inArray(contacts.id, first.contactIds)) });
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
  const again = input(miraId);
  again.participants[0].mergeContactId = first.contactIds[0];
  again.participants[1].mergeContactId = first.contactIds[1];
  // A mention that resolved to somebody already IN this batch: dropped silently, never
  // offered as "unresolved" (the results page would invite you to create a duplicate of a
  // participant standing right above it).
  again.mentions = [...(again.mentions ?? []), { text: "Sarah", context: "we spoke", nearPerson: "Dev Patel", contactId: first.contactIds[0], confidence: 0.7, matchedBy: "first_name_unique" }];
  const second = await saveNoteBatch(USER, again);
  const rows2 = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  const rems2 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("re-paste: still two interactions", rows2.length === 2, String(rows2.length));
  check("re-paste: still four reminders", rems2.length === 4, String(rems2.length));
  check("re-paste: reported as duplicates", second.result.skipped.duplicate === 2 && second.result.participants.every((p) => p.duplicate), JSON.stringify(second.result.skipped));
  check("re-paste: updated, not created", second.updated === 2 && second.created === 0);
  check("merge path re-stamps embeddingStaleAt", (await db.query.contacts.findMany({ where: and(eq(contacts.userId, USER), inArray(contacts.id, second.contactIds)) })).every((c) => c.embeddingStaleAt !== null));
  check("re-paste: mention count still 1 (unique index)", (await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) })).length === 1);
  check("re-paste: a participant-targeted mention is dropped, not unresolved", second.result.unresolvedMentions.length === 1 && second.result.unresolvedMentions[0].text === "Raj", JSON.stringify(second.result.unresolvedMentions));
  check("  and never becomes a mention link", !second.result.mentions.some((m) => m.contactId === first.contactIds[0]));

  // 3. Undo the first batch: reminders dismissed (not deleted), interactions untouched.
  //    A mention link that this batch did NOT write — seeded by hand on the same
  //    interaction — must survive: undo owns its own rows and nothing else.
  const sarahInteractionId = rows.find((r) => r.contactId === sarahId)!.id;
  const [zed] = await db.insert(contacts).values({ userId: USER, fullName: "Zed Quin" }).returning();
  await db.insert(interactionMentions).values({ userId: USER, interactionId: sarahInteractionId, contactId: zed.id, mentionText: "Zed", confidence: 0.7, matchedBy: "first_name_unique" });
  const undo = await undoNoteBatchForUser(USER, first.batchId);
  check("undo dismissed four reminders", undo.remindersDismissed === 4, String(undo.remindersDismissed));
  check("undo removed mention links", undo.mentionsRemoved === 1);
  const survivors = await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) });
  check("  a foreign mention on the same interaction survives undo", survivors.length === 1 && survivors[0].contactId === zed.id, JSON.stringify(survivors.map((m) => m.mentionText)));
  const afterUndo = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("  rows still exist", afterUndo.length === 4);
  check("  all dismissed", afterUndo.every((r) => r.status === "dismissed"));
  check("  interactions survive", (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length === 2);
  const undone = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, first.batchId) });
  check("  batch marked undone", undone?.status === "undone" && undone.undoneAt !== null);

  // 4. Paste a third time after undo: the dismissed rows block re-creation.
  const third = await saveNoteBatch(USER, again);
  const rems3 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("post-undo re-paste creates no reminders", rems3.length === 4 && third.remindersCreated === 0, String(rems3.length));

  // 5. Undo of another user's batch is refused.
  let refused = false;
  try { await undoNoteBatchForUser("someone-else", first.batchId); } catch { refused = true; }
  check("undo is user-scoped", refused);

  // 6. A throw mid-loop must not orphan the batch: the first participant's write already
  // landed with this batch's noteBatchId, so the partial result must be persisted for undo
  // and the results page to find, even though saveNoteBatch itself rejects.
  const priorBatchIds = new Set((await db.query.noteBatches.findMany({ where: eq(noteBatches.userId, USER) })).map((b) => b.id));
  const partial = input(miraId);
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

  // 7. Collision: an action item whose title collides with a dated commitment for the same
  //    contact (due dates within the collision window) must not also get its own window
  //    reminder — the item row stays with no reminder link, and since the commitment draft
  //    already covers this contact, the fallback follow-up is suppressed too.
  const devId = first.contactIds[1];
  const collisionNote = "Dev Patel — let's get the kickoff going.";
  const collisionInput: SaveNoteBatchInput = {
    sourceText: collisionNote,
    sourceHash: hashSourceNote(collisionNote),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      { notes: collisionNote, parsed: parsed("Dev Patel", null, ["Book kickoff"], null), mergeContactId: devId, createReminder: true, relationshipScore: 2, tagNames: [] },
    ],
    commitments: [
      { title: "Kickoff", description: null, rawDatePhrase: "Sept 16", dueDateIso: "2026-09-16", yearInferred: true, personName: "Dev Patel", actionKind: "meet", confidenceScore: 90, sourceExcerpt: "Sept 16 kickoff.", dateBasis: "absolute", anchorIso: "2026-09-01" },
    ],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
  const collision = await saveNoteBatch(USER, collisionInput);
  const devReminders = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.contactId, devId), eq(reminders.noteBatchId, collision.batchId)) });
  check("collision: no window reminder titled Book kickoff", !devReminders.some((r) => r.title === "Book kickoff"), devReminders.map((r) => r.title).join(" | "));
  check("collision: Dev's Kickoff commitment reminder created", devReminders.some((r) => r.title === "Kickoff" && r.dateBasis === "absolute"));
  check("collision: Dev has no fallback follow-up from this batch", !devReminders.some((r) => r.title === "Follow up with Dev Patel"));
  const devActionItem = await db.query.actionItems.findFirst({ where: and(eq(actionItems.userId, USER), eq(actionItems.contactId, devId), eq(actionItems.text, "Book kickoff")) });
  check("collision: action item row still exists with no reminder link", devActionItem !== undefined && devActionItem.reminderId === null);

  // 8. Two different contacts in one batch with the identical action-item text and the
  //    same window due date must not collide on itemHash (which used to hash the title,
  //    not the item id) — each gets its own reminder.
  const sharedTextNote = "Caught up with Amy Liu and Ben Cho separately — both want the deck.";
  const sharedTextInput: SaveNoteBatchInput = {
    sourceText: sharedTextNote,
    sourceHash: hashSourceNote(sharedTextNote),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      { notes: sharedTextNote, parsed: parsed("Amy Liu", null, ["Send the deck"], null), createReminder: false, relationshipScore: 2, tagNames: [] },
      { notes: sharedTextNote, parsed: parsed("Ben Cho", null, ["Send the deck"], null), createReminder: false, relationshipScore: 2, tagNames: [] },
    ],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
  const sharedText = await saveNoteBatch(USER, sharedTextInput);
  const sharedTextReminders = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.noteBatchId, sharedText.batchId), eq(reminders.title, "Send the deck")) });
  check("shared action-item text: two reminders created, not one", sharedTextReminders.length === 2, String(sharedTextReminders.length));
  const sharedTextItems = await db.query.actionItems.findMany({ where: and(eq(actionItems.userId, USER), eq(actionItems.text, "Send the deck"), inArray(actionItems.contactId, sharedText.contactIds)) });
  check("shared action-item text: one action item row per contact", sharedTextItems.length === 2, String(sharedTextItems.length));
  check(
    "shared action-item text: each item links to a reminder scoped to its own contact",
    sharedTextItems.every((item) => {
      const rem = sharedTextReminders.find((r) => r.id === item.reminderId);
      return Boolean(rem) && rem!.actionItemId === item.id && rem!.contactId === item.contactId;
    })
  );

  await reset();
  console.log("\nsmoke-note-batch: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
