/**
 * The runner end to end with the model and the batch API stubbed: switch off, inline for the
 * first 25, batch after, batch-unavailable fallback, trivial skips, per-contact failures and
 * the 3-attempt park, key errors → waiting_key, one run per user, and finishing.
 *
 * Run: npx tsx scripts/smoke-relationship-runner.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-runner";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-runner";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems, contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, reminders, userSettings,
} from "../src/db/schema";
import { AiAccessError } from "../src/lib/ai-access";
import { INLINE_PER_RUN, runRelationshipPass, applyRelationshipBatch, type RelationshipBatchPayload } from "../src/lib/relationship-engine/runner";
import { claimPendingContacts, pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import type { RelationshipDigestAnswer } from "../src/lib/relationship-engine/extract";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-rel-runner-user";
const JOB = "11111111-1111-4111-8111-111111111111";
const JOB2 = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB = "33333333-3333-4333-8333-333333333333";

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

async function seedContacts(n: number, body: (i: number) => string) {
  const db = await getDb();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [c] = await db.insert(contacts).values({ userId: USER, fullName: `Person ${i}`, source: "linkedin_messages" }).returning();
    await db.insert(interactions).values([
      { userId: USER, contactId: c.id, interactionType: "linkedin_message", interactionDate: new Date(Date.now() - (i + 1) * 3_600_000), source: "linkedin_messages", externalId: `li-msg:r${i}:1`, rawNotes: body(i), topics: [], direction: "in" as const },
      { userId: USER, contactId: c.id, interactionType: "linkedin_message", interactionDate: new Date(Date.now() - (i + 1) * 3_600_000 + 60_000), source: "linkedin_messages", externalId: `li-msg:r${i}:2`, rawNotes: "Sounds good, let's talk through the fundraising plan next month in detail.", topics: [], direction: "out" as const },
    ]);
    ids.push(c.id);
  }
  return ids;
}

const ANSWER: RelationshipDigestAnswer = {
  what_they_do: "Founder", working_on: null, job_change: null, summary: "Talked fundraising.", topics: ["fundraising"],
  facts: [], commitments: [], implied: [], closed: [],
};
const REAL = (i: number) => `Hey, it's Person ${i}. We're raising a seed round and I'd love your take on our deck and investor list. We are also hiring a first designer and I would value your read on candidates and on how we should structure the offer.`;

async function main() {
  await reset();
  const db = await getDb();

  // Switch off → nothing runs.
  await seedContacts(2, REAL);
  await db.update(userSettings).set({ relationshipEngineEnabled: 0 }).where(eq(userSettings.userId, USER));
  let res = await runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null });
  check("disabled → no work", res.status === "disabled" && res.processed === 0);
  await db.update(userSettings).set({ relationshipEngineEnabled: 1 }).where(eq(userSettings.userId, USER));

  // Key error → waiting_key, attempts NOT burned.
  res = await runRelationshipPass(USER, {
    extract: async () => { throw new AiAccessError("key_required"); },
    submit: async () => null,
  });
  check("key error → waiting_key", res.status === "waiting_key", JSON.stringify(res));
  const d0 = await db.query.relationshipDigests.findMany({ where: eq(relationshipDigests.userId, USER) });
  check("key error burns no attempts", d0.every((d) => d.attempts === 0));

  // Recovers: both processed inline, run done.
  res = await runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null });
  check("inline processes both", res.processed === 2 && res.remaining === 0, JSON.stringify(res));
  check("run done", res.status === "done");
  const runs = await db.query.relationshipRuns.findMany({ where: eq(relationshipRuns.userId, USER) });
  check("one run reused across passes", runs.length === 1 && runs[0].status === "done");

  // Inline cap: 27 contacts, a new run → 25 inline, 2 submitted to batch.
  await reset();
  await seedContacts(27, REAL);
  let submittedRequests = 0;
  let submitted = null as RelationshipBatchPayload | null;
  res = await runRelationshipPass(USER, {
    extract: async () => ANSWER,
    submit: async (_u, op, reqs, p) => {
      submittedRequests += reqs.length;
      submitted = p as unknown as RelationshipBatchPayload;
      return op === "relationship.digest" ? JOB : null;
    },
  });
  check("25 inline", res.processed === 25, JSON.stringify(res));
  check("2 submitted", res.submitted === 2 && submittedRequests === 2);
  check("batched contacts leave pending set", (await pendingRelationshipContactCount(USER)) === 0);
  check("run still running while batch out", res.status === "running");

  // Batch answers arrive → applied, run finishes on the next pass.
  const out = await db.query.relationshipDigests.findMany({ where: eq(relationshipDigests.batchJobId, JOB) });
  check("payload carries the window bound", submitted !== null && out.length === 2 && submitted!.items.every((it) => it.lastAt && it.lastInteractionId));
  const payload = submitted!;
  await applyRelationshipBatch(
    { id: JOB, userId: USER, payload } as never,
    payload.items.map((it) => ({ customId: it.customId, text: JSON.stringify(ANSWER), error: null, usage: {} as never })),
    async () => {}
  );
  const applied = await db.query.relationshipDigests.findMany({ where: eq(relationshipDigests.userId, USER) });
  check("batch applied: all have summaries", applied.every((d) => d.summary === "Talked fundraising."));
  check("batch applied: none still out", applied.every((d) => d.batchJobId === null));
  res = await runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null });
  check("run finishes after batch", res.status === "done");

  // The applier judges the answer against what the model read: a message that arrives while
  // the batch is out stays pending, and a job that no longer owns the contact applies nothing.
  await reset();
  await seedContacts(27, REAL);
  submitted = null;
  await runRelationshipPass(USER, {
    extract: async () => ANSWER,
    submit: async (_u, _op, _reqs, p) => { submitted = p as unknown as RelationshipBatchPayload; return JOB2; },
  });
  const p2 = submitted!;
  const [late, stale] = p2.items;
  await db.insert(interactions).values({
    userId: USER, contactId: late.contactId, interactionType: "linkedin_message", interactionDate: new Date(), source: "linkedin_messages",
    externalId: "li-msg:late", rawNotes: "One more thing: can you also look at our hiring plan before Friday?", topics: [], direction: "in" as const,
  });
  await db.update(relationshipDigests).set({ batchJobId: OTHER_JOB }).where(eq(relationshipDigests.contactId, stale.contactId));
  await applyRelationshipBatch(
    { id: JOB2, userId: USER, payload: p2 } as never,
    p2.items.map((it) => ({ customId: it.customId, text: JSON.stringify(ANSWER), error: null, usage: {} as never })),
    async () => {}
  );
  const lateRow = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, late.contactId) });
  check("late message: applied up to the bound", lateRow?.summary === "Talked fundraising." && lateRow.watermarkInteractionId === late.lastInteractionId && lateRow.watermarkAt?.getTime() === new Date(late.lastAt).getTime(), JSON.stringify(lateRow));
  check("late message: contact pending again", (await claimPendingContacts(USER, 50, new Set())).includes(late.contactId));
  const staleRow = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, stale.contactId) });
  check("stale job: nothing applied", staleRow?.summary == null && staleRow?.watermarkAt == null, JSON.stringify(staleRow));
  check("stale job: other job's marker untouched", staleRow?.batchJobId === OTHER_JOB);

  // A failed batch item counts against the run, like an inline failure.
  await reset();
  await seedContacts(27, REAL);
  submitted = null;
  await runRelationshipPass(USER, {
    extract: async () => ANSWER,
    submit: async (_u, _op, _reqs, p) => { submitted = p as unknown as RelationshipBatchPayload; return JOB; },
  });
  const p3 = submitted!;
  await applyRelationshipBatch(
    { id: JOB, userId: USER, payload: p3 } as never,
    p3.items.map((it) => ({ customId: it.customId, text: null, error: "boom", usage: {} as never })),
    async () => {}
  );
  const failedRun = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, p3.runId) });
  check("batch failures counted on the run", failedRun?.failed === 2, JSON.stringify(failedRun));

  // Batch unavailable → falls back inline (new run past the inline cap).
  await reset();
  await seedContacts(27, REAL);
  res = await runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null });
  check("no batch → all 27 inline", res.processed === 27 && res.submitted === 0, JSON.stringify(res));

  // Trivial threads skipped without a model call.
  await reset();
  const db2 = await getDb();
  const [t] = await db2.insert(contacts).values({ userId: USER, fullName: "Trivial", source: "linkedin_messages" }).returning();
  await db2.insert(interactions).values({ userId: USER, contactId: t.id, interactionType: "linkedin_message", interactionDate: new Date(), source: "linkedin_messages", externalId: "li-msg:triv", rawNotes: "Thanks for connecting!", topics: [] });
  let calls = 0;
  res = await runRelationshipPass(USER, { extract: async () => { calls += 1; return ANSWER; }, submit: async () => null });
  check("trivial: skipped, no call", res.skipped === 1 && calls === 0);
  check("trivial: no longer pending", (await pendingRelationshipContactCount(USER)) === 0);

  // Per-contact failure → attempts; three failures park the contact.
  await reset();
  await seedContacts(1, REAL);
  for (let i = 0; i < 3; i++) {
    await runRelationshipPass(USER, { extract: async () => { throw new Error("bad json"); }, submit: async () => null });
  }
  const parked = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.userId, USER) });
  check("three failures → attempts 3", parked?.attempts === 3 && parked.lastError === "bad json");
  check("parked contact not pending", (await pendingRelationshipContactCount(USER)) === 0);

  // Batch unavailable + slow extract + short budget → the fallback respects the budget.
  await reset();
  await seedContacts(30, REAL);
  const [seedRun] = await db.insert(relationshipRuns).values({ userId: USER, status: "queued", inlineUsed: INLINE_PER_RUN }).returning();
  res = await runRelationshipPass(USER, {
    budgetMs: 400,
    extract: async () => { await new Promise((r) => setTimeout(r, 150)); return ANSWER; },
    submit: async () => null,
  });
  check("fallback stops at the budget", res.status === "running" && res.remaining > 0 && res.processed < 30, JSON.stringify(res));
  const after = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, seedRun.id) });
  check("lease released after budget stop", after?.claimToken === null && after?.leaseUntil === null);

  // Two concurrent first passes → one run row.
  await reset();
  await seedContacts(3, REAL);
  const pair = await Promise.all([
    runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null }),
    runRelationshipPass(USER, { extract: async () => ANSWER, submit: async () => null }),
  ]);
  const rows = await db.query.relationshipRuns.findMany({ where: eq(relationshipRuns.userId, USER) });
  check("concurrent passes → one run row", rows.length === 1, `${rows.length} rows, ${JSON.stringify(pair)}`);

  await reset();
  console.log("\nsmoke-relationship-runner: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
