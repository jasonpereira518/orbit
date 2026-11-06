import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";

/**
 * Retention for the tables that grew without a limit (ANALYTICS_AUDIT.md §5.4), run from the
 * hourly housekeeping route next to the sweeps for `usage_events` and `error_events`.
 *
 * Every delete is BOUNDED, in batches under a wall-clock budget, for the reason
 * `prunePageViews` gives: one unbounded DELETE over a neglected table holds its locks for as
 * long as it takes, inside a function with a timeout. A backlog left when the budget runs out
 * is the next hour's.
 *
 * What is deliberately NOT here: `billing_events` and `admin_audit_log` (financial and audit
 * records), `feedback` (the user's own words, kept until they delete it), and `email_sends`,
 * which is the person's own sent-mail history and is read by the app.
 */

/** `cron_runs` writes ~700 rows a day from the ten-minute steps alone; 90 days is far past any view. */
export const CRON_RUN_RETENTION_DAYS = 90;
/** Webhook delivery log: enough to debug a bad week, not a permanent record of recipients. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 90;
/** Resend deliveries carry recipient email addresses in `detail`; those go sooner than the row. */
export const WEBHOOK_RECIPIENT_RETENTION_DAYS = 30;
/** Refusals feed the demand page and conversion timing, which look back a year at most. */
export const GATE_EVENT_RETENTION_DAYS = 400;
/** Product events: a year of cohorts plus a month, the longest window any metric reads. */
export const PRODUCT_EVENT_RETENTION_DAYS = 400;
/**
 * A waitlist row that became an account keeps its email and name this long after the invite
 * was accepted, then is anonymised. Anonymised, not deleted: a deleted row would take the
 * referral credit it earned its referrer with it.
 */
export const CONVERTED_WAITLIST_RETENTION_DAYS = 30;

const PRUNE_BATCH = 5_000;
const BUDGET_MS = 15_000;

const TABLES = {
  gate_events: "created_at",
  cron_runs: "started_at",
  webhook_deliveries: "created_at",
  product_events: "created_at",
} as const;

type PrunableTable = keyof typeof TABLES;

/** Delete rows older than `days`, in bounded batches. Table and column come from the constant above. */
export async function pruneTable(table: PrunableTable, days: number, now: Date = new Date()): Promise<number> {
  const column = TABLES[table];
  const db = await getDb();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const deadline = deadlineAfter(BUDGET_MS);
  let pruned = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH d AS (
        DELETE FROM ${sql.raw(table)} WHERE id IN (
          SELECT id FROM ${sql.raw(table)} WHERE ${sql.raw(column)} < ${cutoff} LIMIT ${PRUNE_BATCH}
        )
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM d
    `);
    const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    pruned += n;
    if (n < PRUNE_BATCH || deadlineReached(deadline)) return pruned;
  }
}

/**
 * Drop the recipient addresses from Resend webhook rows older than the recipient window. The
 * row stays (its outcome and reason are what debugging needs); the address does not.
 */
export async function scrubWebhookRecipients(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - WEBHOOK_RECIPIENT_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await db.execute(sql`
    WITH u AS (
      UPDATE webhook_deliveries
      SET detail = detail - 'recipients'
      WHERE created_at < ${cutoff} AND detail ? 'recipients'
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM u
  `);
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
}

/**
 * Anonymise waitlist rows whose owner became an account more than 30 days ago. The email, names
 * and the referral slug (which publishes the email's local part) go; the row, its place in the
 * line, its referrer link and its first-touch attribution stay, so the rest of the list and the
 * acquisition numbers do not change. Idempotent: an anonymised row is skipped.
 */
export async function anonymiseConvertedWaitlist(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - CONVERTED_WAITLIST_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await db.execute(sql`
    WITH u AS (
      UPDATE interest_list_signups
      SET email = 'anonymised-' || id::text || '@invalid.invalid',
          first_name = NULL,
          last_name = NULL,
          referral_slug = NULL,
          share_token = NULL,
          unsubscribe_token = 'anon-' || gen_random_uuid()::text,
          signup_event_label = NULL
      WHERE converted_at IS NOT NULL
        AND converted_at < ${cutoff}
        AND email NOT LIKE 'anonymised-%'
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM u
  `);
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
}

/** Everything above, with one stats object for the cron ledger. */
export async function runAnalyticsRetention(now: Date = new Date()) {
  return {
    cronRunsPruned: await pruneTable("cron_runs", CRON_RUN_RETENTION_DAYS, now),
    webhookDeliveriesPruned: await pruneTable("webhook_deliveries", WEBHOOK_DELIVERY_RETENTION_DAYS, now),
    webhookRecipientsScrubbed: await scrubWebhookRecipients(now),
    gateEventsPruned: await pruneTable("gate_events", GATE_EVENT_RETENTION_DAYS, now),
    productEventsPruned: await pruneTable("product_events", PRODUCT_EVENT_RETENTION_DAYS, now),
    waitlistAnonymised: await anonymiseConvertedWaitlist(now),
  };
}
