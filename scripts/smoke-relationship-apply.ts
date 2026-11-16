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
import { advanceWatermarkOnly, applyDigestPlan, ensureRunNoteBatch, loadPreviousDigest, undoRelationshipRun } from "../src/lib/relationship-engine/apply";
import { stableHash } from "../src/lib/linkedin-timeline-events";
import { undoNoteBatchForUser } from "../src/lib/note-batch-save";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import { planDigestWrites } from "../src/lib/relationship-engine/rules";
import type { ValidatedDigest } from "../src/lib/relationship-engine/types";
import { pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import { actionItemHash } from "../src/lib/action-items";
import { ensureUserSettings } from "../src/lib/user-settings";
import { updateContactForUser } from "../src/lib/contact-writes";

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

  // OPEN ITEMS carries the 20 most recent open action items, deterministically.
  const [c2] = await db.insert(contacts).values({ userId: USER, fullName: "Many Items", source: "linkedin_messages" }).returning();
  await db.insert(actionItems).values(
    Array.from({ length: 21 }, (_, i) => ({
      userId: USER, contactId: c2.id, interactionId: msgs[0].id, text: `Item ${i}`, position: i, status: "open" as const,
      itemHash: actionItemHash(msgs[0].id, `many-${i}`), owedBy: null, createdAt: new Date(NOW.getTime() - (21 - i) * 86_400_000),
    }))
  );
  const many = await loadPreviousDigest(USER, c2.id);
  const texts = many.previous!.openItems.map((o) => o.text);
  check("open items: 20, newest kept, oldest dropped", texts.length === 20 && !texts.includes("Item 0") && texts.includes("Item 20"), JSON.stringify(texts));

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

  console.log("\ndeep read: how you met");
  await reset();
  const [run3] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  const connected = new Date("2023-10-03T12:00:00Z");
  async function person(name: string, howMet: string | null, dateMet: Date | null) {
    const [p] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: name, source: "linkedin", howMet, dateMet, metContext: howMet ? "online" : null, firstInteractionAt: dateMet })
      .returning();
    const [m] = await db
      .insert(interactions)
      .values({ userId: USER, contactId: p.id, interactionType: "linkedin_message", interactionDate: new Date("2022-09-20T15:00:00Z"), source: "linkedin_messages", externalId: `li-msg:${name}`, rawNotes: "so good meeting you at HackNC last weekend!", topics: [], direction: "in" as const })
      .returning();
    const w = (await loadMessageWindows(USER, [p.id], { deepRead: true })).get(p.id)!;
    return { id: p.id, msg: m, window: w };
  }
  const deepValidated = (interactionId: string, over: Partial<ValidatedDigest> = {}): ValidatedDigest => ({
    whatTheyDo: null, workingOn: null, summary: "Met at HackNC.", topics: [], facts: [], dated: [], undated: [], closedKeys: [], jobChange: null,
    origin: { text: "Met at HackNC", date: "2022-09-01", precision: "month", context: "event", excerpt: "so good meeting you at HackNC", interactionId },
    relationship: { kind: "friend", excerpt: "so good meeting you at HackNC", interactionId },
    events: [],
    ...over,
  });
  const planOf = (v: ValidatedDigest, contactId: string) =>
    planDigestWrites(v, { contactId, contactFirstName: "X", now: NOW, closeness: null, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25 });
  type P = Awaited<ReturnType<typeof person>>;
  const deepApply = (p: P, v: ValidatedDigest = deepValidated(p.msg.id), deepRead = true) =>
    applyDigestPlan({ userId: USER, runId: run3.id, contactId: p.id, window: p.window, validated: v, plan: planOf(v, p.id), deepRead });
  const get = async (id: string) => (await db.query.contacts.findFirst({ where: eq(contacts.id, id) }))!;
  const dig = (id: string) => db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, id) });
  const asUser = { by: "user" as const, skipRevalidate: true, skipSummary: true, skipCloseness: true };

  const A = await person("Ada A", "LinkedIn connection", connected);
  const B = await person("Ben B", "Met at Priya's dinner", null);
  const C = await person("Cy C", "LinkedIn connection", connected);
  // A real edit of the met fields (here the date) locks them; saving the same values does not (F).
  await updateContactForUser(USER, C.id, { dateMet: "2023-11-11" }, asUser);
  const D = await person("Di D", "LinkedIn connection", connected);
  const OFF = await person("Off O", "LinkedIn connection", connected);
  const R = await person("Ro R", "LinkedIn connection", connected);
  await db.insert(relationshipDigests).values({ contactId: R.id, userId: USER, relationship: { kind: "recruiter", excerpt: "x y z", interactionId: R.msg.id, removed: true } });
  // F: a form save that leaves the met fields as they were (the form always sends them).
  const F = await person("Fi F", "LinkedIn connection", connected);
  await updateContactForUser(USER, F.id, { howMet: "LinkedIn connection", dateMet: "2023-10-03", metContext: "online", phone: "+1 555 0100" }, asUser);
  // G: no how-met text, but a date and context someone typed at creation (no stamp exists).
  const G = await person("Gi G", null, null);
  await db.update(contacts).set({ dateMet: new Date("2021-05-05T12:00:00Z"), metContext: "school" }).where(eq(contacts.id, G.id));
  // H: written by the run, then the user corrects only the date.
  const H = await person("Hal H", "LinkedIn connection", connected);
  for (const p of [A, B, C, D, R, F, H]) await deepApply(p);
  await deepApply(G, deepValidated(G.msg.id, { origin: { text: "Met at HackNC", date: "2022-09-17", precision: "day", context: "event", excerpt: "so good meeting you at HackNC", interactionId: G.msg.id } }));
  await deepApply(OFF, deepValidated(OFF.msg.id), false);

  const a = await get(A.id);
  check("an import label is replaced by the quoted origin", a.howMet === "Met at HackNC" && a.metContext === "event", `${a.howMet}/${a.metContext}`);
  check("a month origin never writes the day-level date_met", a.dateMet?.toISOString().startsWith("2023-10-03") === true, a.dateMet?.toISOString());
  check("a month origin widens first contact to that month's end", a.firstInteractionAt! <= new Date("2022-09-30T23:59:59.999Z") && a.firstInteractionAt! >= new Date("2022-09-30T00:00:00Z"), a.firstInteractionAt?.toISOString());
  const dA = await dig(A.id);
  check("the digest keeps the origin, its run and what it replaced", dA?.origin?.text === "Met at HackNC" && dA.origin.runId === run3.id && dA.origin.replaced?.howMet === "LinkedIn connection", JSON.stringify(dA?.origin));
  check("the digest keeps the relationship kind", dA?.relationship?.kind === "friend");
  check("what a capture wrote is never replaced", (await get(B.id)).howMet === "Met at Priya's dinner" && (await dig(B.id))?.origin?.replaced === null);
  check("what the user typed is never replaced", (await get(C.id)).howMet === "LinkedIn connection" && (await dig(C.id))?.origin?.replaced === null);
  check("flag off: no met field changes and no origin stored", (await get(OFF.id)).howMet === "LinkedIn connection" && ((await dig(OFF.id))?.origin ?? null) === null);
  await deepApply(A, deepValidated(A.msg.id, { origin: { text: "Met online", date: null, precision: null, context: "online", excerpt: "so good meeting you at HackNC", interactionId: A.msg.id } }));
  check("a later pass never replaces the first origin", (await dig(A.id))?.origin?.text === "Met at HackNC" && (await get(A.id)).howMet === "Met at HackNC");
  const dR = await dig(R.id);
  check("a removed relationship kind is never set again", dR?.relationship?.removed === true && dR.relationship.kind === "recruiter", JSON.stringify(dR?.relationship));

  check("a form save that changed nothing about how you met does not lock it", (await get(F.id)).howMet === "Met at HackNC");
  const g = await get(G.id);
  check("with no how-met text, a typed date and context are kept", g.howMet === "Met at HackNC" && g.dateMet?.toISOString().startsWith("2021-05-05") === true && g.metContext === "school", `${g.dateMet?.toISOString()}/${g.metContext}`);
  await updateContactForUser(USER, H.id, { dateMet: "2020-01-15" }, asUser);
  await updateContactForUser(USER, D.id, { howMet: "Met at the alumni mixer" }, asUser);
  await undoRelationshipRun(USER, run3.id);
  const a2 = await get(A.id);
  check("Undo restores the import values", a2.howMet === "LinkedIn connection" && a2.metContext === "online" && a2.dateMet?.toISOString().startsWith("2023-10-03") === true, `${a2.howMet}/${a2.metContext}`);
  check("Undo clears the run's origin", ((await dig(A.id))?.origin ?? null) === null);
  check("Undo never undoes the user's later edit", (await get(D.id)).howMet === "Met at the alumni mixer");
  const h2 = await get(H.id);
  check("Undo never undoes a later date-only edit", h2.dateMet?.toISOString().startsWith("2020-01-15") === true && h2.howMet === "Met at HackNC", `${h2.howMet}/${h2.dateMet?.toISOString()}`);
  check("Undo puts first contact back too", (await get(A.id)).firstInteractionAt?.toISOString().startsWith("2023-10-03") === true, (await get(A.id)).firstInteractionAt?.toISOString());
  check("Undo leaves the relationship kind", (await dig(B.id))?.relationship?.kind === "friend");

  console.log("\ndeep read: events and the first reach-out");
  const [run4] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  const timelineOf = async (id: string) =>
    db.query.interactions.findMany({ where: and(eq(interactions.contactId, id), eq(interactions.source, "ai_derived")) });
  const E1 = { type: "meeting" as const, summary: "Coffee at Joe's", day: "2022-09-24", excerpt: "so good meeting you at HackNC", interactionId: "" };
  const applyEvents = (p: P, deepRead = true, runId = run4.id) => {
    const v = deepValidated(p.msg.id, { origin: null, relationship: null, events: [{ ...E1, interactionId: p.msg.id }] });
    return applyDigestPlan({ userId: USER, runId, contactId: p.id, window: p.window, validated: v, plan: planOf(v, p.id), deepRead });
  };
  const EV = await person("Eve E", "LinkedIn connection", connected);
  await applyEvents(EV);
  let tl = await timelineOf(EV.id);
  const meetings = tl.filter((t) => t.interactionType === "meeting");
  check("an event becomes one ai_derived meeting on its day", meetings.length === 1 && meetings[0].interactionDate.toISOString().startsWith("2022-09-24") && meetings[0].aiSummary === "Coffee at Joe's", JSON.stringify(meetings));
  const first80 = "so good meeting you at HackNC last weekend!".slice(0, 80);
  const reach = tl.filter((t) => t.interactionType === "reach_out");
  check("a first pass writes the old reader's reach-out, same id", reach.length === 1 && reach[0].externalId === `li-event:${EV.id}:reach_out:${stableHash(first80)}`, JSON.stringify(reach.map((r) => r.externalId)));
  await applyEvents(EV);
  tl = await timelineOf(EV.id);
  check("applying the same answer twice leaves one of each", tl.filter((t) => t.interactionType === "meeting").length === 1 && tl.filter((t) => t.interactionType === "reach_out").length === 1);

  const OLD = await person("Old O", "LinkedIn connection", connected);
  await db.insert(interactions).values({ userId: USER, contactId: OLD.id, interactionType: "meeting", interactionDate: new Date("2022-09-24T18:00:00Z"), source: "ai_derived", externalId: `li-event:${OLD.id}:meeting:oldhash`, rawNotes: "x", aiSummary: "Coffee", topics: [] });
  await applyEvents(OLD);
  check("an old-reader meeting on the same day blocks a second one", (await timelineOf(OLD.id)).filter((t) => t.interactionType === "meeting").length === 1);

  const ONE = await person("One O", "LinkedIn connection", connected);
  await advanceWatermarkOnly(USER, run4.id, ONE.window, { deepRead: true, firstPass: true });
  check("a trivial one-message thread still gets its reach-out, with no AI call", (await timelineOf(ONE.id)).filter((t) => t.interactionType === "reach_out").length === 1);

  const NOPE = await person("Nope N", "LinkedIn connection", connected);
  await applyEvents(NOPE, false);
  const NOPE2 = await person("Nope Two", "LinkedIn connection", connected);
  await advanceWatermarkOnly(USER, run4.id, NOPE2.window);
  check("flag off writes neither", (await timelineOf(NOPE.id)).length === 0 && (await timelineOf(NOPE2.id)).length === 0);

  await reset();
  console.log("\nsmoke-relationship-apply: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
