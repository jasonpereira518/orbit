/**
 * Drives relationship passes for one user. Shape copied from linkedin-timeline-backfill.ts:
 * time-boxed, self-continuing through its route, at most one attempt per contact per
 * invocation, and a cron backstop for kicks that were lost.
 *
 * One active run per user (queued | running | waiting_key). Its lease stops two invocations
 * from working it at once; an expired lease is simply re-claimed.
 *
 * The first INLINE_PER_RUN contacts of a run are answered inline so the people you talk to
 * most fill in within minutes; the rest go to the Batch API at half price. Batching
 * unavailable → inline, the existing applier contract.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, userSettings, type RelationshipRunRow } from "@/db/schema";
import { BATCH_STALE_HOURS, MAX_BATCH_REQUESTS, submitAiBatch, type AiBatchJobRow, type BatchOutcome } from "@/lib/ai-batch";
import { isAiAccessError } from "@/lib/ai-access";
import { classifyAiError, isMissingAiApiKeyError } from "@/lib/errors";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import {
  advanceWatermarkOnly,
  applyDigestPlan,
  ensureRunNoteBatch,
  loadPreviousDigest,
  recordDigestFailure,
} from "@/lib/relationship-engine/apply";
import {
  DIGEST_MAX_OUTPUT_TOKENS,
  buildDigestPrompt,
  extractRelationshipDigest,
  isTrivialWindow,
  parseDigestAnswer,
  type RelationshipDigestAnswer,
} from "@/lib/relationship-engine/extract";
import { loadMessageWindows, type WindowBound } from "@/lib/relationship-engine/gather";
import { claimPendingContacts, pendingRelationshipContactCount } from "@/lib/relationship-engine/pending";
import { REMINDERS_PER_RUN, planDigestWrites } from "@/lib/relationship-engine/rules";
import type { MessageWindow } from "@/lib/relationship-engine/types";
import { validateDigest } from "@/lib/relationship-engine/validate";

export const INLINE_PER_RUN = 25;
export const RUNNER_BUDGET_MS = 270_000;
export const LEASE_MS = 300_000;
const CLAIM_SIZE = 50;
const ACTIVE: RelationshipRunRow["status"][] = ["queued", "running", "waiting_key"];

export type RunnerOptions = {
  budgetMs?: number;
  now?: Date;
  extract?: typeof extractRelationshipDigest;
  submit?: typeof submitAiBatch;
  importId?: string | null;
};

export type PassResult = {
  status: "disabled" | "busy" | "waiting_key" | "running" | "done";
  processed: number;
  skipped: number;
  failed: number;
  submitted: number;
  remaining: number;
};

export type RelationshipBatchPayload = {
  runId: string;
  items: Array<{ customId: string; contactId: string; lastAt: string; lastInteractionId: string }>;
};

/** The key or the account is the problem, not this contact: pause the run, burn no attempts. */
export function isKeyLevelAiError(err: unknown): boolean {
  if (isAiAccessError(err)) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (isMissingAiApiKeyError(message)) return true;
  const kind = classifyAiError(err);
  return kind === "auth" || kind === "quota" || kind === "rate_limit";
}

export async function kickRelationshipRun(userId: string): Promise<void> {
  try {
    await internalFetch("/api/relationships/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
  } catch (err) {
    reportError(err, { where: "job.relationships.kick", userId, level: "warning" });
  }
}

async function claimRun(userId: string, importId: string | null, now: Date): Promise<{ run: RelationshipRunRow; token: string } | null> {
  const db = await getDb();
  let run = await db.query.relationshipRuns.findFirst({
    where: and(eq(relationshipRuns.userId, userId), inArray(relationshipRuns.status, ACTIVE)),
  });
  if (!run) {
    // The partial unique index makes a concurrent first insert lose cleanly; re-select the winner.
    [run] = await db.insert(relationshipRuns).values({ userId, importId, status: "queued" }).onConflictDoNothing().returning();
    run ??= await db.query.relationshipRuns.findFirst({
      where: and(eq(relationshipRuns.userId, userId), inArray(relationshipRuns.status, ACTIVE)),
    });
    if (!run) return null;
  }
  const token = randomUUID();
  const [claimed] = await db
    .update(relationshipRuns)
    .set({ claimToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), status: "running" })
    .where(and(eq(relationshipRuns.id, run.id), or(isNull(relationshipRuns.leaseUntil), lt(relationshipRuns.leaseUntil, now))))
    .returning();
  return claimed ? { run: claimed, token } : null;
}

async function releaseRun(runId: string, token: string, patch: Partial<RelationshipRunRow>) {
  const db = await getDb();
  await db
    .update(relationshipRuns)
    .set({ ...patch, claimToken: null, leaseUntil: null })
    .where(and(eq(relationshipRuns.id, runId), eq(relationshipRuns.claimToken, token)));
}

async function remindersLeft(runId: string): Promise<number> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, runId), columns: { remindersCreated: true } });
  return Math.max(0, REMINDERS_PER_RUN - (run?.remindersCreated ?? 0));
}

/** validate → plan → apply. Shared by the inline path and the batch applier. */
export async function processDigestAnswer(
  userId: string,
  runId: string,
  contactId: string,
  window: MessageWindow,
  answer: RelationshipDigestAnswer,
  now: Date
): Promise<void> {
  const db = await getDb();
  const [{ threads, openKeys }, contact] = await Promise.all([
    loadPreviousDigest(userId, contactId),
    db.query.contacts.findFirst({
      where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
      columns: { fullName: true, statedCloseness: true, cadenceDays: true },
    }),
  ]);
  if (!contact) return;
  const validated = validateDigest(answer, window, openKeys);
  const plan = planDigestWrites(validated, {
    contactId,
    contactFirstName: contact.fullName.trim().split(/\s+/)[0] || contact.fullName,
    now,
    closeness: contact.statedCloseness ?? null,
    cadenceDays: contact.cadenceDays ?? null,
    existingThreads: threads,
    remindersLeftInRun: await remindersLeft(runId),
  });
  await applyDigestPlan({ userId, runId, contactId, window, validated, plan, now });
}

async function promptFor(userId: string, contactId: string, window: MessageWindow) {
  const db = await getDb();
  const [{ previous }, contact] = await Promise.all([
    loadPreviousDigest(userId, contactId),
    db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { fullName: true } }),
  ]);
  return buildDigestPrompt({ contactName: contact?.fullName ?? "Contact", window, previous });
}

export async function runRelationshipPass(userId: string, opts: RunnerOptions = {}): Promise<PassResult> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const extract = opts.extract ?? extractRelationshipDigest;
  const submit = opts.submit ?? submitAiBatch;
  const budgetMs = opts.budgetMs ?? RUNNER_BUDGET_MS;
  const start = Date.now();
  const result: PassResult = { status: "running", processed: 0, skipped: 0, failed: 0, submitted: 0, remaining: 0 };

  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { relationshipEngineEnabled: true },
  });
  if ((settings?.relationshipEngineEnabled ?? 1) !== 1) {
    return { ...result, status: "disabled", remaining: await pendingRelationshipContactCount(userId, now) };
  }

  const claim = await claimRun(userId, opts.importId ?? null, now);
  if (!claim) return { ...result, status: "busy", remaining: await pendingRelationshipContactCount(userId, now) };
  const { run, token } = claim;
  let inlineUsed = run.inlineUsed;
  const attempted = new Set<string>();
  let queue: Array<{ contactId: string; window: MessageWindow; system: string; user: string }> = [];
  let batchUnavailable = false;
  const overBudget = () => Date.now() - start >= budgetMs;

  /** One inline attempt. Returns true when a key-level error paused the run (lease released). */
  const attemptInline = async (contactId: string, window: MessageWindow, prompt: { system: string; user: string }): Promise<boolean> => {
    try {
      const answer = await extract(userId, prompt);
      await processDigestAnswer(userId, run.id, contactId, window, answer, now);
      inlineUsed += 1;
      result.processed += 1;
      return false;
    } catch (err) {
      if (isKeyLevelAiError(err)) {
        await releaseRun(run.id, token, { status: "waiting_key", inlineUsed, lastError: String((err as Error)?.message ?? err).slice(0, 500) });
        return true;
      }
      await recordDigestFailure(userId, contactId, err);
      await db.update(relationshipRuns).set({ failed: sql`${relationshipRuns.failed} + 1` }).where(eq(relationshipRuns.id, run.id));
      result.failed += 1;
      return false;
    }
  };

  /** Submit the queue; what the batch API will not take is done inline, within the budget. */
  const flushQueue = async (): Promise<boolean> => {
    const slice = queue;
    queue = [];
    if (slice.length === 0) return false;
    const payload: RelationshipBatchPayload = {
      runId: run.id,
      items: slice.map((q, n) => ({
        customId: `r${n}`,
        contactId: q.contactId,
        lastAt: q.window.last.at.toISOString(),
        lastInteractionId: q.window.last.interactionId,
      })),
    };
    const jobId = await submit(
      userId,
      "relationship.digest",
      slice.map((q, n) => ({ customId: `r${n}`, system: q.system, user: q.user, temperature: 0.1, maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS })),
      payload as unknown as Record<string, unknown>
    );
    if (jobId) {
      const until = new Date(now.getTime() + BATCH_STALE_HOURS * 3_600_000);
      for (const q of slice) {
        await db
          .insert(relationshipDigests)
          .values({ contactId: q.contactId, userId, batchJobId: jobId, batchPendingUntil: until, runId: run.id })
          .onConflictDoUpdate({ target: relationshipDigests.contactId, set: { batchJobId: jobId, batchPendingUntil: until, runId: run.id } });
      }
      result.submitted += slice.length;
      return false;
    }
    batchUnavailable = true;
    for (const q of slice) {
      // Unprocessed contacts keep no marker, so they simply stay pending for the next pass.
      if (overBudget()) break;
      if (await attemptInline(q.contactId, q.window, { system: q.system, user: q.user })) return true;
    }
    return false;
  };

  const keyPaused = async (): Promise<PassResult> => ({
    ...result,
    status: "waiting_key",
    remaining: await pendingRelationshipContactCount(userId, now),
  });

  try {
    // The run's note batch exists before any apply, inline or batched, so two concurrent
    // first applies can never create two.
    await ensureRunNoteBatch(userId, run.id);

    claiming: while (!overBudget()) {
      const ids = await claimPendingContacts(userId, CLAIM_SIZE, attempted, now);
      if (ids.length === 0) break;
      const windows = await loadMessageWindows(userId, ids);
      for (const contactId of ids) {
        if (overBudget()) break claiming;
        attempted.add(contactId);
        const window = windows.get(contactId);
        if (!window) continue;
        if (isTrivialWindow(window)) {
          await advanceWatermarkOnly(userId, run.id, window);
          result.skipped += 1;
          continue;
        }
        const prompt = await promptFor(userId, contactId, window);
        if (inlineUsed < INLINE_PER_RUN || batchUnavailable) {
          if (await attemptInline(contactId, window, prompt)) return await keyPaused();
          continue;
        }
        queue.push({ contactId, window, ...prompt });
        // Bounded memory: a full queue goes out now, then the loop carries on if budget remains.
        if (queue.length >= MAX_BATCH_REQUESTS && (await flushQueue())) return await keyPaused();
      }
    }
    if (await flushQueue()) return await keyPaused();

    result.remaining = await pendingRelationshipContactCount(userId, now);
    const out = await db.query.relationshipDigests.findFirst({
      where: and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.runId, run.id), sql`${relationshipDigests.batchPendingUntil} > ${now.toISOString()}::timestamptz`),
      columns: { contactId: true },
    });
    const finished = result.remaining === 0 && !out;
    await releaseRun(run.id, token, {
      inlineUsed,
      status: finished ? "done" : "running",
      ...(finished ? { finishedAt: new Date() } : {}),
    });
    result.status = finished ? "done" : "running";
    return result;
  } catch (err) {
    await releaseRun(run.id, token, { inlineUsed, lastError: String((err as Error)?.message ?? err).slice(0, 500) });
    throw err;
  }
}

/** True when the stored watermark is already at or past `bound` (the window was applied). */
function watermarkReached(at: Date | null, interactionId: string | null, bound: WindowBound): boolean {
  if (!at) return false;
  if (at.getTime() !== bound.at.getTime()) return at.getTime() > bound.at.getTime();
  return (interactionId ?? "") >= bound.interactionId;
}

/**
 * Batch answers: judged against exactly what the model read. Each item's window is re-read
 * capped at the payload's bound (lastAt, lastInteractionId), so a message that arrived while
 * the batch was out stays past the watermark and pending. An item whose digest no longer
 * points at this job (released, resubmitted, purged) or whose watermark already reached the
 * bound is skipped: someone else owns that contact now.
 */
export async function applyRelationshipBatch(
  job: Pick<AiBatchJobRow, "id" | "userId" | "payload">,
  outcomes: BatchOutcome[],
  kick: (userId: string) => Promise<void> = kickRelationshipRun
): Promise<void> {
  const db = await getDb();
  const payload = job.payload as unknown as RelationshipBatchPayload;
  const byCustomId = new Map(payload.items.map((i) => [i.customId, i]));
  const now = new Date();
  const contactIds = outcomes.map((o) => byCustomId.get(o.customId)?.contactId).filter((id): id is string => Boolean(id));
  const digests = contactIds.length
    ? await db.query.relationshipDigests.findMany({
        where: and(eq(relationshipDigests.userId, job.userId), inArray(relationshipDigests.contactId, contactIds)),
        columns: { contactId: true, batchJobId: true, watermarkAt: true, watermarkInteractionId: true },
      })
    : [];
  const digestOf = new Map(digests.map((d) => [d.contactId, d]));
  const live = new Map<string, WindowBound>();
  for (const outcome of outcomes) {
    const item = byCustomId.get(outcome.customId);
    if (!item) continue;
    const d = digestOf.get(item.contactId);
    const bound = { at: new Date(item.lastAt), interactionId: item.lastInteractionId };
    if (!d || d.batchJobId !== job.id) continue;
    if (Number.isNaN(bound.at.getTime()) || !bound.interactionId) continue;
    if (watermarkReached(d.watermarkAt, d.watermarkInteractionId, bound)) continue;
    live.set(item.contactId, bound);
  }
  const windows = await loadMessageWindows(job.userId, [...live.keys()], { until: live });
  for (const outcome of outcomes) {
    const contactId = byCustomId.get(outcome.customId)?.contactId;
    if (!contactId || !live.has(contactId)) continue;
    const window = windows.get(contactId);
    try {
      if (!window) continue;
      if (!outcome.text) throw new Error(outcome.error ?? "batch request failed");
      await processDigestAnswer(job.userId, payload.runId, contactId, window, parseDigestAnswer(outcome.text), now);
    } catch (err) {
      await recordDigestFailure(job.userId, contactId, err);
      await db.update(relationshipRuns).set({ failed: sql`${relationshipRuns.failed} + 1` }).where(eq(relationshipRuns.id, payload.runId));
      reportError(err, { where: "job.ai-batch.apply.relationship", userId: job.userId, level: "warning", extra: { contactId } });
    }
  }
  // Nothing stays in flight for 30h: clear every payload item still pointing at THIS job
  // (no window, no contact, or missing from the outcomes), whatever happened to it above.
  // A marker another job owns is that job's to clear.
  const allIds = payload.items.map((i) => i.contactId);
  if (allIds.length > 0) {
    await db
      .update(relationshipDigests)
      .set({ batchJobId: null, batchPendingUntil: null })
      .where(and(eq(relationshipDigests.userId, job.userId), inArray(relationshipDigests.contactId, allIds), eq(relationshipDigests.batchJobId, job.id)));
  }
  await kick(job.userId);
}

/** The batch will never answer: clear the in-flight marker so the contacts are pending again. */
export async function releaseRelationshipBatch(job: Pick<AiBatchJobRow, "id" | "userId">): Promise<void> {
  const db = await getDb();
  await db
    .update(relationshipDigests)
    .set({ batchJobId: null, batchPendingUntil: null })
    .where(and(eq(relationshipDigests.userId, job.userId), eq(relationshipDigests.batchJobId, job.id)));
  await kickRelationshipRun(job.userId);
}
