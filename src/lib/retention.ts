import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { del } from "@/lib/blob-lazy";
import { hasBlobStorage } from "@/lib/contact-avatar";

/**
 * How long data is kept when nobody deletes it: one declarative table, run hourly by
 * `process-stalled` (PRIVACY_PLAN.md 2.1).
 *
 * Before this, a few tables had their own prune (page views, usage events, error events, the
 * AI cache) and everything else — webhook payloads, settled AI batches, the raw rows of every
 * import, feedback screenshots, a cron ledger — was kept forever.
 *
 * DELETING IS IRREVERSIBLE, so this starts in report mode: with `ORBIT_RETENTION` unset every
 * rule only counts what it would remove, and the counts land in the job's `cron_runs` stats.
 * Setting `ORBIT_RETENTION=apply` lets the rules marked `ready` delete. Rules marked
 * `counsel` keep counting whatever the switch says: their periods are proposals waiting on a
 * legal decision (PRIVACY_PLAN.md §6, Q12), and turning one on is a code change that names
 * the decision.
 *
 * Every apply is bounded (`RETENTION_BATCH` rows per rule per run); a backlog drains over
 * successive hours.
 */
export const RETENTION_BATCH = 2000;

type Rule = {
  id: string;
  /** What goes, in words for the cron stats and the privacy page. */
  what: string;
  /** `ready`: applies when ORBIT_RETENTION=apply. `counsel`: always report-only. */
  status: "ready" | "counsel";
  /** Rows the rule would act on (one `n` column). */
  count: SQL;
  /** The bounded write; returns the affected ids. Absent for report-only rules. */
  apply?: (limit: number) => Promise<number>;
};

const interval = (days: number) => sql.raw(`interval '${days} days'`);

async function returningCount(query: SQL): Promise<number> {
  const db = await getDb();
  return rowsOf(await db.execute(query)).length;
}

/** `DELETE FROM table WHERE id IN (SELECT id ... WHERE cond LIMIT n) RETURNING id`. */
function boundedDelete(table: string, where: SQL) {
  return (limit: number) =>
    returningCount(sql`
      DELETE FROM ${sql.identifier(table)} WHERE id IN (
        SELECT id FROM ${sql.identifier(table)} WHERE ${where} LIMIT ${limit}
      ) RETURNING id`);
}

const settledDeliveries = sql`status IN ('delivered', 'dead') AND created_at < now() - ${interval(30)}`;
const settledBatches = sql`status <> 'submitted' AND coalesce(completed_at, updated_at) < now() - ${interval(30)}`;
const settledAgentSends = sql`status IN ('sent', 'rejected', 'failed', 'expired') AND updated_at < now() - ${interval(30)}`;
const importRowsDone = sql`status = 'done' AND payload <> '{}'::jsonb AND updated_at < now() - ${interval(8)}`;
const importRowsOther = sql`status <> 'done' AND status <> 'pending' AND payload <> '{}'::jsonb AND updated_at < now() - ${interval(30)}`;
const resolvedFeedback = sql`status = 'resolved' AND coalesce(status_changed_at, created_at) < now() - ${interval(365)}`;

export const RETENTION_RULES: readonly Rule[] = [
  {
    id: "gate_events.13mo",
    what: "Upgrade-prompt events older than 13 months",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM gate_events WHERE created_at < now() - ${interval(395)}`,
    apply: boundedDelete("gate_events", sql`created_at < now() - ${interval(395)}`),
  },
  {
    id: "speech_usage.13mo",
    what: "Transcription-minute records older than 13 months",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM speech_usage WHERE created_at < now() - ${interval(395)}`,
    apply: boundedDelete("speech_usage", sql`created_at < now() - ${interval(395)}`),
  },
  {
    id: "webhook_deliveries.13mo",
    what: "The log of webhooks Clerk, Stripe and Resend sent, older than 13 months (deletions are kept as tombstones instead)",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE created_at < now() - ${interval(395)}`,
    apply: boundedDelete("webhook_deliveries", sql`created_at < now() - ${interval(395)}`),
  },
  {
    id: "outbound_webhook_deliveries.30d",
    what: "Delivered or abandoned webhook payloads sent to your own endpoints, after 30 days",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE ${settledDeliveries}`,
    apply: boundedDelete("outbound_webhook_deliveries", settledDeliveries),
  },
  {
    id: "connector_outbox.30d",
    what: "Delivered or abandoned connector pushes, after 30 days",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM connector_outbox WHERE ${settledDeliveries}`,
    apply: boundedDelete("connector_outbox", settledDeliveries),
  },
  {
    id: "ai_batch_jobs.30d",
    what: "Finished background-AI batch records, after 30 days",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM ai_batch_jobs WHERE ${settledBatches}`,
    apply: boundedDelete("ai_batch_jobs", settledBatches),
  },
  {
    id: "agent_send_requests.30d",
    what: "Assistant-drafted emails that were sent, declined or expired, after 30 days",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM agent_send_requests WHERE ${settledAgentSends}`,
    apply: boundedDelete("agent_send_requests", settledAgentSends),
  },
  {
    id: "cron_runs.90d",
    what: "Scheduled-job run records older than 90 days",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM cron_runs WHERE started_at < now() - ${interval(90)}`,
    apply: boundedDelete("cron_runs", sql`started_at < now() - ${interval(90)}`),
  },
  {
    id: "import_job_rows.payload",
    what: "The raw source rows of an import (message threads, contact rows): 8 days after a row was imported (the undo window is 7), 30 days for rows that failed or were skipped. Counts stay",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM import_job_rows WHERE (${importRowsDone}) OR (${importRowsOther})`,
    apply: (limit) =>
      returningCount(sql`
        UPDATE import_job_rows SET payload = '{}'::jsonb, revert_snapshot = NULL
         WHERE id IN (SELECT id FROM import_job_rows WHERE (${importRowsDone}) OR (${importRowsOther}) LIMIT ${limit})
        RETURNING id`),
  },
  {
    id: "feedback.resolved.12mo",
    what: "Feedback and its screenshots, 12 months after it was resolved",
    status: "ready",
    count: sql`SELECT count(*)::int AS n FROM feedback WHERE ${resolvedFeedback}`,
    apply: async (limit) => {
      const db = await getDb();
      const doomed = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM feedback WHERE ${resolvedFeedback} LIMIT ${limit}`)).map((r) => r.id);
      if (doomed.length === 0) return 0;
      const list = sql`ARRAY[${sql.join(doomed.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
      // The screenshot objects have no foreign key; read them before the rows go (as the purge does).
      const shots = rowsOf<{ blob_url: string | null }>(await db.execute(sql`SELECT blob_url FROM feedback_screenshots WHERE feedback_id = ANY(${list})`));
      await db.execute(sql`DELETE FROM feedback_screenshots WHERE feedback_id = ANY(${list})`);
      const removed = await returningCount(sql`DELETE FROM feedback WHERE id = ANY(${list}) RETURNING id`);
      const urls = shots.map((s) => s.blob_url).filter((u): u is string => Boolean(u));
      if (urls.length && hasBlobStorage()) await del(urls).catch(() => {});
      return removed;
    },
  },
  // ---- counsel: report-only until a legal decision is recorded here -----------------------
  {
    id: "email_sends.body.12mo",
    what: "Bodies of emails sent from Orbit, 12 months after sending (headers kept)",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM email_sends WHERE status = 'sent' AND sent_at < now() - ${interval(365)} AND body_text <> ''`,
  },
  {
    id: "admin_audit_log.24mo",
    what: "Operator audit-log entries older than 24 months",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE created_at < now() - ${interval(730)}`,
  },
  {
    id: "interest_list_signups.24mo",
    what: "Waitlist entries with no email for 24 months",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM interest_list_signups WHERE coalesce(follow_up_sent_at, created_at) < now() - ${interval(730)}`,
  },
  {
    id: "broadcast_recipients.12mo",
    what: "The record of who received a waitlist broadcast, after 12 months",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM broadcast_recipients WHERE created_at < now() - ${interval(365)}`,
  },
  {
    id: "import_files.30d",
    what: "Raw LinkedIn export files, 30 days after import",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM import_files WHERE created_at < now() - ${interval(30)}`,
  },
  {
    id: "accounts.inactive.24mo",
    what: "Free accounts with no sign-in for 24 months (would be emailed at 23, deleted at 24)",
    status: "counsel",
    count: sql`SELECT count(*)::int AS n FROM user_settings
                WHERE coalesce(last_active_at, created_at) < now() - ${interval(730)}
                  AND coalesce(subscription_status, '') NOT IN ('active', 'trialing', 'past_due')
                  AND lifetime_purchased_at IS NULL AND comped_plan IS NULL`,
  },
];

export type RetentionMode = "report" | "apply";

export function retentionMode(): RetentionMode {
  return process.env.ORBIT_RETENTION === "apply" ? "apply" : "report";
}

export type RetentionRun = {
  mode: RetentionMode;
  /** Per rule: rows it acts on (report) or removed (apply), or the error it hit. */
  rules: Record<string, { status: Rule["status"]; due: number; applied: number } | { error: string }>;
};

/** One pass over every rule. Never throws: a failing rule is recorded and the rest still run. */
export async function runRetention(opts: { mode?: RetentionMode; limit?: number } = {}): Promise<RetentionRun> {
  const mode = opts.mode ?? retentionMode();
  const limit = opts.limit ?? RETENTION_BATCH;
  const db = await getDb();
  const run: RetentionRun = { mode, rules: {} };
  for (const rule of RETENTION_RULES) {
    try {
      const due = Number(rowsOf<{ n: number }>(await db.execute(rule.count))[0]?.n ?? 0);
      const applied = mode === "apply" && rule.status === "ready" && rule.apply && due > 0 ? await rule.apply(limit) : 0;
      run.rules[rule.id] = { status: rule.status, due, applied };
    } catch (err) {
      run.rules[rule.id] = { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }
  return run;
}
