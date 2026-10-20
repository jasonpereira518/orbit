import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { del } from "@/lib/blob-lazy";
import { hasBlobStorage } from "@/lib/contact-avatar";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";

/**
 * Retention for the operational and PII-bearing tables nothing else prunes (audit M-08).
 *
 * Every window is here, in one object, so changing one is a one-line edit. The hourly
 * process-stalled sweep calls `runRetentionSweeps`; each step is bounded (batches, plus a
 * wall-clock budget per table) the way `pruneOlderThan` is, and what is left over is the
 * next hour's.
 *
 * What each window applies to:
 *   cronRunsDays                   `cron_runs` rows, by `started_at`.
 *   webhookDeliveriesDays          `webhook_deliveries` rows, by `created_at`.
 *   webhookRecipientsDays          `webhook_deliveries.detail.recipients` (Resend rows carry
 *                                  the addresses a bounce was about) is dropped after this,
 *                                  well before the row itself goes.
 *   outboundPayloadDays            `outbound_webhook_deliveries.payload`, emptied this long
 *                                  after the delivery settled (delivered, or dead). The row
 *                                  and its status stay until the endpoint is deleted.
 *   feedbackScreenshotClosedDays   `feedback_screenshots` (and their Blob objects) of feedback
 *                                  marked resolved this long ago. The feedback text stays.
 *   meetingTranscriptAfterDigestDays `meeting_transcript_segments` of a meeting that is saved
 *                                  and has its digest, this long after the meeting was last
 *                                  touched. 0 = as soon as both are true. null = never: the
 *                                  default, because transcript search and chat's meeting
 *                                  passages read these rows, so pruning them is a product
 *                                  decision (FIX_PLAN decision 8), not a hygiene one.
 *   emailBodyDays                  `email_sends.body_text` / `body_html` of a settled send
 *                                  (sent, failed, canceled), by `updated_at`. The envelope
 *                                  (who, when, subject, status) stays. null = never: the
 *                                  default, since people may expect to reread what they sent
 *                                  (FIX_PLAN decision 8). 90 is the plan's suggested window.
 *   gateEventsDays, extensionUsageDays, speechUsageDays
 *                                  whole rows. `extension_usage` is one rolling-window row per
 *                                  person, judged by when it was last used.
 */
export const RETENTION = {
  cronRunsDays: 90,
  webhookDeliveriesDays: 90,
  webhookRecipientsDays: 30,
  outboundPayloadDays: 30,
  feedbackScreenshotClosedDays: 90,
  // User content, not logs: off until the owner picks a window (FIX_PLAN decision 8).
  meetingTranscriptAfterDigestDays: null,
  emailBodyDays: null,
  gateEventsDays: 180,
  extensionUsageDays: 180,
  speechUsageDays: 180,
} as const;

/** Days per window; the two user-content windows may be null (never). */
export type RetentionWindows = { [K in keyof typeof RETENTION]: (typeof RETENTION)[K] extends null ? number | null : number };

const BATCH = 2_000;
const TABLE_BUDGET_MS = 10 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * Runs one batched statement until it touches fewer than a batch or the budget runs out.
 * `statement` must be a CTE named `d` whose rows are the touched rows.
 */
async function drain(statement: () => SQL): Promise<number> {
  const db = await getDb();
  const deadline = deadlineAfter(TABLE_BUDGET_MS);
  let total = 0;
  for (;;) {
    const res = await db.execute(sql`WITH d AS (${statement()}) SELECT count(*)::int AS n FROM d`);
    const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    total += n;
    if (n < BATCH || deadlineReached(deadline)) return total;
  }
}

function deleteOlderThan(table: string, idColumn: string, timeExpr: string, before: string): () => SQL {
  return () => sql`
    DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(idColumn)} IN (
      SELECT ${sql.identifier(idColumn)} FROM ${sql.identifier(table)} WHERE ${sql.raw(timeExpr)} < ${before} LIMIT ${BATCH}
    ) RETURNING 1`;
}

export type FeedbackBlobDeleter = (url: string) => Promise<unknown>;

export type RetentionStats = {
  cronRunsPruned: number;
  webhookDeliveriesPruned: number;
  webhookRecipientsStripped: number;
  outboundPayloadsCleared: number;
  feedbackScreenshotsPruned: number;
  transcriptSegmentsPruned: number;
  emailBodiesCleared: number;
  gateEventsPruned: number;
  extensionUsagePruned: number;
  speechUsagePruned: number;
};

/**
 * Screenshots of feedback resolved more than the window ago, rows and Blob objects. The row
 * goes first; the object after it, through the shared Blob `del` (swappable for tests).
 * Best-effort on the Blob side, as in the purge: an orphaned object is a cost problem, and a
 * Blob outage must not stop the rows from going.
 */
export async function pruneClosedFeedbackScreenshots(
  now: Date,
  days: number,
  deleteBlob: FeedbackBlobDeleter = (url) => del(url)
): Promise<number> {
  const db = await getDb();
  const deadline = deadlineAfter(TABLE_BUDGET_MS);
  let total = 0;
  for (;;) {
    const gone = rowsOf<{ blob_url: string | null; storage: string }>(
      await db.execute(sql`
        DELETE FROM feedback_screenshots WHERE id IN (
          SELECT s.id FROM feedback_screenshots s
            JOIN feedback f ON f.id = s.feedback_id
           WHERE f.status = 'resolved' AND f.status_changed_at < ${cutoff(now, days)}
           LIMIT ${BATCH}
        ) RETURNING blob_url, storage
      `)
    );
    total += gone.length;
    for (const shot of gone) {
      if (shot.storage !== "blob" || !shot.blob_url) continue;
      try {
        await deleteBlob(shot.blob_url);
      } catch {
        // See above.
      }
    }
    if (gone.length < BATCH || deadlineReached(deadline)) return total;
  }
}

export async function runRetentionSweeps(
  opts: { now?: Date; windows?: Partial<RetentionWindows>; deleteBlob?: FeedbackBlobDeleter } = {}
): Promise<RetentionStats> {
  const now = opts.now ?? new Date();
  const w: RetentionWindows = { ...RETENTION, ...opts.windows };

  const cronRunsPruned = await drain(deleteOlderThan("cron_runs", "id", "started_at", cutoff(now, w.cronRunsDays)));
  const webhookDeliveriesPruned = await drain(
    deleteOlderThan("webhook_deliveries", "id", "created_at", cutoff(now, w.webhookDeliveriesDays))
  );
  const webhookRecipientsStripped = await drain(() => sql`
    UPDATE webhook_deliveries SET detail = detail - 'recipients' WHERE id IN (
      SELECT id FROM webhook_deliveries
       WHERE created_at < ${cutoff(now, w.webhookRecipientsDays)} AND (detail -> 'recipients') IS NOT NULL
       LIMIT ${BATCH}
    ) RETURNING 1`);
  const outboundPayloadsCleared = await drain(() => sql`
    UPDATE outbound_webhook_deliveries SET payload = '{}'::jsonb WHERE id IN (
      SELECT id FROM outbound_webhook_deliveries
       WHERE status IN ('delivered', 'dead')
         AND coalesce(delivered_at, last_attempted_at, created_at) < ${cutoff(now, w.outboundPayloadDays)}
         AND payload <> '{}'::jsonb
       LIMIT ${BATCH}
    ) RETURNING 1`);
  // Without a Blob store every screenshot is inline, so there is no object to delete.
  const deleteBlob = opts.deleteBlob ?? (hasBlobStorage() ? (url: string) => del(url) : async () => {});
  const feedbackScreenshotsPruned = await pruneClosedFeedbackScreenshots(now, w.feedbackScreenshotClosedDays, deleteBlob);
  const transcriptDays = w.meetingTranscriptAfterDigestDays;
  const transcriptSegmentsPruned = transcriptDays === null ? 0 : await drain(() => sql`
    DELETE FROM meeting_transcript_segments WHERE id IN (
      SELECT seg.id FROM meeting_transcript_segments seg
        JOIN meeting_sessions s ON s.id = seg.session_id
       WHERE s.status = 'saved' AND s.digest IS NOT NULL
         AND s.updated_at < ${cutoff(now, transcriptDays)}
       LIMIT ${BATCH}
    ) RETURNING 1`);
  const emailDays = w.emailBodyDays;
  const emailBodiesCleared = emailDays === null ? 0 : await drain(() => sql`
    UPDATE email_sends SET body_text = '', body_html = NULL WHERE id IN (
      SELECT id FROM email_sends
       WHERE status IN ('sent', 'failed', 'canceled')
         AND updated_at < ${cutoff(now, emailDays)}
         AND (body_text <> '' OR body_html IS NOT NULL)
       LIMIT ${BATCH}
    ) RETURNING 1`);
  const gateEventsPruned = await drain(deleteOlderThan("gate_events", "id", "created_at", cutoff(now, w.gateEventsDays)));
  const extensionUsagePruned = await drain(
    deleteOlderThan("extension_usage", "user_id", "coalesce(last_seen_at, window_started_at)", cutoff(now, w.extensionUsageDays))
  );
  const speechUsagePruned = await drain(deleteOlderThan("speech_usage", "id", "created_at", cutoff(now, w.speechUsageDays)));

  return {
    cronRunsPruned,
    webhookDeliveriesPruned,
    webhookRecipientsStripped,
    outboundPayloadsCleared,
    feedbackScreenshotsPruned,
    transcriptSegmentsPruned,
    emailBodiesCleared,
    gateEventsPruned,
    extensionUsagePruned,
    speechUsagePruned,
  };
}
