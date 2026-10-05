/**
 * Background AI through the providers' Batch APIs (`src/lib/ai-batch.ts`): the submit →
 * poll → apply → clean up loop for all three providers, what happens when a batch fails or
 * the key that submitted it is gone, and the allowance reservation that stops an account
 * from submitting its way past the cap while the bill is still in flight.
 *
 * Local PGlite, stubbed providers — the real SDKs build and parse the requests. Run:
 *   npx tsx scripts/smoke-ai-batch.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiBatchJobs, contacts, interactions, relationshipDigests, relationshipRuns, userSettings, usageEvents } from "../src/db/schema";
import { isNotNull } from "drizzle-orm";
import { encrypt } from "../src/lib/crypto";
import { listPendingBatchJobs, pollAiBatch } from "../src/lib/ai-batch";
import { runAiBatchSweep } from "../src/lib/ai-batch-apply";
import { runLinkedInTimelineBackfill } from "../src/lib/linkedin-timeline-backfill";
import { INLINE_PER_RUN, runRelationshipPass } from "../src/lib/relationship-engine/runner";
import { ensureAllowance, creditPeriodFor, placeHold, getCreditBalance, BATCH_HOLD_TTL_MS } from "../src/lib/credits/ledger";
import { settleBatchJob } from "../src/lib/ai-batch";
import { creditGrants, creditHolds } from "../src/db/schema";

const USER = "smoke-ai-batch-user";
const MANAGED = "smoke-ai-batch-managed";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ----------------------------------------------------------------- stubbed providers -- */

type Provider = "gemini" | "openai" | "anthropic";
/** Flipped by a test to make the next poll report a finished batch. */
let batchDone = false;
/** Flipped to make the provider refuse the submission. */
let refuseSubmit = false;
/** Makes the provider report the batch as failed rather than finished. */
let batchFails = false;
/** Answer with timeline events instead of an enrichment summary. */
let timelineAnswer = false;
let submitted: { provider: Provider; body: unknown } | null = null;
/** Providers hand out a fresh id per batch; the table's unique index expects that. */
let batchSeq = 0;
const deleted: string[] = [];
const TIMELINE_ANSWER = JSON.stringify({
  events: [{ type: "meeting", summary: "Coffee to talk it through", dateHint: "next Tuesday", sourceMessageIndex: 1 }],
});
const DIGEST_ANSWER_OBJ = {
  what_they_do: "Runs the platform team at Larkspur",
  working_on: null,
  job_change: null,
  summary: "You and Ada have been trading notes about her infra team.",
  topics: ["infrastructure"],
  facts: [],
  commitments: [],
  implied: [],
  closed: [],
};
const ENRICH_ANSWER = JSON.stringify(DIGEST_ANSWER_OBJ);
const answer = () => (timelineAnswer ? TIMELINE_ANSWER : ENRICH_ANSWER);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : null;
  if (refuseSubmit && method === "POST") return new Response("{}", { status: 500 });

  // --- Gemini: inlined requests in, inlined responses out.
  if (/:batchGenerateContent|\/v1beta\/batches\//.test(url)) {
    if (method === "DELETE") {
      deleted.push(url);
      return Response.json({});
    }
    if (method === "POST") {
      submitted = { provider: "gemini", body: bodyText ? JSON.parse(bodyText) : null };
      return Response.json({ name: `batches/abc-${++batchSeq}`, metadata: { state: "BATCH_STATE_PENDING" } });
    }
    // The Developer API answers with the long-running-operation shape the SDK maps from:
    // state and output live under `metadata`, and responses nest twice.
    return Response.json({
      name: url.split("/").pop() ?? "batches/abc",
      metadata: {
        state: batchFails ? "BATCH_STATE_FAILED" : batchDone ? "BATCH_STATE_SUCCEEDED" : "BATCH_STATE_RUNNING",
        model: "models/gemini-3.5-flash",
        ...(batchDone
          ? {
              output: {
                inlinedResponses: {
                  inlinedResponses: [
                    {
                      response: {
                        candidates: [{ content: { parts: [{ text: answer() }] } }],
                        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60, thoughtsTokenCount: 40 },
                      },
                    },
                  ],
                },
              },
            }
          : {}),
      },
    });
  }

  // --- OpenAI: a JSONL file upload, then a batch over it.
  if (/\/v1\/(files|batches)/.test(url)) {
    if (/\/files\/.*\/content/.test(url)) {
      const line = JSON.stringify({
        custom_id: "r0",
        response: { status_code: 200, body: { choices: [{ message: { content: answer() } }], usage: { prompt_tokens: 900, completion_tokens: 60 } } },
      });
      return new Response(line, { headers: { "content-type": "application/jsonl" } });
    }
    if (method === "DELETE") {
      deleted.push(url);
      return Response.json({ deleted: true });
    }
    if (/\/files$/.test(url)) return Response.json({ id: "file-in", purpose: "batch" });
    if (/\/batches$/.test(url) && method === "POST") {
      submitted = { provider: "openai", body: bodyText };
      return Response.json({ id: `batch_${++batchSeq}`, status: "validating" });
    }
    return Response.json({
      id: "batch_1",
      status: batchFails ? "failed" : batchDone ? "completed" : "in_progress",
      ...(batchDone ? { output_file_id: "file-out" } : {}),
    });
  }

  // --- Anthropic: a request list, results as JSONL.
  if (/\/v1\/messages\/batches/.test(url)) {
    if (/\/results$/.test(url)) {
      const line = JSON.stringify({
        custom_id: "r0",
        result: {
          type: "succeeded",
          message: { content: [{ type: "text", text: answer() }], usage: { input_tokens: 800, output_tokens: 60, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
        },
      });
      return new Response(line, { headers: { "content-type": "application/x-jsonl" } });
    }
    if (method === "DELETE") {
      deleted.push(url);
      return Response.json({ id: "msgbatch_1", type: "message_batch_deleted" });
    }
    if (method === "POST") {
      submitted = { provider: "anthropic", body: bodyText ? JSON.parse(bodyText) : null };
      return Response.json({ id: `msgbatch_${++batchSeq}`, processing_status: "in_progress" });
    }
    return Response.json({
      id: "msgbatch_1",
      processing_status: batchFails ? "canceling" : batchDone ? "ended" : "in_progress",
      // The SDK reads the results from this url, so an ended batch must carry one.
      ...(batchDone ? { results_url: `${url.replace(/\/$/, "")}/results` } : {}),
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

/* ------------------------------------------------------------------------- fixtures --- */

async function account(userId: string, provider: Provider) {
  const db = await getDb();
  await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, userId));
  await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  const model = { gemini: "gemini-3.5-flash", openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-5" }[provider];
  await db.insert(userSettings).values({
    userId,
    aiProvider: provider,
    aiModel: model,
    geminiApiKeyEncrypted: encrypt("fake-gemini"),
    openaiApiKeyEncrypted: encrypt("fake-openai"),
    anthropicApiKeyEncrypted: encrypt("fake-anthropic"),
  });
}

/** A contact with one LinkedIn thread — what `relationship.digest` batches. */
async function contactWithThread(userId: string) {
  const db = await getDb();
  const [contact] = await db.insert(contacts).values({ userId, fullName: "Ada Byron", company: "Larkspur" }).returning();
  await db.insert(interactions).values({
    userId,
    contactId: contact.id,
    interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-01"),
    direction: "in",
    source: "linkedin_messages",
    externalId: `li-msg:${contact.id}:1`,
    // Long enough that the engine does not skip it as a trivial thread (no model call).
    rawNotes:
      "Happy to introduce you to our CTO next week. We are rebuilding the platform team's deployment pipeline at Larkspur and I would value your read on the approach before we commit to it. Let me know when you have an hour to talk it through this month.",
  });
  return contact;
}

/**
 * One relationship-engine pass for a user whose run has spent its inline allowance, so
 * every pending contact goes to the provider's Batch API (the real submit path, stubbed
 * only at the network). `extract` is the inline fallback when the batch is refused.
 */
async function submitRelationshipBatch(userId: string) {
  const db = await getDb();
  await db.delete(relationshipRuns).where(eq(relationshipRuns.userId, userId));
  await db.insert(relationshipRuns).values({ userId, status: "queued", inlineUsed: INLINE_PER_RUN });
  return runRelationshipPass(userId, { extract: async () => DIGEST_ANSWER_OBJ });
}

async function main() {
  const db = await getDb();

  for (const provider of ["gemini", "openai", "anthropic"] as const) {
    console.log(`\n${provider}: submit → poll → apply → clean up`);
    await account(USER, provider);
    const contact = await contactWithThread(USER);
    batchDone = false;
    refuseSubmit = false;
    submitted = null;
    deleted.length = 0;

    const { submitted: count } = await submitRelationshipBatch(USER);
    check(`${provider}: the thread is sent as one batched request`, count === 1, String(count));
    const [job] = await listPendingBatchJobs();
    check(`${provider}: a job row is waiting`, job?.status === "submitted" && job.operation === "relationship.digest");
    check(`${provider}: it reserves an estimate against the allowance`, (job?.estCostMicros ?? 0) > 0, String(job?.estCostMicros));
    const lastSubmit = submitted as { provider: Provider; body: unknown } | null;
    check(`${provider}: the provider got the requests`, lastSubmit?.provider === provider);

    const pending = await runAiBatchSweep();
    check(`${provider}: an unfinished batch stays pending`, pending.pending === 1 && pending.applied === 0, JSON.stringify(pending));

    batchDone = true;
    const applied = await runAiBatchSweep();
    check(`${provider}: a finished batch is applied`, applied.applied === 1, JSON.stringify(applied));
    const digest = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, contact.id) });
    check(`${provider}: the answer reached the contact's digest`, Boolean(digest?.summary?.includes("infra team")), digest?.summary ?? "");
    check(`${provider}: and the in-flight marker is cleared`, digest?.batchJobId === null);

    const settled = await db.query.aiBatchJobs.findFirst({ where: eq(aiBatchJobs.userId, USER) });
    check(`${provider}: the job is settled, not polled forever`, settled?.status === "applied");
    check(`${provider}: the provider's copy is deleted`, deleted.length > 0, String(deleted.length));

    const rows = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, USER), eq(usageEvents.operation, "relationship.digest")));
    check(`${provider}: the call is in the ledger`, rows.length === 1, String(rows.length));
    check(`${provider}: priced at the batch rate`, (rows[0]?.estimatedCostMicros ?? 0) > 0);
    if (provider === "gemini") {
      check("gemini: thinking tokens count as output (60 + 40)", rows[0]?.outputTokens === 100, String(rows[0]?.outputTokens));
    }
  }

  console.log("\nTimeline events: queued as a batch, the reach-out written at once");
  {
    await account(USER, "gemini");
    batchDone = false;
    refuseSubmit = false;
    const contact = await contactWithThread(USER);
    // A second message: one message is a reach-out and never reaches the model.
    await db.insert(interactions).values({
      userId: USER,
      contactId: contact.id,
      interactionType: "linkedin_message",
      interactionDate: new Date("2026-09-03"),
      direction: "out",
      rawNotes: "Thank you! Could we grab coffee next Tuesday to talk it through?",
    });
    await db.update(userSettings).set({ timelineBackfillEnabled: 1 }).where(eq(userSettings.userId, USER));

    const run = await runLinkedInTimelineBackfill(USER);
    check("the thread is counted as processed", run.contactsProcessed === 1, JSON.stringify(run));
    const derived = async () =>
      db.query.interactions.findMany({
        where: and(eq(interactions.userId, USER), eq(interactions.contactId, contact.id), isNotNull(interactions.externalId)),
      });
    const afterSubmit = await derived();
    check("the rule-based reach-out is written at submit time", afterSubmit.some((e) => e.interactionType === "reach_out"));
    check("  which takes the contact out of the pending set", run.remaining === 0, String(run.remaining));

    // Nothing is claimed twice while the batch is in flight.
    const second = await runLinkedInTimelineBackfill(USER);
    check("a second pass claims nothing while the batch is out", second.contactsProcessed === 0, JSON.stringify(second));

    timelineAnswer = true;
    batchDone = true;
    const swept = await runAiBatchSweep();
    check("the finished batch is applied", swept.applied === 1, JSON.stringify(swept));
    const afterApply = await derived();
    check("the model's meeting event lands on the thread", afterApply.some((e) => e.interactionType === "meeting"), JSON.stringify(afterApply.map((e) => e.interactionType)));
    timelineAnswer = false;
  }

  console.log("\nA timeline batch that will never answer falls back to keywords");
  {
    await account(USER, "gemini");
    batchDone = false;
    const contact = await contactWithThread(USER);
    await db.insert(interactions).values({
      userId: USER,
      contactId: contact.id,
      interactionType: "linkedin_message",
      interactionDate: new Date("2026-09-03"),
      direction: "out",
      rawNotes: "Coffee next Tuesday would be lovely — shall we meet at your office?",
    });
    await db.update(userSettings).set({ timelineBackfillEnabled: 1 }).where(eq(userSettings.userId, USER));
    await runLinkedInTimelineBackfill(USER);

    // The provider gives up on it, exactly as an expired batch does.
    batchFails = true;
    const swept = await runAiBatchSweep();
    batchFails = false;
    check("the failed batch is counted as failed", swept.failed === 1, JSON.stringify(swept));
    const events = await db.query.interactions.findMany({
      where: and(eq(interactions.userId, USER), eq(interactions.contactId, contact.id), isNotNull(interactions.externalId)),
    });
    check(
      "the thread still gets its keyword-matched events rather than nothing",
      events.some((e) => e.interactionType === "in_person" || e.interactionType === "meeting"),
      JSON.stringify(events.map((e) => e.interactionType))
    );
  }

  console.log("\nWhen batching is not available, the work still happens");
  {
    await account(USER, "gemini");
    await contactWithThread(USER);
    refuseSubmit = true;
    batchDone = false;
    const result = await submitRelationshipBatch(USER);
    check("a provider that refuses the batch → nothing queued", result.submitted === 0, JSON.stringify(result));
    check("  and the contact is digested inline instead", result.processed === 1, JSON.stringify(result));
    refuseSubmit = false;
  }

  console.log("\nA batch nobody can read any more");
  {
    await account(USER, "gemini");
    await contactWithThread(USER);
    await submitRelationshipBatch(USER);
    // The key that submitted it is removed, exactly as Settings would.
    await db.update(userSettings).set({ geminiApiKeyEncrypted: null, openaiApiKeyEncrypted: null, anthropicApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));
    const [job] = await listPendingBatchJobs();
    const result = await pollAiBatch(job);
    check("polling without a key fails the job rather than retrying forever", result.state === "failed");
    const settled = await db.query.aiBatchJobs.findFirst({ where: eq(aiBatchJobs.id, job.id) });
    check("  and the row says why", settled?.status === "failed" && Boolean(settled.errorMessage));
  }

  console.log("\nA batch on Orbit's key holds its estimate against the credits");
  {
    // A batch on Orbit's key has spent the money but written no usage rows yet — its
    // results land hours later. Without the hold an account could submit its way past its
    // credits and only find out when the bill arrived.
    await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, MANAGED));
    await db.delete(creditGrants).where(eq(creditGrants.userId, MANAGED));
    await db.delete(creditHolds).where(eq(creditHolds.userId, MANAGED));
    await db.delete(userSettings).where(eq(userSettings.userId, MANAGED));
    await db.insert(userSettings).values({ userId: MANAGED, subscriptionPlan: "orbit", subscriptionStatus: "active" });
    await ensureAllowance(MANAGED, "orbit", creditPeriodFor(null));
    const before = await getCreditBalance(MANAGED, "orbit", null);
    check("nothing in flight, nothing held", before.held === 0 && before.spendable === 200 * 10_000, JSON.stringify(before));

    const jobId = crypto.randomUUID();
    const hold = await placeHold({
      userId: MANAGED, micros: 40_000, operation: `batch:${jobId}`, packs: true, ttlMs: BATCH_HOLD_TTL_MS, floorMicros: 40_000 - 1,
    });
    check("an in-flight batch holds its estimate", Boolean(hold));
    const during = await getCreditBalance(MANAGED, "orbit", null);
    check("  and the balance says so", during.held === 40_000 && during.spendable === 200 * 10_000 - 40_000, JSON.stringify(during));

    const tooBig = await placeHold({
      userId: MANAGED, micros: 5_000_000, operation: "batch:too-big", packs: true, ttlMs: BATCH_HOLD_TTL_MS, floorMicros: 5_000_000 - 1,
    });
    check("a batch bigger than what is left is refused outright", tooBig === null);

    const [row] = await db
      .insert(aiBatchJobs)
      .values({
        id: jobId,
        userId: MANAGED,
        operation: "relationship.digest",
        provider: "gemini",
        model: "gemini-3.5-flash",
        keyOwner: "orbit",
        providerBatchId: "batches/reserved",
        requestCount: 2,
        estCostMicros: 40_000,
        payload: { items: [] },
      })
      .returning();
    await settleBatchJob(row, "applied", null);
    const after = await getCreditBalance(MANAGED, "orbit", null);
    check("once settled, the hold is released", after.held === 0, JSON.stringify(after));
    await db.delete(creditGrants).where(eq(creditGrants.userId, MANAGED));
  }

  for (const u of [USER, MANAGED]) {
    await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, u));
    await db.delete(usageEvents).where(eq(usageEvents.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AI batch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
