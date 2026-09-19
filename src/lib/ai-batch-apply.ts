import type { AiOperationId } from "@/lib/ai-operations";
import {
  finishBatchJob,
  listPendingBatchJobs,
  pollAiBatch,
  type AiBatchJobRow,
  type BatchOutcome,
} from "@/lib/ai-batch";
import { applyEnrichmentOutcome, type EnrichBatchPayload } from "@/lib/message-enrichment";
import { reportError } from "@/lib/report-error";

/**
 * Where a finished batch's answers go, per operation.
 *
 * Kept apart from `ai-batch.ts` on purpose: that module talks to providers and knows
 * nothing about contacts or recruiters, and this one imports features freely. The sweep at
 * the bottom is what the process-stalled cron calls.
 *
 * An applier must be safe to run late and more than once. The work it writes back is the
 * same work the feature's ordinary path would do, so a batch that fails simply leaves it
 * undone — the next import, scan or backfill picks it up.
 */

type Applier = (job: AiBatchJobRow, outcomes: BatchOutcome[]) => Promise<void>;

const APPLIERS: Partial<Record<AiOperationId, Applier>> = {
  "import.enrich": async (job, outcomes) => {
    const payload = job.payload as unknown as EnrichBatchPayload;
    const contactByCustomId = new Map(payload.items?.map((i) => [i.customId, i.contactId]) ?? []);
    for (const outcome of outcomes) {
      const contactId = contactByCustomId.get(outcome.customId);
      if (!contactId || !outcome.text) continue;
      try {
        await applyEnrichmentOutcome(job.userId, contactId, outcome.text);
      } catch (err) {
        // One contact's answer failing to land must not cost the rest of the batch.
        reportError(err, {
          where: "job.ai-batch.apply.import-enrich",
          userId: job.userId,
          level: "warning",
          extra: { contactId },
        });
      }
    }
  },
};

export type BatchSweepStats = { polled: number; applied: number; pending: number; failed: number };

/**
 * Polls every batch in flight and writes back the ones that finished.
 *
 * Called by the process-stalled cron, which is the same backstop that resumes stalled
 * imports — a batch is just another piece of work waiting on something outside Orbit.
 */
export async function runAiBatchSweep(limit = 25): Promise<BatchSweepStats> {
  const stats: BatchSweepStats = { polled: 0, applied: 0, pending: 0, failed: 0 };
  const jobs = await listPendingBatchJobs(limit);

  for (const job of jobs) {
    stats.polled += 1;
    const result = await pollAiBatch(job);
    if (result.state === "pending") {
      stats.pending += 1;
      continue;
    }
    if (result.state === "failed") {
      stats.failed += 1;
      continue;
    }

    const applier = APPLIERS[job.operation as AiOperationId];
    if (!applier) {
      // An operation whose applier was removed: settle the row rather than poll it forever.
      reportError(new Error(`No applier for batched operation ${job.operation}`), {
        where: "job.ai-batch.apply",
        userId: job.userId,
        level: "warning",
      });
      await finishBatchJob(job);
      stats.failed += 1;
      continue;
    }

    try {
      await applier(job, result.outcomes);
      await finishBatchJob(job);
      stats.applied += 1;
    } catch (err) {
      reportError(err, {
        where: "job.ai-batch.apply",
        userId: job.userId,
        level: "error",
        extra: { operation: job.operation },
      });
      stats.failed += 1;
    }
  }

  return stats;
}
