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
import { loadMessageWindows } from "@/lib/relationship-engine/gather";
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
    [run] = await db.insert(relationshipRuns).values({ userId, importId, status: "queued" }).returning();
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
  // The run's note batch exists before any apply, inline or batched, so two concurrent
  // first applies can never create two.
  await ensureRunNoteBatch(userId, run.id);
  let inlineUsed = run.inlineUsed;
  const attempted = new Set<string>();
  const queued: Array<{ contactId: string; window: MessageWindow; system: string; user: string }> = [];

  try {
    claiming: while (Date.now() - start < budgetMs) {
      const ids = await claimPendingContacts(userId, CLAIM_SIZE, attempted, now);
      if (ids.length === 0) break;
      const windows = await loadMessageWindows(userId, ids);
      for (const contactId of ids) {
        if (Date.now() - start >= budgetMs) break claiming;
        attempted.add(contactId);
        const window = windows.get(contactId);
        if (!window) continue;
        if (isTrivialWindow(window)) {
          await advanceWatermarkOnly(userId, run.id, window);
          result.skipped += 1;
          continue;
        }
        const prompt = await promptFor(userId, contactId, window);
        if (inlineUsed >= INLINE_PER_RUN) {
          queued.push({ contactId, window, ...prompt });
          continue;
        }
        try {
          const answer = await extract(userId, prompt);
          await processDigestAnswer(userId, run.id, contactId, window, answer, now);
          inlineUsed += 1;
          result.processed += 1;
        } catch (err) {
          if (isKeyLevelAiError(err)) {
            await releaseRun(run.id, token, { status: "waiting_key", inlineUsed, lastError: String((err as Error)?.message ?? err).slice(0, 500) });
            return { ...result, status: "waiting_key", remaining: await pendingRelationshipContactCount(userId, now) };
          }
          await recordDigestFailure(userId, contactId, err);
          await db.update(relationshipRuns).set({ failed: sql`${relationshipRuns.failed} + 1` }).where(eq(relationshipRuns.id, run.id));
          result.failed += 1;
        }
      }
    }

    // Submit the queue; anything the batch API will not take is done inline.
    for (let i = 0; i < queued.length; i += MAX_BATCH_REQUESTS) {
      const slice = queued.slice(i, i + MAX_BATCH_REQUESTS);
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
        continue;
      }
      for (const q of slice) {
        try {
          const answer = await extract(userId, { system: q.system, user: q.user });
          await processDigestAnswer(userId, run.id, q.contactId, q.window, answer, now);
          result.processed += 1;
        } catch (err) {
          if (isKeyLevelAiError(err)) {
            await releaseRun(run.id, token, { status: "waiting_key", inlineUsed });
            return { ...result, status: "waiting_key", remaining: await pendingRelationshipContactCount(userId, now) };
          }
          await recordDigestFailure(userId, q.contactId, err);
          result.failed += 1;
        }
      }
    }

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

/** Batch answers: re-read each contact's window as it stood at submit, then the inline path. */
export async function applyRelationshipBatch(
  job: Pick<AiBatchJobRow, "userId" | "payload">,
  outcomes: BatchOutcome[],
  kick: (userId: string) => Promise<void> = kickRelationshipRun
): Promise<void> {
  const payload = job.payload as unknown as RelationshipBatchPayload;
  const byCustomId = new Map(payload.items.map((i) => [i.customId, i.contactId]));
  const now = new Date();
  const contactIds = outcomes.map((o) => byCustomId.get(o.customId)).filter((id): id is string => Boolean(id));
  const windows = await loadMessageWindows(job.userId, contactIds);
  for (const outcome of outcomes) {
    const contactId = byCustomId.get(outcome.customId);
    if (!contactId) continue;
    const window = windows.get(contactId);
    try {
      if (!window) continue;
      if (!outcome.text) throw new Error(outcome.error ?? "batch request failed");
      await processDigestAnswer(job.userId, payload.runId, contactId, window, parseDigestAnswer(outcome.text), now);
    } catch (err) {
      await recordDigestFailure(job.userId, contactId, err);
      reportError(err, { where: "job.ai-batch.apply.relationship", userId: job.userId, level: "warning", extra: { contactId } });
    }
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
