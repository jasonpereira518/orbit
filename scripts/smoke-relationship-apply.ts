/**
 * The writer: idempotent re-apply, dismissed items never recreated, key-fact dedupe,
 * title/company never written (P1), next_follow_up_at, watermark advance, open threads, closing
 * action items, and run undo.
 *
 * Run: npx tsx scripts/smoke-relationship-apply.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-apply";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-apply";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems, contactCareerMoves, contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, reminders, userSettings,
} from "../src/db/schema";
import { applyDigestPlan, ensureRunNoteBatch, loadPreviousDigest, undoRelationshipRun } from "../src/lib/relationship-engine/apply";
import { undoNoteBatchForUser } from "../src/lib/note-batch-save";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import { planDigestWrites } from "../src/lib/relationship-engine/rules";
import type { ValidatedDigest } from "../src/lib/relationship-engine/types";
import { pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import { actionItemHash } from "../src/lib/action-items";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-rel-apply-user";
const NOW = new Date();

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const t of [relationshipDigests, relationshipRuns, reminders, actionItems, noteBatches, interactions, contacts, userSettings]) {
    await db.delete(t).where(eq(t.userId, USER));
  }
  await ensureUserSettings(USER);
}

async function main() {
  await reset();
  const db = await getDb();
  const [c] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Maya Chen", source: "linkedin_messages", keyFacts: ["Has two kids"], statedCloseness: 3 })
    .returning();
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const msgs = await db
    .insert(interactions)
    .values([
      { userId: USER, contactId: c.id, interactionType: "linkedin_message", interactionDate: day(5), source: "linkedin_messages", externalId: "li-msg:a1", rawNotes: "I know Priya at Stripe, happy to intro", topics: [], direction: "in" as const },
      { userId: USER, contactId: c.id, interactionType: "linkedin_message", interactionDate: day(4), source: "linkedin_messages", externalId: "li-msg:a2", rawNotes: "Amazing, I'll send you the deck", topics: [], direction: "out" as const },
    ])
    .returning();
  const [run] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();

  const window = (await loadMessageWindows(USER, [c.id])).get(c.id)!;
  const validated: ValidatedDigest = {
    whatTheyDo: "PM at Stripe",
    workingOn: "Payments onboarding",
    summary: "Met through Priya.",
    topics: ["payments"],
    facts: ["has two kids", "Moved to Austin"],
    dated: [],
    undated: [
      { text: "Send Maya the deck", owedBy: "me", origin: "explicit", confidence: 90, excerpt: "I'll send you the deck", messageAt: msgs[1].interactionDate, interactionId: msgs[1].id, withinDays: 3 },
      { text: "Intro to Priya", owedBy: "them", origin: "implied", confidence: 70, excerpt: "happy to intro", messageAt: msgs[0].interactionDate, interactionId: msgs[0].id, withinDays: null },
    ],
    closedKeys: [],
    jobChange: { company: "Stripe", title: "PM", messageAt: msgs[0].interactionDate },
  };
  const plan = planDigestWrites(validated, {
    contactId: c.id, contactFirstName: "Maya", now: NOW, closeness: 3, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25,
  });

  const r1 = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated, plan });
  check("first apply: 2 reminders", r1.remindersCreated === 2, JSON.stringify(r1));
  check("first apply: 2 action items", r1.actionItemsCreated === 2);
  check("first apply: 1 new fact (dedupe vs existing)", r1.factsAdded === 1);

  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check("key facts appended", JSON.stringify(contact!.keyFacts) === JSON.stringify(["Has two kids", "Moved to Austin"]));
  // P1 never writes title/company (fingerprinted fields; deferred pending an owner decision).
  check("company/title left empty despite a job change", !contact!.company && !contact!.title, `${contact!.company}/${contact!.title}`);
  check("ai_summary untouched", contact!.aiSummary == null);
  check("next_follow_up_at set", contact!.nextFollowUpAt != null);

  const items = await db.query.actionItems.findMany({ where: eq(actionItems.contactId, c.id) });
  check("owed_by written", items.some((i) => i.owedBy === "me") && items.some((i) => i.owedBy === "them"));
  check("action items link reminders", items.every((i) => i.reminderId));

  const digest = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, c.id) });
  check("digest written", digest?.whatTheyDo === "PM at Stripe" && digest.summary === "Met through Priya.");
  check("watermark at last message", digest?.watermarkInteractionId === msgs[1].id);
  check("message count", digest?.messageCount === 2);
  check("no longer pending", (await pendingRelationshipContactCount(USER)) === 0);

  const runRow = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run.id) });
  check("run has a note batch", Boolean(runRow?.noteBatchId));
  check("run counters", runRow?.remindersCreated === 2 && runRow.factsAdded === 1 && runRow.processed === 1);
  const batch = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, runRow!.noteBatchId!) });
  check("batch entry point", batch?.entryPoint === "relationship");
  check("batch result lists reminders", batch?.result.reminders.length === 2);

  // A known company and a job change: still no write, and no career move recorded.
  await db.update(contacts).set({ company: "Acme", title: "Engineer" }).where(eq(contacts.id, c.id));
  await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated, plan });
  const known = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check("known company untouched", known!.company === "Acme" && known!.title === "Engineer");
  check("no career move recorded", (await db.query.contactCareerMoves.findMany({ where: eq(contactCareerMoves.contactId, c.id) })).length === 0);
  await db.update(contacts).set({ company: null, title: null }).where(eq(contacts.id, c.id));

  // Re-apply the same plan: nothing new.
  const r2 = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated, plan });
  check("re-apply idempotent", r2.remindersCreated === 0 && r2.actionItemsCreated === 0 && r2.factsAdded === 0, JSON.stringify(r2));

  // Dismissed reminder is never recreated.
  await db.update(reminders).set({ status: "dismissed" }).where(eq(reminders.userId, USER));
  const r3 = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated, plan });
  check("dismissed not recreated", r3.remindersCreated === 0);

  // Retry planned on a LATER day: undated due dates shift, so the hash differs. No second
  // reminder per action item, and the dismissed one is not resurrected.
  const laterPlan = planDigestWrites(validated, {
    contactId: c.id, contactFirstName: "Maya", now: new Date(NOW.getTime() + 86_400_000), closeness: 3, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25,
  });
  const r4 = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated, plan: laterPlan, now: new Date(NOW.getTime() + 86_400_000) });
  const allRem = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("later-day retry adds no reminder", r4.remindersCreated === 0 && allRem.length === 2, `${JSON.stringify(r4)} rows=${allRem.length}`);
  check("dismissed stays dismissed", allRem.every((r) => r.status === "dismissed"));
  await db.update(reminders).set({ status: "pending" }).where(eq(reminders.userId, USER));

  // previous digest exposes action items as ai:<id> keys.
  const prev = await loadPreviousDigest(USER, c.id);
  check("previous digest open keys include ai:", [...prev.openKeys].some((k) => k.startsWith("ai:")));

  // Closing an action item marks it done and its reminder done.
  const target = items.find((i) => i.owedBy === "me")!;
  const closePlan = { ...plan, actionItems: [], facts: [], closeActionItemIds: [target.id] };
  await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated: { ...validated, facts: [] }, plan: closePlan });
  const closed = await db.query.actionItems.findFirst({ where: eq(actionItems.id, target.id) });
  const closedReminder = await db.query.reminders.findFirst({ where: eq(reminders.id, target.reminderId!) });
  check("closed action item done", closed?.status === "done");
  check("closed reminder done", closedReminder?.status === "done");

  const dg = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, c.id) });
  check("replays do not inflate message_count", dg?.messageCount === 2, String(dg?.messageCount));
  const runAfterReplay = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run.id) });
  check("replays do not inflate run counters", runAfterReplay?.processed === 1, String(runAfterReplay?.processed));

  // Crash between action-item insert and batch snapshot: the item exists, the batch does not list it.
  const orphanText = "Crash orphan item";
  await db.insert(actionItems).values({ userId: USER, contactId: c.id, interactionId: msgs[0].id, text: orphanText, position: 9, status: "open", itemHash: actionItemHash(msgs[0].id, orphanText), owedBy: null });
  const orphanPlan = { ...plan, actionItems: [{ text: orphanText, owedBy: null, interactionId: msgs[0].id, reminder: null }], facts: [], closeActionItemIds: [] };
  const rOrphan = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated: { ...validated, facts: [] }, plan: orphanPlan });
  check("orphan not re-created", rOrphan.actionItemsCreated === 0);

  // (a) Orphan the retry plan does NOT mention (regenerated plan words things differently / is empty).
  const orphan2Text = "Crash orphan, reworded on retry";
  await db.insert(actionItems).values({ userId: USER, contactId: c.id, interactionId: msgs[1].id, text: orphan2Text, position: 8, status: "open", itemHash: actionItemHash(msgs[1].id, orphan2Text), owedBy: "me" });
  // (b) An item anchored on a NON-message interaction (a note) made during the run: not the engine's.
  const [noteRow] = await db.insert(interactions).values({ userId: USER, contactId: c.id, interactionType: "note", interactionDate: NOW, source: "manual", rawNotes: "met for coffee", topics: [] }).returning();
  const noteText = "Follow up from the coffee note";
  const [noteItem] = await db.insert(actionItems).values({ userId: USER, contactId: c.id, interactionId: noteRow.id, text: noteText, position: 7, status: "open", itemHash: actionItemHash(noteRow.id, noteText), owedBy: null }).returning();
  const emptyRetry = { ...plan, actionItems: [], facts: [], closeActionItemIds: [] };
  await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated: { ...validated, facts: [] }, plan: emptyRetry });
  const batchNow = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, runRow!.noteBatchId!) });
  const listedIds = new Set(batchNow!.result.actionItems.map((x) => x.id));
  check("sweep snapshots orphan absent from retry plan", [...listedIds].length >= 4 && (await db.query.actionItems.findFirst({ where: eq(actionItems.itemHash, actionItemHash(msgs[1].id, orphan2Text)) }))! && listedIds.has((await db.query.actionItems.findFirst({ where: eq(actionItems.itemHash, actionItemHash(msgs[1].id, orphan2Text)) }))!.id));
  check("sweep ignores non-message-anchored item", !listedIds.has(noteItem.id));

  // An action item with no reminder (no due date) must still be undoable.
  const bare = { ...plan, actionItems: [{ text: "Think about the intro", owedBy: null, interactionId: msgs[0].id, reminder: null }], facts: [], closeActionItemIds: [] };
  const rBare = await applyDigestPlan({ userId: USER, runId: run.id, contactId: c.id, window, validated: { ...validated, facts: [] }, plan: bare });
  check("reminder-less item created", rBare.actionItemsCreated === 1 && rBare.remindersCreated === 0, JSON.stringify(rBare));

  // Undo: pending reminders dismissed, open action items removed, run undone.
  const undo = await undoRelationshipRun(USER, run.id);
  check("undo dismisses pending reminders", undo.remindersDismissed === 1, JSON.stringify(undo));
  check("undo removes open action items (incl. reminder-less and crash orphan)", undo.actionItemsRemoved === 4, JSON.stringify(undo));
  const after = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run.id) });
  check("run marked undone", after?.status === "undone");
  const left = await db.query.actionItems.findMany({ where: and(eq(actionItems.contactId, c.id), eq(actionItems.status, "open")) });
  check("no open engine action items left; note item survives", left.length === 1 && left[0].id === noteItem.id, String(left.length));

  // The run's batch was undone or deleted out from under it: the next apply gets a fresh one.
  const [run2] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  const b1 = await ensureRunNoteBatch(USER, run2.id);
  check("ensureRunNoteBatch is stable", (await ensureRunNoteBatch(USER, run2.id)) === b1);
  await undoNoteBatchForUser(USER, b1);
  const b2 = await ensureRunNoteBatch(USER, run2.id);
  const b2Row = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, b2) });
  const run2Row = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run2.id) });
  check("undone batch → fresh saved batch stored on the run", b2 !== b1 && b2Row?.status === "saved" && run2Row?.noteBatchId === b2);
  await db.delete(noteBatches).where(eq(noteBatches.id, b2));
  const b3 = await ensureRunNoteBatch(USER, run2.id);
  check("deleted batch → fresh batch", b3 !== b2 && Boolean(await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, b3) })));

  await reset();
  console.log("\nsmoke-relationship-apply: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
