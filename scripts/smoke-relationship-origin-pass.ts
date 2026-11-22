/**
 * The one-time origin pass: which already-read contacts are owed a look at how you met, what
 * that look reads (the opening of the thread plus the LinkedIn signals), and that claiming is
 * exclusive.
 *
 * Run: npx tsx scripts/smoke-relationship-origin-pass.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-origin";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-origin";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, reminders, userSettings } from "../src/db/schema";
import type { BatchRequest, submitAiBatch } from "../src/lib/ai-batch";
import { estimateCostMicros } from "../src/lib/ai-pricing";
import { advanceWatermarkOnly, applyDigestPlan, undoRelationshipRun } from "../src/lib/relationship-engine/apply";
import { DIGEST_MAX_OUTPUT_TOKENS } from "../src/lib/relationship-engine/extract";
import { pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import {
  ORIGIN_CHECKED,
  ORIGIN_TYPICAL_OUTPUT_TOKENS,
  applyOriginBatch,
  buildOriginWindow,
  claimOriginContacts,
  loadOriginWindows,
  originPassEstimate,
  originPendingCount,
  previewOriginPass,
  releaseOriginBatch,
  runOriginPass,
  usersWithOriginWork,
  type OriginBatchPayload,
} from "../src/lib/relationship-engine/origin-pass";
import { planDigestWrites } from "../src/lib/relationship-engine/rules";
import type { ValidatedDigest, WindowMessage } from "../src/lib/relationship-engine/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-origin-user";
const OTHER = "smoke-origin-other";
const T = new Date("2023-03-01T12:00:00.000Z");
const NOW = new Date();

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    for (const t of [relationshipDigests, relationshipRuns, reminders, actionItems, noteBatches, interactions, contacts, userSettings]) await db.delete(t).where(eq(t.userId, u));
    await ensureUserSettings(u);
  }
}

function pure() {
  console.log("the window");
  const day = (n: number) => new Date(Date.UTC(2022, 8, 17 + n, 12));
  const msg = (id: string, at: Date, speaker: string, text: string): WindowMessage => ({ interactionId: id, at, direction: null, speaker, text });
  const thread = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, day(i), "Maya", "x".repeat(200)));
  const invitation = msg("inv", new Date("2022-09-01T12:00:00Z"), "Me", "Hi Maya, we met at HackNC");
  const recommendation = msg("rec", new Date("2025-01-01T12:00:00Z"), "Maya", "A great teammate.");
  const w = buildOriginWindow("c", thread, [recommendation, invitation])!;
  const lines = w.text.split("\n");
  check("the window is bounded", w.text.length <= 6_000 + 2 * 1_000 + 64, String(w.text.length));
  check("it opens with the oldest signal", lines[0].startsWith("[2022-09-01 Me]"), lines[0].slice(0, 40));
  check("it ends with the newest", lines[lines.length - 1].startsWith("[2025-01-01"), lines[lines.length - 1].slice(0, 40));
  check("the opening of the thread is in, its end is not", w.messages.some((m) => m.interactionId === "m0") && !w.messages.some((m) => m.interactionId === "m99"));
  check("nothing is recorded as cut", w.truncatedBefore === null);

  const long = buildOriginWindow("c", [], [msg("r", day(0), "Maya", "y".repeat(5_000))])!;
  check("a long recommendation is clipped to 1,000 characters", long.messages[0].text.length === 1_000);
  const many = buildOriginWindow("c", [], Array.from({ length: 12 }, (_, i) => msg(`s${i}`, day(i), "Me", `note ${i}`)))!;
  check("at most 10 signals", many.messages.length === 10);
  check("nothing to read is no window", buildOriginWindow("c", [], []) === null);
}

function estimate() {
  console.log("\nthe cost estimate");
  const M = "gemini-3.5-flash";
  const prompts = [{ system: "s".repeat(3_000), user: "u".repeat(1_000) }, { system: "s".repeat(3_000), user: "u".repeat(1_000) }];
  const e = originPassEstimate(prompts, M);
  check("two prompts of 8,000 characters are a million input tokens per 1,000", e.contacts === 2 && e.inputTokensPer1000 === 1_000_000, JSON.stringify(e));
  check("typical output is 400 tokens each", ORIGIN_TYPICAL_OUTPUT_TOKENS === 400 && e.outputTokensPer1000 === 400_000);
  check("priced at the batch rate", e.microsPer1000 !== null && e.microsPer1000 === estimateCostMicros({ model: M, inputTokens: 1_000_000, outputTokens: 400_000, batch: true }), String(e.microsPer1000));
  check("the worst case is every answer at the output cap", e.microsPer1000Max === estimateCostMicros({ model: M, inputTokens: 1_000_000, outputTokens: 1_000 * DIGEST_MAX_OUTPUT_TOKENS, batch: true }) && DIGEST_MAX_OUTPUT_TOKENS === 2_000);
  const none = originPassEstimate([], M);
  check("nothing to send costs nothing", none.contacts === 0 && none.microsPer1000 === 0 && none.microsPer1000Max === 0, JSON.stringify(none));
  check("an unpriced model has no cost, not a wrong one", originPassEstimate(prompts, "totally-made-up").microsPer1000 === null);
}

async function main() {
  pure();
  estimate();
  await reset();
  const db = await getDb();

  console.log("\nwho is owed");
  const OPENING = ["Great meeting you at HackNC!", "Likewise, let us keep in touch about the robotics project", "Sounds good, talk soon about the project"];
  const person = async (userId: string, name: string, digest: Partial<typeof relationshipDigests.$inferInsert> | null, texts: string[] = OPENING) => {
    const [c] = await db.insert(contacts).values({ userId, fullName: name, source: "linkedin", howMet: "LinkedIn connection", metContext: "online" }).returning();
    const msgs = await db.insert(interactions).values(texts.map((rawNotes, i) => ({
      userId, contactId: c.id, interactionType: "linkedin_message", interactionDate: new Date(T.getTime() - (texts.length - i) * 86_400_000), source: "linkedin_messages",
      externalId: `li-msg:${name}:${i}`, rawNotes, topics: [], direction: i % 2 ? ("out" as const) : ("in" as const),
    }))).returning();
    const lastMsg = msgs[msgs.length - 1];
    await db.update(interactions).set({ interactionDate: T }).where(eq(interactions.id, lastMsg.id));
    if (digest) {
      await db.insert(relationshipDigests).values({
        contactId: c.id, userId, summary: "old summary", messageCount: 3, sources: ["linkedin"], watermarkAt: T, watermarkInteractionId: lastMsg.id, ...digest,
      });
    }
    return { id: c.id, msgs };
  };
  const A = await person(USER, "Maya A", {});
  await db.insert(interactions).values([
    { userId: USER, contactId: A.id, interactionType: "linkedin_message", interactionDate: new Date(T.getTime() + 86_400_000), source: "linkedin_messages", externalId: "li-msg:after", rawNotes: "AFTER THE WATERMARK can you send the deck by Friday", topics: [], direction: "in" as const },
    { userId: USER, contactId: A.id, interactionType: "reach_out", interactionDate: new Date("2022-09-01T12:00:00Z"), source: "linkedin_export", externalId: `li-export:invitation_sent:a:${A.id}`, rawNotes: "Hi Maya, loved your robotics talk", topics: [] },
  ]);
  const origin = { text: "Met at a talk", date: null, precision: null, context: null, excerpt: "x", interactionId: A.msgs[0].id, runId: randomUUID(), replaced: null };
  const B = await person(USER, "Has Origin B", { origin });
  const C = await person(USER, "Checked C", { sources: ["linkedin", ORIGIN_CHECKED] });
  const D = await person(USER, "Unread D", { watermarkAt: null, watermarkInteractionId: null });
  const E = await person(OTHER, "Other E", {});

  check("one contact is owed", (await originPendingCount(USER)) === 1);
  check("both users have work", (await usersWithOriginWork(10, null)).sort().join() === [OTHER, USER].sort().join());
  check("a scope narrows the users", (await usersWithOriginWork(10, [USER])).join() === USER);
  check("an empty scope is nobody", (await usersWithOriginWork(10, [])).length === 0);

  const windows = await loadOriginWindows(USER, [A.id]);
  const text = windows.get(A.id)?.text ?? "";
  check("the window has the opening and the invitation", text.includes("HackNC") && text.includes("loved your robotics talk"), text);
  check("…and nothing past the watermark", !text.includes("AFTER THE WATERMARK"));

  const C1 = randomUUID();
  const claimed = await claimOriginContacts(USER, 100, C1);
  check("the owed contact is claimed", claimed.join() === A.id, claimed.join());
  check("origin set, already checked, never read and another user's are never claimed", ![B.id, C.id, D.id, E.id].some((id) => claimed.includes(id)));
  check("a second claim gets nothing", (await claimOriginContacts(USER, 100, randomUUID())).length === 0);
  const a1 = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, A.id) });
  check("the claim is the in-flight marker", a1?.batchJobId === C1 && (a1.batchPendingUntil?.getTime() ?? 0) > Date.now());
  check("the claim moved nothing else", a1?.watermarkAt?.getTime() === T.getTime() && a1.messageCount === 3 && a1.summary === "old summary");
  check("a claimed contact is no longer counted", (await originPendingCount(USER)) === 0);

  console.log("\na deep first pass marks the contact checked");
  const [run] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  const fresh = async (name: string) => {
    const p = await person(USER, name, null);
    return { ...p, window: (await loadMessageWindows(USER, [p.id], { deepRead: true })).get(p.id)! };
  };
  const validated: ValidatedDigest = { whatTheyDo: null, workingOn: null, summary: "s", topics: [], facts: [], dated: [], undated: [], closedKeys: [], jobChange: null, origin: null, relationship: null, events: [] };
  const apply = async (name: string, deepRead: boolean) => {
    const p = await fresh(name);
    const plan = planDigestWrites(validated, { contactId: p.id, contactFirstName: "X", now: NOW, closeness: null, cadenceDays: null, existingThreads: [], remindersLeftInRun: 25 });
    await applyDigestPlan({ userId: USER, runId: run.id, contactId: p.id, window: p.window, validated, plan, deepRead });
    return (await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, p.id) }))!.sources;
  };
  check("applyDigestPlan with the deep read marks it", (await apply("Deep F", true)).includes(ORIGIN_CHECKED));
  check("…and without it does not", !(await apply("Plain G", false)).includes(ORIGIN_CHECKED));
  const H = await fresh("Trivial H");
  await advanceWatermarkOnly(USER, run.id, H.window, { deepRead: true });
  check("a trivial deep first pass marks it too", Boolean((await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, H.id) }))?.sources.includes(ORIGIN_CHECKED)));
  check("only the one read without the deep read is owed afterwards", (await originPendingCount(USER)) === 1);
  // A later deep pass over a contact first read before the deep read must not mark it: its opening was never read for origin.
  await db.update(relationshipDigests).set({ batchJobId: null, batchPendingUntil: null }).where(eq(relationshipDigests.contactId, A.id));
  const aWindow = (await loadMessageWindows(USER, [A.id], { deepRead: true })).get(A.id)!;
  await advanceWatermarkOnly(USER, run.id, aWindow, { deepRead: true });
  check("a later pass over an old contact leaves it owed", (await originPendingCount(USER)) === 2);

  console.log("\nrunning it");
  await reset();
  const digestOf = async (id: string) => (await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, id) }))!;
  const contactOf = async (id: string) => (await db.query.contacts.findFirst({ where: eq(contacts.id, id) }))!;
  const runsOf = () => db.query.relationshipRuns.findMany({ where: eq(relationshipRuns.userId, USER) });
  const calls: Array<{ op: string; requests: BatchRequest[]; payload: OriginBatchPayload }> = [];
  const stub = (jobId: string | null) =>
    (async (_user: string, op: string, requests: BatchRequest[], payload: Record<string, unknown>) => {
      calls.push({ op, requests, payload: payload as unknown as OriginBatchPayload });
      return jobId;
    }) as typeof submitAiBatch;
  const outcome = (customId: string, text: string | null) => ({ customId, text, error: text ? null : "failed", usage: { inputTokens: 0, outputTokens: 0 } as never });
  const ANSWER = JSON.stringify({
    summary: "IGNORED",
    facts: [{ text: "IGNORED FACT", excerpt: "Great meeting you at HackNC!" }],
    origin: { text: "Met at HackNC", date: "2022-09-17", context: "event", excerpt: "Great meeting you at HackNC!" },
    relationship: { kind: "classmate", excerpt: "Great meeting you at HackNC!" },
    events: [],
  });

  const P = await person(USER, "Maya P", {});
  await db.insert(interactions).values({ userId: USER, contactId: P.id, interactionType: "linkedin_message", interactionDate: new Date(T.getTime() + 86_400_000), source: "linkedin_messages", externalId: "li-msg:p-after", rawNotes: "can you send the deck by Friday for the board review", topics: [], direction: "in" as const });
  const before = await digestOf(P.id);

  const preview = await previewOriginPass(USER);
  check("the preview lists what would be sent, and claims nothing", preview.owed === 1 && preview.sampled === 1 && preview.trivial === 0 && preview.prompts.length === 1 && preview.prompts[0].user.includes("HackNC") && (await digestOf(P.id)).batchJobId === null, JSON.stringify({ ...preview, prompts: preview.prompts.length }));

  const off = await runOriginPass(USER, { deepRead: false, submit: stub(randomUUID()) });
  check("deep read off: nothing is claimed or sent", JSON.stringify(off) === JSON.stringify({ claimed: 0, trivial: 0, submitted: 0, remaining: 0 }) && calls.length === 0 && (await digestOf(P.id)).batchJobId === null, JSON.stringify(off));

  const none = await runOriginPass(USER, { deepRead: true, submit: stub(null) });
  const afterNone = await digestOf(P.id);
  check("no batch available: nothing submitted, the claim is handed back, no run row", none.submitted === 0 && calls.length === 1 && afterNone.batchJobId === null && afterNone.batchPendingUntil === null && !afterNone.sources.includes(ORIGIN_CHECKED) && (await runsOf()).length === 0, JSON.stringify(none));
  check("…and the contact is still owed", none.remaining === 1);
  calls.length = 0;

  const JOB = randomUUID();
  const ran = await runOriginPass(USER, { deepRead: true, submit: stub(JOB) });
  check("the pass sends exactly the prompt the preview measured", calls[0]?.requests[0]?.user === preview.prompts[0].user && calls[0].requests[0].system === preview.prompts[0].system);
  check("one batch under its own operation", calls.length === 1 && calls[0].op === "relationship.origin" && calls[0].requests.length === 1 && calls[0].requests[0].user.includes("HackNC"));
  check("the same prompt the eval measures (deep read keys asked for)", calls[0].requests[0].system.includes("origin") && calls[0].requests[0].maxOutputTokens === DIGEST_MAX_OUTPUT_TOKENS);
  check("the pass reports it", JSON.stringify(ran) === JSON.stringify({ claimed: 1, trivial: 0, submitted: 1, remaining: 0 }), JSON.stringify(ran));
  check("the contact is in flight under the job", (await digestOf(P.id)).batchJobId === JOB);
  const runs = await runsOf();
  check("a finished run row backs the origins", runs.length === 1 && runs[0].status === "done" && runs[0].id === calls[0].payload.runId && runs[0].finishedAt !== null);

  const payloadP = calls[0].payload;
  await applyOriginBatch({ id: JOB, userId: USER, payload: payloadP as never }, [outcome(payloadP.items[0].customId, ANSWER)]);
  const after = await digestOf(P.id);
  check("origin and kind are written", after.origin?.text === "Met at HackNC" && after.origin.precision === "day" && after.relationship?.kind === "classmate", JSON.stringify(after.origin));
  check("the contact is marked checked and no longer in flight", after.sources.includes(ORIGIN_CHECKED) && after.batchJobId === null && after.batchPendingUntil === null);
  check("the watermark, count, attempts, updated_at and summary are untouched",
    after.watermarkAt?.getTime() === T.getTime() && after.watermarkInteractionId === before.watermarkInteractionId && after.messageCount === before.messageCount &&
    after.attempts === 0 && after.updatedAt.getTime() === before.updatedAt.getTime() && after.summary === "old summary" && after.runId === before.runId);
  const pContact = await contactOf(P.id);
  check("no fact is written", !(pContact.keyFacts ?? []).includes("IGNORED FACT"));
  check("how you met replaces the import label", pContact.howMet === "Met at HackNC", String(pContact.howMet));
  check("the newer message still waits for the normal pass", (await pendingRelationshipContactCount(USER)) === 1);
  check("no reminders or action items", (await db.query.reminders.findMany({ where: eq(reminders.userId, USER) })).length === 0 && (await db.query.actionItems.findMany({ where: eq(actionItems.userId, USER) })).length === 0);

  const Q = await person(USER, "Typed Q", {});
  await db.update(contacts).set({ howMet: "At my sister's wedding", fieldSources: { met: { s: "user", t: new Date().toISOString() } } as never }).where(eq(contacts.id, Q.id));
  const R = await person(USER, "Removed R", { relationship: { kind: "friend", excerpt: "x", interactionId: P.msgs[0].id, removed: true } });
  const N = await person(USER, "Garbled N", {});
  const Z = await person(USER, "Failed Z", {});
  calls.length = 0;
  const JOB2 = randomUUID();
  const ran2 = await runOriginPass(USER, { deepRead: true, submit: stub(JOB2) });
  check("four more go out in one batch", ran2.submitted === 4 && calls[0].requests.length === 4, JSON.stringify(ran2));
  const payload2 = calls[0].payload;
  const customOf = (id: string) => payload2.items.find((i) => i.contactId === id)!.customId;
  await applyOriginBatch({ id: JOB2, userId: USER, payload: payload2 as never }, [outcome(customOf(Q.id), ANSWER), outcome(customOf(R.id), ANSWER), outcome(customOf(N.id), "not json"), outcome(customOf(Z.id), null)]);
  const q = await digestOf(Q.id);
  check("what the person typed stays; the digest keeps the origin with nothing replaced", (await contactOf(Q.id)).howMet === "At my sister's wedding" && q.origin?.text === "Met at HackNC" && q.origin.replaced === null);
  const r = await digestOf(R.id);
  check("a removed kind stays removed", r.relationship?.removed === true && r.relationship.kind === "friend");
  for (const [label, id] of [["an answer that does not parse", N.id], ["a request that failed", Z.id]] as const) {
    const d = await digestOf(id);
    check(`${label} still marks the contact checked, once`, d.sources.includes(ORIGIN_CHECKED) && d.origin === null && d.attempts === 0 && d.batchJobId === null);
  }
  check("nothing is owed now", (await originPendingCount(USER)) === 0);

  const S = await person(USER, "Stale S", {});
  calls.length = 0;
  const JOB3 = randomUUID();
  await runOriginPass(USER, { deepRead: true, submit: stub(JOB3) });
  await releaseOriginBatch({ id: JOB3, userId: USER });
  const s1 = await digestOf(S.id);
  check("a batch that never answers hands its contacts back unmarked", s1.batchJobId === null && !s1.sources.includes(ORIGIN_CHECKED));
  check("…so they are claimed again", (await claimOriginContacts(USER, 10, randomUUID())).join() === S.id);
  await db.update(relationshipDigests).set({ batchJobId: null, batchPendingUntil: null, sources: ["linkedin", ORIGIN_CHECKED] }).where(eq(relationshipDigests.contactId, S.id));

  const V = await person(USER, "Trivial V", {}, ["Thanks for connecting!"]);
  calls.length = 0;
  const ran3 = await runOriginPass(USER, { deepRead: true, submit: stub(randomUUID()) });
  const v = await digestOf(V.id);
  check("a thread with nothing in it costs no model call and is marked", ran3.trivial === 1 && ran3.submitted === 0 && calls.length === 0 && v.sources.includes(ORIGIN_CHECKED) && v.batchJobId === null, JSON.stringify(ran3));

  const L1 = await person(USER, "Limit One", {});
  const L2 = await person(USER, "Limit Two", {});
  calls.length = 0;
  const capped = await runOriginPass(USER, { deepRead: true, limit: 1, submit: stub(randomUUID()) });
  check("limit caps the contacts in all", capped.claimed === 1 && capped.submitted === 1 && capped.remaining === 1 && calls[0].requests.length === 1, JSON.stringify(capped));
  void L1; void L2;

  await undoRelationshipRun(USER, payloadP.runId);
  const undone = await digestOf(P.id);
  check("undoing the origin run puts how you met back and takes the origin off", (await contactOf(P.id)).howMet === "LinkedIn connection" && undone.origin === null);
  check("…the contact is not read again", undone.sources.includes(ORIGIN_CHECKED));

  await reset();
  console.log("\nsmoke-relationship-origin-pass: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
