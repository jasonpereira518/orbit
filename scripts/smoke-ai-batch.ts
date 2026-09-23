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
import { aiBatchJobs, contacts, interactions, userSettings, usageEvents } from "../src/db/schema";
import { isNotNull } from "drizzle-orm";
import { encrypt } from "../src/lib/crypto";
import { listPendingBatchJobs, pollAiBatch } from "../src/lib/ai-batch";
import { runAiBatchSweep } from "../src/lib/ai-batch-apply";
import { runLinkedInTimelineBackfill } from "../src/lib/linkedin-timeline-backfill";
import { enrichContactsFromMessagesBatched } from "../src/lib/message-enrichment";
import { managedUsageThisMonth } from "../src/lib/ai-access";

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
const ENRICH_ANSWER = JSON.stringify({
  summary: "You and Ada have been trading notes about her infra team.",
  key_facts: ["Runs the platform team at Larkspur"],
  open_loops: ["She owes you an intro to her CTO"],
  relationship_score_suggestion: 4,
  topics: ["infrastructure"],
});
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
        custom_id: "c0",
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
        custom_id: "c0",
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

/** A contact with one LinkedIn thread — what `import.enrich` batches. */
async function contactWithThread(userId: string) {
  const db = await getDb();
  const [contact] = await db.insert(contacts).values({ userId, fullName: "Ada Byron", company: "Larkspur" }).returning();
  await db.insert(interactions).values({
    userId,
    contactId: contact.id,
    interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-01"),
    direction: "in",
    rawNotes: "Happy to introduce you to our CTO next week.",
  });
  return contact;
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

    const { submitted: count } = await enrichContactsFromMessagesBatched(USER, [contact.id]);
    check(`${provider}: the thread is sent as one batched request`, count === 1, String(count));
    const [job] = await listPendingBatchJobs();
    check(`${provider}: a job row is waiting`, job?.status === "submitted" && job.operation === "import.enrich");
    check(`${provider}: it reserves an estimate against the allowance`, (job?.estCostMicros ?? 0) > 0, String(job?.estCostMicros));
    const lastSubmit = submitted as { provider: Provider; body: unknown } | null;
    check(`${provider}: the provider got the requests`, lastSubmit?.provider === provider);

    const pending = await runAiBatchSweep();
    check(`${provider}: an unfinished batch stays pending`, pending.pending === 1 && pending.applied === 0, JSON.stringify(pending));

    batchDone = true;
    const applied = await runAiBatchSweep();
    check(`${provider}: a finished batch is applied`, applied.applied === 1, JSON.stringify(applied));
    const enriched = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check(`${provider}: the answer reached the contact`, Boolean(enriched?.aiSummary?.includes("infra team")), enriched?.aiSummary ?? "");
    check(`${provider}: and its open loop was kept`, (enriched?.keyFacts ?? []).some((f) => f.startsWith("Open:")));

    const settled = await db.query.aiBatchJobs.findFirst({ where: eq(aiBatchJobs.userId, USER) });
    check(`${provider}: the job is settled, not polled forever`, settled?.status === "applied");
    check(`${provider}: the provider's copy is deleted`, deleted.length > 0, String(deleted.length));

    const rows = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, USER), eq(usageEvents.operation, "import.enrich")));
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
    const contact = await contactWithThread(USER);
    refuseSubmit = true;
    batchDone = false;
    const result = await enrichContactsFromMessagesBatched(USER, [contact.id]);
    check("a provider that refuses the batch → nothing queued", result.submitted === 0);
    check("  and the contact is enriched inline instead", result.inline?.contactsEnriched === 1 || result.inline?.skipped === 1, JSON.stringify(result.inline));
    refuseSubmit = false;
  }

  console.log("\nA batch nobody can read any more");
  {
    await account(USER, "gemini");
    const contact = await contactWithThread(USER);
    await enrichContactsFromMessagesBatched(USER, [contact.id]);
    // The key that submitted it is removed, exactly as Settings would.
    await db.update(userSettings).set({ geminiApiKeyEncrypted: null, openaiApiKeyEncrypted: null, anthropicApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));
    const [job] = await listPendingBatchJobs();
    const result = await pollAiBatch(job);
    check("polling without a key fails the job rather than retrying forever", result.state === "failed");
    const settled = await db.query.aiBatchJobs.findFirst({ where: eq(aiBatchJobs.id, job.id) });
    check("  and the row says why", settled?.status === "failed" && Boolean(settled.errorMessage));
  }

  console.log("\nThe managed allowance counts what is still in flight");
  {
    // A batch on Orbit's key has spent the money but written no usage rows yet — its
    // results land hours later. Without the reservation an account could submit its way
    // past the cap and only find out when the bill arrived.
    await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, MANAGED));
    const before = await managedUsageThisMonth(MANAGED);
    check("nothing in flight, nothing reserved", before.spentMicros === 0 && before.calls === 0);

    const [row] = await db
      .insert(aiBatchJobs)
      .values({
        userId: MANAGED,
        operation: "import.enrich",
        provider: "gemini",
        model: "gemini-3.5-flash",
        keyOwner: "orbit",
        providerBatchId: "batches/reserved",
        requestCount: 2,
        estCostMicros: 40_000,
        payload: { items: [] },
      })
      .returning();
    const during = await managedUsageThisMonth(MANAGED);
    check("an in-flight batch reserves its estimate", during.spentMicros === 40_000, String(during.spentMicros));
    check("  and its requests count against the call ceiling", during.calls === 2, String(during.calls));

    await db.update(aiBatchJobs).set({ status: "applied" }).where(eq(aiBatchJobs.id, row.id));
    const after = await managedUsageThisMonth(MANAGED);
    check("once applied, only the real usage rows count", after.spentMicros === 0 && after.calls === 0, JSON.stringify(after));

    // A batch on the person's OWN key is their spend, never Orbit's allowance.
    await db
      .insert(aiBatchJobs)
      .values({
        userId: MANAGED,
        operation: "import.enrich",
        provider: "gemini",
        model: "gemini-3.5-flash",
        keyOwner: "user",
        providerBatchId: "batches/own-key",
        requestCount: 5,
        estCostMicros: 90_000,
        payload: { items: [] },
      });
    const byo = await managedUsageThisMonth(MANAGED);
    check("a batch on the person's own key is not reserved", byo.spentMicros === 0 && byo.calls === 0, JSON.stringify(byo));
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
