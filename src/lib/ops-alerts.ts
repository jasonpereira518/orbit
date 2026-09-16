import type { CronRunState } from "@/lib/cron-runs";
import { PURGE_MAX_ATTEMPTS } from "@/lib/data-categories";
import { hasMissedRun } from "@/lib/cron-runs";

/**
 * Known-condition alerting: the catalogue, and the state machine that keeps it quiet.
 *
 * Sentry owns the exceptions nobody anticipated. This owns the conditions we DID
 * anticipate — a cron that stopped running, a webhook secret that rolled, an import that
 * wedged — evaluated from the same predicates the admin console reads, on a schedule,
 * with a memory of what was already said. That memory (`ops_alert_state`) is what makes
 * a ten-minute sweep livable in Slack: a condition is announced when it OPENS, reminded on
 * a per-severity cadence while it persists, and announced once more when it RECOVERS.
 *
 * Pure on purpose: no DB, no `next/server`, no clock. `src/lib/ops-sweep.ts` loads the
 * snapshot, persists the transitions and delivers; `scripts/smoke-ops-alerts.ts` pins
 * every predicate and transition here.
 *
 * Two conditions are deliberately ABSENT: "the health endpoint is down" and "the sweep
 * itself stopped running". Both are owned by the external uptime monitor, because a
 * process cannot report its own absence.
 */

export type OpsSeverity = "critical" | "warning" | "info";

export type OpsCondition = {
  /** Stable id; a `:{qualifier}` suffix makes one catalogue entry into several alerts. */
  id: string;
  severity: OpsSeverity;
  title: string;
  detail: string;
  /** Where to look, relative to the app. */
  href?: string;
};

export type WebhookOutcome = "handled" | "ignored" | "invalid" | "error";

/** Everything the catalogue reads. Assembled by the sweep from the admin health readers. */
export type OpsSnapshot = {
  cron: {
    processStalled: { lastStartedAt: Date | null; lastState: CronRunState | null };
    syncRun: { lastStartedAt: Date | null; lastState: CronRunState | null };
    /** The outbound webhook drain (`/api/webhooks/outbound/drain`), every ten minutes. */
    drain: { lastStartedAt: Date | null; lastState: CronRunState | null };
  };
  /** The last PARTIAL_STREAK process-stalled states, newest first. */
  processStalledRecent: CronRunState[];
  /** Distinct accounts and kinds with a backfill.failed row in the last day. */
  backfillFailures24h: { accounts: number; kinds: string[] };
  /** Most recent delivery outcomes per source, newest first. */
  webhooks: { clerk: WebhookOutcome[]; stripe: WebhookOutcome[]; resend: WebhookOutcome[] };
  stripeCheckoutErrorsLastHour: number;
  /** `error_events` rows from `resend.rejected` in the last hour. */
  resendRejectedLastHour: number;
  wedgedImports: number;
  failedImportsLast24h: number;
  outreach: { overdue: number; oldestOverdueDays: number | null };
  aiOutages: Array<{ provider: string | null; errorKind: string; accounts: number }>;
  errorEventsLastHour: number;
  perfSlowLastHour: number;
  missingRequiredEnv: string[];
  /** EXPECTED_IN_PRODUCTION names that are unset (production only). */
  missingExpectedEnv: string[];
  /** The app role's statement_timeout ("20s", "0" = none). Production only. */
  statementTimeout: string | null;
  /** stripe.unattributed rows in the last day: checkout fulfilments vs everything else. */
  stripeUnattributed24h: { fulfilments: number; other: number };
  /** Accounts with an embedding flag older than EMBEDDING_BACKLOG_STALE_HOURS, and the oldest flag. */
  embeddingBacklog: { accounts: number; oldestAt: Date | null };
  /** How long the most overdue armed connection has waited; null when none is due. */
  syncOldestDueAgeMs: number | null;
  /** Last 24 h: embedding_failures rows, and accounts with a `quota` usage failure. */
  aiRefusals24h: { unembeddable: number; quotaAccounts: number };
  /** Active calendar-scoped Google connections disarmed with an error. */
  calendarDisarmed: number;
  /** Null when the caller (the scheduler) did not say what `main` is. */
  deploy: { prodSha: string | null; mainSha: string; mainCommittedAt: Date } | null;
  reauthNeeded: number;
  /** Connections holding a sync lease far longer than any run should take. */
  wedgedSyncs: number;
  /** Connections the scheduler gave up on and disarmed. */
  failingSyncs: number;
  /** `data_purge_runs` marked failed: deletions a user asked for that did not finish. */
  stuckPurges: number;
};

/** How often a persisting condition is repeated. Info is said once. */
export const REMIND_AFTER_MS: Record<OpsSeverity, number | null> = {
  critical: 6 * 60 * 60 * 1000,
  warning: 24 * 60 * 60 * 1000,
  info: null,
};

const WEBHOOK_STREAK = 3;
export const PARTIAL_STREAK = 3;
const FAILED_IMPORT_BURST = 3;
const ERROR_BURST = 5;
const PERF_SLOW_BURST = 3;
const OUTAGE_ACCOUNTS = 2;
const BACKFILL_FAILING_ACCOUNTS = 2;
/** A starting value: one odd row is noise, a spike means the provider refuses a content shape. */
export const UNEMBEDDABLE_SPIKE = 10;
const DRIFT_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Several hourly backfill passes. Must stay in step with the `'6 hours'` interval in
 * `loadOpsSnapshot`'s backlog query — the SQL cannot interpolate this constant safely.
 */
export const EMBEDDING_BACKLOG_STALE_HOURS = 6;

const isRejected = (o: WebhookOutcome) => o === "invalid" || o === "error";

/**
 * How long the connector sync may be silent before it is treated as dead.
 *
 * The schedule is every 15 minutes; this is twelve times that. Loose on purpose — GitHub
 * Actions schedules lag 5-30 minutes under load and are disabled entirely after 60 days
 * without a commit on a public repo, and it is the second failure this needs to catch.
 */
const SYNC_SCHEDULE_SILENT_MS = 3 * 60 * 60 * 1000;

/** A connection this overdue while runs are happening means demand outgrew a run. */
export const SYNC_LAG_ALERT_MS = 2 * 60 * 60 * 1000;

/** Disarmed calendars at once that read as a Google-side change rather than user churn. */
export const CALENDAR_DISARM_BURST = 5;

export function evaluateOpsConditions(s: OpsSnapshot, now: Date): OpsCondition[] {
  const out: OpsCondition[] = [];

  const cron = s.cron.processStalled;
  if (hasMissedRun(cron.lastStartedAt, now)) {
    out.push({
      id: "cron.missed",
      severity: "warning",
      title: "Nightly job has not run",
      detail: cron.lastStartedAt
        ? `Last started ${cron.lastStartedAt.toISOString()}; stalled imports and housekeeping are not being picked up.`
        : "No run has ever been recorded; stalled imports and housekeeping are not being picked up.",
      href: "/admin/health",
    });
  } else if (cron.lastState === "failed" || cron.lastState === "stale") {
    out.push({
      id: "cron.failed",
      severity: "warning",
      title: `Nightly job ${cron.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${cron.lastStartedAt?.toISOString() ?? "unknown"} ended ${cron.lastState}.`,
      href: "/admin/health",
    });
  } else if (
    s.processStalledRecent.length >= PARTIAL_STREAK &&
    s.processStalledRecent.slice(0, PARTIAL_STREAK).every((state) => state === "partial")
  ) {
    out.push({
      id: "cron.partial_streak",
      severity: "warning",
      title: "Nightly job keeps finishing partial",
      detail: `The last ${PARTIAL_STREAK} runs ended partial — one housekeeping step is failing every time. The run stats on /admin/health show which counter stopped moving.`,
      href: "/admin/health",
    });
  }

  // The drain's own `partial` means customer endpoints refused deliveries, which is theirs to
  // fix; `failed`/`stale` means the drain itself broke and nothing is being retried.
  const drain = s.cron.drain;
  if (drain.lastState === "failed" || drain.lastState === "stale") {
    out.push({
      id: "drain.failed",
      severity: "warning",
      title: `Outbound webhook drain ${drain.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${drain.lastStartedAt?.toISOString() ?? "unknown"} ended ${drain.lastState}; customer webhooks are not being retried.`,
      href: "/admin/health",
    });
  }

  for (const [source, severity] of [
    ["clerk", "critical"],
    ["stripe", "critical"],
    ["resend", "warning"],
  ] as const) {
    const recent = s.webhooks[source].slice(0, WEBHOOK_STREAK);
    if (recent.length >= WEBHOOK_STREAK && recent.every(isRejected)) {
      out.push({
        id: `webhook.invalid_streak:${source}`,
        severity,
        title: `${source} webhooks are being rejected`,
        detail: `The last ${WEBHOOK_STREAK} ${source} deliveries failed verification or handling — usually a rolled signing secret.`,
        href: "/admin/health",
      });
    }
  }

  if (s.stripeCheckoutErrorsLastHour > 0) {
    out.push({
      id: "stripe.checkout_error",
      severity: "critical",
      title: "Stripe checkout is failing",
      detail: `${s.stripeCheckoutErrorsLastHour} checkout attempt(s) errored in the last hour — nobody can pay.`,
      href: "/admin/health",
    });
  }

  const unattributed = s.stripeUnattributed24h;
  if (unattributed.fulfilments + unattributed.other > 0) {
    out.push({
      id: "stripe.unattributed",
      severity: unattributed.fulfilments > 0 ? "critical" : "warning",
      title: unattributed.fulfilments > 0 ? "Someone paid and has no plan" : "Stripe events match no account",
      detail: `${unattributed.fulfilments} checkout fulfilment(s) and ${unattributed.other} other Stripe event(s) in the last day matched no Orbit account. error_events (source stripe.unattributed) holds each event id.`,
      href: "/admin/health",
    });
  }

  if (s.resendRejectedLastHour > 0) {
    out.push({
      id: "resend.rejected",
      severity: "warning",
      title: "Resend is refusing Orbit's email",
      detail: `${s.resendRejectedLastHour} email(s) refused in the last hour — usually RESEND_FROM_EMAIL is on a domain Resend has not verified, which refuses every send.`,
      href: "/admin/health",
    });
  }

  if (s.wedgedImports > 0) {
    out.push({
      id: "import.wedged",
      severity: "warning",
      title: "An import is wedged",
      detail: `${s.wedgedImports} import(s) have been 'processing' with no progress for over 10 minutes.`,
      href: "/admin/health",
    });
  }
  if (s.failedImportsLast24h >= FAILED_IMPORT_BURST) {
    out.push({
      id: "import.failed_burst",
      severity: "warning",
      title: "Imports are failing",
      detail: `${s.failedImportsLast24h} imports failed in the last 24 hours.`,
      href: "/admin/health",
    });
  }

  // Freshness for the connector sync, with its OWN threshold rather than `hasMissedRun`.
  // That helper's 25-hour window is calibrated for the nightly job; applied to a job that is
  // supposed to run every fifteen minutes it would stay silent for a full day of no syncing.
  // Three hours is deliberately loose — GitHub's scheduler routinely lags 5-30 minutes, and
  // this must alert on "the schedule is dead", not on "the schedule is late".
  const sync = s.cron.syncRun;
  const syncSilentFor = sync.lastStartedAt ? now.getTime() - sync.lastStartedAt.getTime() : null;
  if (syncSilentFor === null || syncSilentFor > SYNC_SCHEDULE_SILENT_MS) {
    out.push({
      id: "sync.schedule_missed",
      severity: "warning",
      title: "Connector sync has stopped running",
      detail: sync.lastStartedAt
        ? `Last started ${sync.lastStartedAt.toISOString()}; mailboxes and calendars are not being synced.`
        : "No run has ever been recorded; mailboxes and calendars are not being synced.",
      href: "/admin/health",
    });
  } else if (sync.lastState === "failed" || sync.lastState === "stale") {
    out.push({
      id: "sync.run_failed",
      severity: "warning",
      title: `Connector sync ${sync.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${sync.lastStartedAt?.toISOString() ?? "unknown"} ended ${sync.lastState}.`,
      href: "/admin/health",
    });
  }

  // More connections due than one run can take. Only while the schedule itself is alive —
  // a dead schedule makes every connection overdue and is already sync.schedule_missed.
  if (
    syncSilentFor !== null &&
    syncSilentFor <= SYNC_SCHEDULE_SILENT_MS &&
    (s.syncOldestDueAgeMs ?? 0) > SYNC_LAG_ALERT_MS
  ) {
    out.push({
      id: "sync.lagging",
      severity: "warning",
      title: "Connector sync is falling behind",
      detail: `The most overdue connection has waited ${((s.syncOldestDueAgeMs ?? 0) / 3_600_000).toFixed(1)} h — more accounts are due than a run can sync.`,
      href: "/admin/health",
    });
  }

  // The sync equivalents of the two import conditions above. A wedged sync is invisible
  // otherwise: the connection simply stops updating, and no error is raised anywhere, because
  // the invocation that held the lease was killed rather than failing.
  if (s.wedgedSyncs > 0) {
    out.push({
      id: "sync.wedged",
      severity: "warning",
      title: "A connector sync is wedged",
      detail: `${s.wedgedSyncs} connection(s) have held a sync lease for over 15 minutes.`,
      href: "/admin/health",
    });
  }
  if (s.failingSyncs > 0) {
    out.push({
      id: "sync.failing",
      severity: "warning",
      title: "Connector sync has given up on an account",
      detail: `${s.failingSyncs} connection(s) were disarmed after repeated sync failures and will not retry until the user reconnects.`,
      href: "/admin/health",
    });
  }

  // `sync.failing` above already says "we gave up on an account". This is the burst: many
  // calendars disarmed at once is a Google-side change (a scope, an API, a quota), not churn.
  if (s.calendarDisarmed >= CALENDAR_DISARM_BURST) {
    out.push({
      id: "calendar.disarmed",
      severity: "info",
      title: "Many calendar syncs are disarmed",
      detail: `${s.calendarDisarmed} Google calendar connections are disarmed with an error — check for a Google-side change before blaming users.`,
      href: "/admin/health",
    });
  }

  if (s.outreach.overdue > 0 && (s.outreach.oldestOverdueDays ?? 0) >= 1) {
    out.push({
      id: "outreach.overdue",
      severity: "warning",
      title: "Scheduled outreach is not sending",
      detail: `${s.outreach.overdue} message(s) overdue; the oldest by ${s.outreach.oldestOverdueDays?.toFixed(1)} day(s).`,
      href: "/admin/health",
    });
  }

  for (const o of s.aiOutages) {
    if (o.accounts < OUTAGE_ACCOUNTS) continue;
    const provider = o.provider ?? "unknown";
    out.push({
      id: `ai.provider_outage:${provider}`,
      severity: "warning",
      title: `${provider} is failing across accounts`,
      detail: `'${o.errorKind}' errors from ${o.accounts} accounts in the last day — the provider, not one user's key.`,
      href: "/admin/health",
    });
  }

  if (s.backfillFailures24h.accounts >= BACKFILL_FAILING_ACCOUNTS) {
    out.push({
      id: "backfill.failed",
      severity: "warning",
      title: "Background backfills are failing",
      detail: `${s.backfillFailures24h.kinds.join(" and ")} backfill failed for ${s.backfillFailures24h.accounts} accounts in the last day — the provider or Orbit, not one user's key.`,
      href: "/admin/health",
    });
  }

  if (s.embeddingBacklog.accounts >= 1) {
    const oldestHours = s.embeddingBacklog.oldestAt
      ? (now.getTime() - s.embeddingBacklog.oldestAt.getTime()) / 3_600_000
      : EMBEDDING_BACKLOG_STALE_HOURS;
    out.push({
      id: "embedding.backlog",
      severity: "warning",
      title: "Semantic search is falling behind",
      detail: `${s.embeddingBacklog.accounts} account(s) have contacts waiting over ${EMBEDDING_BACKLOG_STALE_HOURS} h for search embeddings (oldest ${oldestHours.toFixed(1)} h), so search and chat fall back to keywords for them.`,
      href: "/admin/health",
    });
  }

  if (s.aiRefusals24h.unembeddable >= UNEMBEDDABLE_SPIKE) {
    out.push({
      id: "embedding.unembeddable",
      severity: "warning",
      title: "The embedding provider is refusing content",
      detail: `${s.aiRefusals24h.unembeddable} contacts or meetings were marked unembeddable in the last day — a spike means the provider started refusing a content shape, not one odd row.`,
      href: "/admin/health",
    });
  }
  if (s.aiRefusals24h.quotaAccounts >= 1) {
    out.push({
      id: "ai.quota_failures",
      severity: "info",
      title: "Accounts are out of AI provider credit",
      detail: `${s.aiRefusals24h.quotaAccounts} account(s) hit a quota or empty-balance error in the last day. Each already sees a "top up" alert; this is the count.`,
      href: "/admin/health",
    });
  }

  if (s.errorEventsLastHour >= ERROR_BURST) {
    out.push({
      id: "errors.burst",
      severity: "warning",
      title: "Error events are spiking",
      detail: `${s.errorEventsLastHour} error events in the last hour (the table is throttled, so this is a real burst).`,
      href: "/admin/health",
    });
  }
  if (s.perfSlowLastHour >= PERF_SLOW_BURST) {
    out.push({
      id: "perf.slow_burst",
      severity: "warning",
      title: "Slow calls are piling up",
      detail: `${s.perfSlowLastHour} calls over 10 s in the last hour — check perf.slow rows for which one.`,
      href: "/admin/health",
    });
  }

  if (s.missingRequiredEnv.length > 0) {
    out.push({
      id: "config.missing",
      severity: "warning",
      title: "Production is missing required configuration",
      detail: `Unset: ${s.missingRequiredEnv.join(", ")}.`,
    });
  }

  // Persisted even though it can never reach Slack (see runOpsSweep): this row IS the alert,
  // on /admin/health and in the deep /api/health view.
  if (s.missingExpectedEnv.includes("SLACK_OPS_WEBHOOK_URL")) {
    out.push({
      id: "config.alerts_undeliverable",
      severity: "warning",
      title: "Alerts are not reaching Slack",
      detail: "SLACK_OPS_WEBHOOK_URL is unset in production, so every alert stays on /admin/health until someone looks.",
      href: "/admin/health",
    });
  }

  if (s.statementTimeout === "0") {
    out.push({
      id: "config.statement_timeout_unbounded",
      severity: "warning",
      title: "Database queries have no time limit",
      detail: "The app role's statement_timeout is 0, so one runaway query can hold the shared compute for every user. Run the ALTER ROLE in docs/RUNBOOK.md → Neon one-time settings.",
      href: "/admin/health",
    });
  }

  if (
    s.deploy &&
    s.deploy.prodSha !== s.deploy.mainSha &&
    now.getTime() - s.deploy.mainCommittedAt.getTime() > DRIFT_AFTER_MS
  ) {
    out.push({
      id: "deploy.drift",
      severity: "warning",
      title: "Production is behind main",
      detail: `Production runs ${s.deploy.prodSha?.slice(0, 7) ?? "unknown"} but main has been at ${s.deploy.mainSha.slice(0, 7)} since ${s.deploy.mainCommittedAt.toISOString()} — a failed build is probably pinning the last good deploy.`,
    });
  }

  if (s.reauthNeeded > 0) {
    out.push({
      id: "reauth.needed",
      severity: "info",
      title: "Accounts need to reconnect a mailbox",
      detail: `${s.reauthNeeded} Gmail/Outlook connection(s) need the user to re-authorize.`,
      href: "/admin/health",
    });
  }

  // Critical, not warning: a user was told their data was deleted, and it is still here.
  if (s.stuckPurges > 0) {
    out.push({
      id: "purge.stuck",
      severity: "critical",
      title: "An account deletion is stuck",
      detail: `${s.stuckPurges} deletion run(s) stopped after ${PURGE_MAX_ATTEMPTS} attempts — rows the user asked to delete are still in the database. See data_purge_runs.last_error.`,
      href: "/admin/health",
    });
  }

  return out;
}

/** A persisted row of `ops_alert_state`. */
export type OpsAlertRow = {
  id: string;
  severity: OpsSeverity;
  active: boolean;
  openedAt: Date;
  lastSeenAt: Date;
  lastNotifiedAt: Date | null;
  notifyCount: number;
  detail: Record<string, unknown>;
};

export type OpsTransitions = {
  /** Newly active (or re-activated, or escalated): announce. */
  open: OpsCondition[];
  /** Still active past the reminder cadence: announce again. */
  remind: OpsCondition[];
  /** Was active, no longer true: announce the recovery. */
  recover: OpsAlertRow[];
  /** Still active, nothing to say. */
  unchanged: OpsCondition[];
};

export function planTransitions(
  previous: OpsAlertRow[],
  conditions: OpsCondition[],
  now: Date
): OpsTransitions {
  const prevById = new Map(previous.map((r) => [r.id, r]));
  const currentIds = new Set(conditions.map((c) => c.id));
  const out: OpsTransitions = { open: [], remind: [], recover: [], unchanged: [] };

  for (const c of conditions) {
    const prev = prevById.get(c.id);
    // `lastNotifiedAt === null` on an active row means the sweep persisted the condition but
    // Slack never took the message (see runOpsSweep). Offer it again until it lands.
    if (!prev || !prev.active || prev.severity !== c.severity || prev.lastNotifiedAt === null) {
      out.open.push(c);
      continue;
    }
    const cadence = REMIND_AFTER_MS[c.severity];
    const last = prev.lastNotifiedAt?.getTime() ?? prev.openedAt.getTime();
    if (cadence != null && now.getTime() - last >= cadence) out.remind.push(c);
    else out.unchanged.push(c);
  }

  for (const row of previous) {
    if (row.active && !currentIds.has(row.id)) out.recover.push(row);
  }

  return out;
}
