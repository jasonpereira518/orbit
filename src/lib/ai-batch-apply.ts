import type { AiOperationId } from "@/lib/ai-operations";
import {
  finishBatchJob,
  listPendingBatchJobs,
  pollAiBatch,
  type AiBatchJobRow,
  type BatchOutcome,
} from "@/lib/ai-batch";
import { applyEnrichmentOutcome, type EnrichBatchPayload } from "@/lib/message-enrichment";
import { applyTimelineOutcome, type TimelineBatchPayload } from "@/lib/linkedin-timeline-backfill";
import {
  applyRecruiterScanOutcome,
  finalizeRecruiterScanIfDone,
  recruiterScanIsRunning,
  releaseRecruiterScanRows,
  touchImport,
  type RecruiterBatchPayload,
} from "@/lib/gmail-scan-processor";
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

type Applier = {
  apply: (job: AiBatchJobRow, outcomes: BatchOutcome[]) => Promise<void>;
  /**
   * Called on every poll while the batch is still out. For work whose own progress is
   * watched elsewhere — a scan job that would otherwise look stalled and be resumed.
   */
  keepAlive?: (job: AiBatchJobRow) => Promise<void>;
  /**
   * What to do when the batch will never answer — the provider failed it, the key that
   * submitted it is gone, it expired. Only for work the ordinary path cannot pick up again
   * by itself; most operations simply leave it undone and get re-claimed next time.
   */
  release?: (job: AiBatchJobRow) => Promise<void>;
};

const APPLIERS: Partial<Record<AiOperationId, Applier>> = {
  "import.enrich": {
    apply: async (job, outcomes) => {
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
  },

  "import.linkedin.timeline": {
    apply: async (job, outcomes) => {
      const payload = job.payload as unknown as TimelineBatchPayload;
      const contactByCustomId = new Map(payload.items?.map((i) => [i.customId, i.contactId]) ?? []);
      for (const outcome of outcomes) {
        const contactId = contactByCustomId.get(outcome.customId);
        if (!contactId) continue;
        // The answer alone is not enough: events are dated against the thread's own
        // messages, so the thread is read again and prepared exactly as it was at submit.
        await applyTimelineOutcome(job.userId, contactId, outcome.text).catch((err) =>
          reportError(err, {
            where: "job.ai-batch.apply.timeline",
            userId: job.userId,
            level: "warning",
            extra: { contactId },
          })
        );
      }
    },
    release: async (job) => {
      // The rule-based reach-out was written when the batch was submitted, which is also
      // what takes a contact out of the pending set — so nothing will claim these threads
      // again. Give them the keyword-matched events the inline path falls back to.
      const payload = job.payload as unknown as TimelineBatchPayload;
      for (const contactId of payload.contactIds ?? []) {
        await applyTimelineOutcome(job.userId, contactId, null).catch(() => null);
      }
    },
  },

  "recruiter.scan": {
    apply: async (job, outcomes) => {
      const payload = job.payload as unknown as RecruiterBatchPayload;
      // A scan the person cancelled (or one that failed on a key problem) must not gain
      // recruiters hours later. Its rows are settled and the answers dropped.
      if (!(await recruiterScanIsRunning(payload.importId))) {
        await releaseRecruiterScanRows(payload.items?.map((i) => i.rowId) ?? [], "skipped");
        return;
      }
      const byCustomId = new Map(payload.items?.map((i) => [i.customId, i]) ?? []);
      for (const outcome of outcomes) {
        const item = byCustomId.get(outcome.customId);
        if (!item) continue;
        await applyRecruiterScanOutcome(job.userId, item, outcome.text).catch((err) =>
          reportError(err, {
            where: "job.ai-batch.apply.recruiter-scan",
            userId: job.userId,
            level: "warning",
            extra: { rowId: item.rowId },
          })
        );
      }
      // The scan is only finished when nothing is left unread — this may be the last batch.
      await finalizeRecruiterScanIfDone(payload.importId);
    },
    release: async (job) => {
      // Hand the senders back: the scan's own resume path classifies them one at a time.
      const payload = job.payload as unknown as RecruiterBatchPayload;
      await releaseRecruiterScanRows(payload.items?.map((i) => i.rowId) ?? []);
    },
    keepAlive: async (job) => {
      // A scan waiting on a batch is not a stalled scan. The stall sweep reads
      // `imports.updated_at`, so touch it while the answers are still coming.
      const payload = job.payload as unknown as RecruiterBatchPayload;
      await touchImport(payload.importId);
    },
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
      await APPLIERS[job.operation as AiOperationId]?.keepAlive?.(job).catch(() => null);
      continue;
    }
    if (result.state === "failed") {
      stats.failed += 1;
      const applier = APPLIERS[job.operation as AiOperationId];
      if (applier?.release) {
        await applier.release(job).catch((err) =>
          reportError(err, {
            where: "job.ai-batch.release",
            userId: job.userId,
            level: "warning",
            extra: { operation: job.operation },
          })
        );
      }
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
      await applier.apply(job, result.outcomes);
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
