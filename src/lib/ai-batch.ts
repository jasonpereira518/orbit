import type Anthropic from "@anthropic-ai/sdk";
import { JSON_SYSTEM_SUFFIX } from "@/lib/ai-security";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { aiBatchJobs } from "@/db/schema";
import {
  anthropicClient,
  geminiClient,
  openaiClient,
  resolveAiAccess,
  type AiGrant,
} from "@/lib/ai-access";
import { aiOperationThinking, type AiOperationId } from "@/lib/ai-operations";
import { geminiThinkingConfig, openaiCompletionOptions } from "@/lib/ai-request-options";
import { estimateCostMicros } from "@/lib/ai-pricing";
import { modelForOperation } from "@/lib/ai-models";
import { recordUsage, type TokenCounts } from "@/lib/usage-events";
import { reportError } from "@/lib/report-error";

/**
 * Background AI work through the providers' Batch APIs, which bill at half price.
 *
 * What it costs is latency: a batch comes back in minutes, sometimes a day. So this is only
 * for work nobody is watching — LinkedIn enrichment, timeline events, the recruiter scan —
 * and every caller must already be able to survive being left half-done, because a batch
 * that fails hands its work back to the feature's ordinary path rather than retrying itself.
 *
 * Submitting and reading both go through the AI gate for a grant: the key never appears
 * here, and a batch on Orbit's managed key counts against that account's allowance
 * (reserved at its estimate while in flight — see `managedUsageThisMonth`).
 */

/** Requests per submitted batch. Small enough that one failure loses little. */
export const MAX_BATCH_REQUESTS = 100;

/** A batch nobody could read after this long is given up on and handed back. */
export const BATCH_STALE_HOURS = 30;

export type BatchRequest = {
  /** Short and provider-safe (Anthropic allows [a-zA-Z0-9_-]{1,64}); the payload maps it back. */
  customId: string;
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
};

export type BatchOutcome = {
  customId: string;
  /** The model's reply, or null when this one request failed. */
  text: string | null;
  error: string | null;
  usage: TokenCounts;
};

export type AiBatchJobRow = typeof aiBatchJobs.$inferSelect;

type PollResult =
  | { state: "pending" }
  | { state: "ready"; outcomes: BatchOutcome[] }
  | { state: "failed"; reason: string };

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

/* --------------------------------------------------------------- provider adapters ---- */

type Adapter = {
  submit(grant: AiGrant, model: string, operation: AiOperationId, requests: BatchRequest[]): Promise<{ providerBatchId: string; meta?: Record<string, string> }>;
  poll(grant: AiGrant, job: AiBatchJobRow): Promise<PollResult>;
  /** Best effort: delete what the provider is still holding for us. */
  cleanup(grant: AiGrant, job: AiBatchJobRow): Promise<void>;
};

const geminiAdapter: Adapter = {
  async submit(grant, model, operation, requests) {
    const client = await geminiClient(grant);
    const thinking = geminiThinkingConfig(model, aiOperationThinking(operation));
    const job = await client.batches.create({
      model,
      // Inlined rather than an uploaded file: the Gemini Developer API takes the requests in
      // the call, so there is no file to clean up afterwards. Order is the mapping back.
      src: {
        inlinedRequests: requests.map((r) => ({
          model,
          contents: r.user,
          config: {
            systemInstruction: `${r.system}${JSON_SYSTEM_SUFFIX}`,
            temperature: r.temperature ?? DEFAULT_TEMPERATURE,
            maxOutputTokens: r.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
            ...(thinking ? { thinkingConfig: thinking as never } : {}),
          },
        })),
      },
    });
    if (!job.name) throw new Error("Gemini returned a batch with no name");
    return { providerBatchId: job.name };
  },

  async poll(grant, job) {
    const client = await geminiClient(grant);
    const batch = await client.batches.get({ name: job.providerBatchId });
    const state = String(batch.state ?? "");
    if (state === "JOB_STATE_FAILED" || state === "JOB_STATE_CANCELLED" || state === "JOB_STATE_EXPIRED") {
      return { state: "failed", reason: batch.error?.message ?? state };
    }
    if (state !== "JOB_STATE_SUCCEEDED") return { state: "pending" };

    const ids = customIds(job);
    const responses = batch.dest?.inlinedResponses ?? [];
    const outcomes = responses.map((entry, i) => {
      const usage = entry.response?.usageMetadata;
      const thoughts = usage?.thoughtsTokenCount ?? 0;
      return {
        customId: ids[i] ?? `index-${i}`,
        text: entry.response?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") || null,
        error: entry.error?.message ?? null,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage == null ? null : (usage.candidatesTokenCount ?? 0) + thoughts,
          cachedInputTokens: usage?.cachedContentTokenCount ?? null,
        },
      } satisfies BatchOutcome;
    });
    return { state: "ready", outcomes };
  },

  async cleanup(grant, job) {
    await (await geminiClient(grant)).batches.delete({ name: job.providerBatchId });
  },
};

const openaiAdapter: Adapter = {
  async submit(grant, model, operation, requests) {
    const client = await openaiClient(grant);
    const thinking = aiOperationThinking(operation);
    const jsonl = requests
      .map((r) =>
        JSON.stringify({
          custom_id: r.customId,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model,
            ...openaiCompletionOptions(model, {
              temperature: r.temperature ?? DEFAULT_TEMPERATURE,
              maxOutputTokens: r.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              thinking,
            }),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: `${r.system}${JSON_SYSTEM_SUFFIX}` },
              { role: "user", content: r.user },
            ],
          },
        })
      )
      .join("\n");
    const file = await client.files.create({
      file: new File([jsonl], "orbit-batch.jsonl", { type: "application/jsonl" }),
      purpose: "batch",
    });
    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
    return { providerBatchId: batch.id, meta: { inputFileId: file.id } };
  },

  async poll(grant, job) {
    const client = await openaiClient(grant);
    const batch = await client.batches.retrieve(job.providerBatchId);
    if (["failed", "expired", "cancelled"].includes(batch.status)) {
      return { state: "failed", reason: batch.errors?.data?.[0]?.message ?? batch.status };
    }
    if (batch.status !== "completed" || !batch.output_file_id) return { state: "pending" };

    const body = await (await client.files.content(batch.output_file_id)).text();
    const outcomes: BatchOutcome[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        custom_id: string;
        error?: { message?: string } | null;
        response?: { status_code?: number; body?: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } } };
      };
      const usage = row.response?.body?.usage;
      outcomes.push({
        customId: row.custom_id,
        text: row.response?.body?.choices?.[0]?.message?.content ?? null,
        error: row.error?.message ?? (row.response?.status_code && row.response.status_code >= 400 ? `HTTP ${row.response.status_code}` : null),
        usage: {
          inputTokens: usage?.prompt_tokens ?? null,
          outputTokens: usage?.completion_tokens ?? null,
          cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
        },
      });
    }
    // Remember the output file so cleanup can delete it too.
    return { state: "ready", outcomes };
  },

  async cleanup(grant, job) {
    const client = await openaiClient(grant);
    const batch = await client.batches.retrieve(job.providerBatchId).catch(() => null);
    for (const id of [job.providerMeta?.inputFileId, batch?.output_file_id, batch?.error_file_id]) {
      if (id) await client.files.delete(id).catch(() => null);
    }
  },
};

const anthropicAdapter: Adapter = {
  async submit(grant, model, operation, requests) {
    const client = await anthropicClient(grant);
    const batch = await client.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: {
          model,
          max_tokens: r.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          system: `${r.system}${JSON_SYSTEM_SUFFIX}`,
          messages: [{ role: "user" as const, content: r.user }],
        },
      })),
    });
    return { providerBatchId: batch.id };
  },

  async poll(grant, job) {
    const client = await anthropicClient(grant);
    const batch = await client.messages.batches.retrieve(job.providerBatchId);
    if (batch.processing_status !== "ended") return { state: "pending" };

    const outcomes: BatchOutcome[] = [];
    for await (const entry of await client.messages.batches.results(job.providerBatchId)) {
      const result = entry.result as Anthropic.Messages.MessageBatchIndividualResponse["result"];
      if (result.type === "succeeded") {
        const message = result.message;
        const text = message.content.find((b) => b.type === "text");
        const read = message.usage.cache_read_input_tokens ?? 0;
        const written = message.usage.cache_creation_input_tokens ?? 0;
        outcomes.push({
          customId: entry.custom_id,
          text: text && text.type === "text" ? text.text : null,
          error: null,
          usage: {
            inputTokens: message.usage.input_tokens + read + written,
            outputTokens: message.usage.output_tokens,
            cachedInputTokens: read || null,
            ...(written > 0 ? { cacheWriteTokens: written } : {}),
          },
        });
      } else {
        outcomes.push({ customId: entry.custom_id, text: null, error: result.type, usage: {} });
      }
    }
    return { state: "ready", outcomes };
  },

  async cleanup(grant, job) {
    await (await anthropicClient(grant)).messages.batches.delete(job.providerBatchId);
  },
};

const ADAPTERS: Record<"gemini" | "openai" | "anthropic", Adapter> = {
  gemini: geminiAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

/** Gemini maps responses back by ORDER, so the submitted ids are kept on the row. */
function customIds(job: AiBatchJobRow): string[] {
  const ids = (job.payload as { customIds?: unknown }).customIds;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

/* ------------------------------------------------------------------------ submit ------ */

/** A deliberately pessimistic estimate: the whole prompt in, the whole cap out, halved. */
function estimateBatchMicros(model: string, requests: BatchRequest[]): number | null {
  const inputTokens = Math.ceil(requests.reduce((n, r) => n + r.system.length + r.user.length, 0) / 4);
  const outputTokens = requests.reduce((n, r) => n + (r.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS), 0);
  return estimateCostMicros({ model, inputTokens, outputTokens, batch: true });
}

/**
 * Submits one batch. Returns the job id, or null when batching is not available for this
 * account right now — no key, allowance spent, provider refused — and the caller should do
 * the work the ordinary way instead.
 */
export async function submitAiBatch(
  userId: string,
  operation: AiOperationId,
  requests: BatchRequest[],
  payload: Record<string, unknown>
): Promise<string | null> {
  if (requests.length === 0) return null;
  if (requests.length > MAX_BATCH_REQUESTS) {
    throw new Error(`A batch takes at most ${MAX_BATCH_REQUESTS} requests; split before submitting`);
  }

  let grant: AiGrant;
  try {
    grant = await (await resolveAiAccess(userId)).completion(operation);
  } catch {
    // No key, or the allowance is spent: the ordinary path will report that to the person.
    return null;
  }

  // No batch adapter exists for OpenRouter yet — nothing calls it until a later task wires
  // its client. The ordinary (non-batch) completion path handles it instead.
  if (grant.provider === "openrouter") return null;

  // The operation's tier, exactly as the inline path picks it (`completeJson`): a batched
  // recruiter scan ran on the person's full model while the eval measured — and the inline
  // path used — the fast one, so batching at half price still cost more than not batching.
  const model = modelForOperation(operation, grant);
  const estCostMicros = estimateBatchMicros(model, requests);
  try {
    const { providerBatchId, meta } = await ADAPTERS[grant.provider].submit(grant, model, operation, requests);
    const db = await getDb();
    const [row] = await db
      .insert(aiBatchJobs)
      .values({
        userId,
        operation,
        provider: grant.provider,
        model,
        keyOwner: grant.keyOwner,
        providerBatchId,
        requestCount: requests.length,
        estCostMicros,
        payload: { ...payload, customIds: requests.map((r) => r.customId) },
        providerMeta: meta ?? null,
      })
      .returning();
    return row?.id ?? null;
  } catch (err) {
    // A provider that will not take the batch is not a failure of the work — the caller
    // falls back to one call at a time, which is slower and dearer but always available.
    reportError(err, { where: "job.ai-batch.submit", userId, level: "warning", extra: { operation } });
    return null;
  }
}

/* -------------------------------------------------------------------------- poll ------ */

export async function listPendingBatchJobs(limit = 25): Promise<AiBatchJobRow[]> {
  const db = await getDb();
  return db.query.aiBatchJobs.findMany({
    where: eq(aiBatchJobs.status, "submitted"),
    orderBy: [asc(aiBatchJobs.createdAt)],
    limit,
  });
}

export async function pendingBatchJobsFor(userId: string, operation?: AiOperationId): Promise<AiBatchJobRow[]> {
  const db = await getDb();
  return db.query.aiBatchJobs.findMany({
    where: and(
      eq(aiBatchJobs.userId, userId),
      eq(aiBatchJobs.status, "submitted"),
      ...(operation ? [eq(aiBatchJobs.operation, operation)] : [])
    ),
    orderBy: [asc(aiBatchJobs.createdAt)],
  });
}

/**
 * Asks the provider whether one batch is done.
 *
 * `ready` carries the outcomes and records their usage; the caller writes them back and then
 * calls `finishBatchJob`. Everything else is terminal: the row is settled here and the work
 * goes back to the feature's ordinary path.
 */
export async function pollAiBatch(job: AiBatchJobRow): Promise<PollResult> {
  let grant: AiGrant;
  try {
    grant = await (await resolveAiAccess(job.userId)).completion(job.operation as AiOperationId);
  } catch (err) {
    // The key that submitted this is gone (removed, rotated, allowance spent). Nothing can
    // read the batch, so stop holding the work hostage to it.
    await settleBatchJob(job, "failed", err instanceof Error ? err.message : "No key to read the batch with");
    return { state: "failed", reason: "no key" };
  }
  if (grant.provider !== job.provider) {
    await settleBatchJob(job, "failed", `Provider changed from ${job.provider} to ${grant.provider}`);
    return { state: "failed", reason: "provider changed" };
  }

  let result: PollResult;
  try {
    result = await ADAPTERS[job.provider].poll(grant, job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ageHours = (Date.now() - job.createdAt.getTime()) / 3_600_000;
    if (ageHours > BATCH_STALE_HOURS) {
      await settleBatchJob(job, "failed", message);
      return { state: "failed", reason: message };
    }
    reportError(err, { where: "job.ai-batch.poll", userId: job.userId, level: "warning", extra: { operation: job.operation } });
    return { state: "pending" };
  }

  if (result.state === "pending") {
    const ageHours = (Date.now() - job.createdAt.getTime()) / 3_600_000;
    if (ageHours > BATCH_STALE_HOURS) {
      await settleBatchJob(job, "failed", `Still unfinished after ${Math.round(ageHours)}h`);
      return { state: "failed", reason: "expired" };
    }
    return result;
  }

  if (result.state === "failed") {
    await settleBatchJob(job, "failed", result.reason);
    return result;
  }

  // Every request in the batch lands in the ledger, priced at the batch rate it was billed.
  for (const outcome of result.outcomes) {
    recordUsage({
      userId: job.userId,
      operation: job.operation,
      provider: job.provider,
      model: job.model,
      kind: "completion",
      keyOwner: job.keyOwner,
      batch: true,
      ...outcome.usage,
      success: outcome.error === null,
      errorKind: outcome.error ? "batch_request_failed" : null,
    });
  }
  return result;
}

/** Marks a batch done once its results have been written back, and tidies up at the provider. */
export async function finishBatchJob(job: AiBatchJobRow): Promise<void> {
  await settleBatchJob(job, "applied", null);
  try {
    const grant = await (await resolveAiAccess(job.userId)).completion(job.operation as AiOperationId);
    await ADAPTERS[job.provider].cleanup(grant, job);
  } catch (err) {
    // The provider keeps batch inputs for its own retention window; failing to delete them
    // is worth knowing about (they are the person's data) but must not re-run the work.
    reportError(err, { where: "job.ai-batch.cleanup", userId: job.userId, level: "warning", extra: { operation: job.operation } });
  }
}

export async function settleBatchJob(
  job: AiBatchJobRow,
  status: "applied" | "failed" | "cancelled",
  errorMessage: string | null
): Promise<void> {
  const db = await getDb();
  await db
    .update(aiBatchJobs)
    .set({ status, errorMessage, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(aiBatchJobs.id, job.id));
}

/**
 * Cancels batches still in flight for an account — used when the work behind them is being
 * deleted. Best effort at the provider; the rows go either way.
 */
export async function cancelBatchJobsFor(userId: string, jobIds?: string[]): Promise<number> {
  const db = await getDb();
  const rows = await db.query.aiBatchJobs.findMany({
    where: and(
      eq(aiBatchJobs.userId, userId),
      eq(aiBatchJobs.status, "submitted"),
      ...(jobIds?.length ? [inArray(aiBatchJobs.id, jobIds)] : [])
    ),
  });
  for (const row of rows) {
    try {
      const grant = await (await resolveAiAccess(userId)).completion(row.operation as AiOperationId);
      await ADAPTERS[row.provider].cleanup(grant, row);
    } catch {
      // Nothing to do: the row is being closed regardless.
    }
    await settleBatchJob(row, "cancelled", "Cancelled");
  }
  return rows.length;
}
