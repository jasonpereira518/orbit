import type { CronRunState } from "@/lib/cron-runs";
import { PURGE_MAX_ATTEMPTS } from "@/lib/data-categories";
import { hasMissedRun } from "@/lib/cron-runs";
import { MANAGED_AI_ALERTS } from "@/lib/managed-ai-policy";

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
    /**
     * The hourly job feed. Alerted on here rather than shown on `/admin/health`, because
     * that page reads two named jobs and this is not one of them — so without a condition,
     * a feed that stopped being read is indistinguishable from a quiet hiring season.
     */
    jobFeed: { lastStartedAt: Date | null; lastState: CronRunState | null };
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
  /**
   * `error_events` rows from `ai.security` in the last hour, and how many accounts they span.
   * Optional so a snapshot built before this existed still evaluates.
   */
  aiSecurityLastHour?: { events: number; accounts: number };
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
  /** Shared third-party budgets refused today: photo sources out, accounts at the hosted Apollo cap. */
  sharedBudgets: { avatarSourcesExhausted: string[]; apolloCapHits: number };
  /** Null when the caller (the scheduler) did not say what `main` is. */
  deploy: { prodSha: string | null; mainSha: string; mainCommittedAt: Date } | null;
  reauthNeeded: number;
  /** Connections holding a sync lease far longer than any run should take. */
  wedgedSyncs: number;
  /** Connections the scheduler gave up on and disarmed. */
  failingSyncs: number;
  /** `data_purge_runs` marked failed: deletions a user asked for that did not finish. */
  stuckPurges: number;
  /** Orbit's managed AI keys — the Lifetime cost exposure. See `managed-ai-ops.ts`. */
  managedAi: ManagedAiOpsFacts;
};

export type ManagedAiOpsFacts = {
  /** At least one managed key is set and `ORBIT_MANAGED_AI` is not "off". */
  configured: boolean;
  switchedOff: boolean;
  /** Accounts that resolve to Lifetime (purchase or comp). */
  lifetimeAccounts: number;
  spentLast24hMicros: number;
  spentLast30dMicros: number;
  /** Every Lifetime dollar ever booked (`billing_events.kind = 'lifetime'`), gross. */
  lifetimeCashCents: number;
  /** Accounts that have used their whole allowance this month. */
  accountsAtCap: number;
  /** Providers whose managed key was refused or throttled in the last hour. */
  failingProviders: string[];
};

/** How often a persisting condition is repeated. Info is said once. */
export const REMIND_AFTER_MS: Record<OpsSeverity, number | null> = {
  critical: 6 * 60 * 60 * 1000,
  warning: 24 * 60 * 60 * 1000,
  info: null,
};

const WEBHOOK_STREAK = 3;
export const PARTIAL_STREAK = 3;

/**
 * `ai.security` rows in an hour that open the condition. Each row is already throttled to one
 * per (kind, account) per ten minutes, so five is five distinct episodes — a single agent
 * tripping one wire once is noise; several in an hour is someone probing.
 */
export const AI_SECURITY_ALERT_EVENTS = 5;
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

/**
 * How long the job-feed sweep may be silent before it is treated as dead.
 *
 * The schedule is hourly and this is six times that — the same loose multiple the connector
 * sync gets, for the same reason: GitHub Actions schedules lag under load and are disabled
 * outright after 60 days without a commit on a public repository.
 *
 * `warning`, never `critical`: nobody is paged because an internship notification is late.
 */
const JOB_FEED_SILENT_MS = 6 * 60 * 60 * 1000;

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

  const aiSec = s.aiSecurityLastHour;
  if (aiSec && aiSec.events >= AI_SECURITY_ALERT_EVENTS) {
    out.push({
      id: "ai.security",
      // Critical when it is not one account: several accounts tripping guards in the same hour
      // looks like a poisoned shared source (a recruiter row, an event page) or a campaign.
      severity: aiSec.accounts >= 3 ? "critical" : "warning",
      title: "AI guardrails are tripping",
      detail: `${aiSec.events} AI security event(s) across ${aiSec.accounts} account(s) in the last hour — refused tool calls, oversized MCP batches, draft floods or scrubbed answers. error_events (source ai.security) holds the kind and account of each.`,
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

  // The same pair for the job feed. A `partial` is deliberately NOT alerted on: it is the
  // ordinary shape of a first run against an empty cursor, and of any run where one of
  // several feeds was briefly unreachable. Only silence and outright failure mean nobody is
  // going to find out about an opening.
  const jobFeed = s.cron.jobFeed;
  const jobFeedSilentFor = jobFeed.lastStartedAt
    ? now.getTime() - jobFeed.lastStartedAt.getTime()
    : null;
  // Null counts as missed, exactly as it does for the connector sync above: "the cron line
  // was never added" is the likeliest way this feature quietly does nothing, and it is
  // indistinguishable from a quiet hiring season from any other angle.
  if (jobFeedSilentFor === null || jobFeedSilentFor > JOB_FEED_SILENT_MS) {
    out.push({
      id: "jobfeed.schedule_missed",
      severity: "warning",
      title: "Job feed sweep has stopped running",
      detail: jobFeed.lastStartedAt
        ? `Last started ${jobFeed.lastStartedAt.toISOString()}; nobody is being told when a role opens at a company they know somebody at.`
        : "No run has ever been recorded; nobody is being told when a role opens at a company they know somebody at.",
      href: "/admin/health",
    });
  } else if (jobFeed.lastState === "failed" || jobFeed.lastState === "stale") {
    out.push({
      id: "jobfeed.run_failed",
      severity: "warning",
      title: `Job feed sweep ${jobFeed.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${jobFeed.lastStartedAt?.toISOString() ?? "unknown"} ended ${jobFeed.lastState}.`,
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
  if (s.sharedBudgets.avatarSourcesExhausted.length > 0) {
    out.push({
      id: "avatar.source_exhausted",
      severity: "info",
      title: "A shared photo source is out for today",
      detail: `${s.sharedBudgets.avatarSourcesExhausted.join(" and ")} used its whole daily allowance; photo lookups defer until the window resets.`,
      href: "/admin/health",
    });
  }
  if (s.sharedBudgets.apolloCapHits >= 1) {
    out.push({
      id: "apollo.hosted_cap_hits",
      severity: "info",
      title: "Accounts are hitting the hosted Apollo cap",
      detail: `${s.sharedBudgets.apolloCapHits} account budget(s) for hosted Apollo search or enrichment ran out today — demand against the Apollo plan.`,
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

  out.push(...managedAiConditions(s.managedAi));

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

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * Orbit's own AI keys, which Lifetime accounts run on when they bring none. A one-time
 * payment funding ongoing inference is the one open-ended cost in the product, so it gets
 * its own catalogue entries: the key breaking, the key missing, a spike, a pace that
 * outruns the revenue behind it, and accounts hitting the cap.
 */
function managedAiConditions(m: ManagedAiOpsFacts): OpsCondition[] {
  const out: OpsCondition[] = [];

  for (const provider of m.failingProviders) {
    out.push({
      id: `ai.managed_failing:${provider}`,
      severity: "critical",
      title: `Orbit's managed ${provider} key is being refused`,
      detail: `The provider rejected or throttled Orbit's own ${provider} key in the last hour — every Lifetime account without a key of its own has lost AI. Check the key and its quota.`,
      href: "/admin/health",
    });
  }

  if (m.lifetimeAccounts > 0 && !m.configured) {
    out.push({
      id: "ai.managed_unconfigured",
      severity: "warning",
      title: m.switchedOff ? "Managed AI is switched off" : "No managed AI key is configured",
      detail: m.switchedOff
        ? `ORBIT_MANAGED_AI=off, so ${m.lifetimeAccounts} Lifetime account(s) can only use AI with a key of their own.`
        : `${m.lifetimeAccounts} Lifetime account(s) were promised AI on Orbit's keys, but no ORBIT_MANAGED_*_API_KEY is set.`,
    });
  }

  if (m.spentLast24hMicros >= MANAGED_AI_ALERTS.dailySpikeMicros) {
    out.push({
      id: "ai.managed_spend_spike",
      severity: "warning",
      title: "Managed AI spend is spiking",
      detail: `${usd(m.spentLast24hMicros)} on Orbit's AI keys in the last 24 hours (threshold ${usd(MANAGED_AI_ALERTS.dailySpikeMicros)}).`,
      href: "/admin/billing/costs",
    });
  }

  if (m.spentLast30dMicros >= MANAGED_AI_ALERTS.runwayMinSpendMicros) {
    const annualMicros = (m.spentLast30dMicros * 365) / 30;
    const years = (m.lifetimeCashCents * 10_000) / annualMicros;
    if (years < MANAGED_AI_ALERTS.runwayYears) {
      out.push({
        id: "ai.managed_runway",
        severity: "warning",
        title: "Managed AI is outpacing Lifetime revenue",
        detail:
          m.lifetimeCashCents > 0
            ? `At the last 30 days' pace (${usd(m.spentLast30dMicros)}), managed AI costs ${usd(annualMicros)} a year — every Lifetime dollar booked so far covers ${years.toFixed(1)} year(s) of it. Revisit the cap or the price.`
            : `${usd(m.spentLast30dMicros)} of managed AI in the last 30 days with no Lifetime revenue booked behind it (comps or demo accounts).`,
        href: "/admin/billing/costs",
      });
    }
  }

  if (m.accountsAtCap > 0) {
    out.push({
      id: "ai.managed_cap_hit",
      severity: "info",
      title: "Lifetime accounts are hitting the AI cap",
      detail: `${m.accountsAtCap} account(s) have used this month's whole managed-AI allowance and are back to bring-your-own-key until the 1st. A rising count says the cap is too tight for real use.`,
      href: "/admin/billing/costs",
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
