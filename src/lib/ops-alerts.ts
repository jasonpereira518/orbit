import type { CronRunState } from "@/lib/cron-runs";
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
  };
  /** Most recent delivery outcomes per source, newest first. */
  webhooks: { clerk: WebhookOutcome[]; stripe: WebhookOutcome[]; resend: WebhookOutcome[] };
  stripeCheckoutErrorsLastHour: number;
  wedgedImports: number;
  failedImportsLast24h: number;
  outreach: { overdue: number; oldestOverdueDays: number | null };
  aiOutages: Array<{ provider: string | null; errorKind: string; accounts: number }>;
  errorEventsLastHour: number;
  perfSlowLastHour: number;
  missingRequiredEnv: string[];
  /** Null when the caller (the scheduler) did not say what `main` is. */
  deploy: { prodSha: string | null; mainSha: string; mainCommittedAt: Date } | null;
  reauthNeeded: number;
};

/** How often a persisting condition is repeated. Info is said once. */
export const REMIND_AFTER_MS: Record<OpsSeverity, number | null> = {
  critical: 6 * 60 * 60 * 1000,
  warning: 24 * 60 * 60 * 1000,
  info: null,
};

const WEBHOOK_STREAK = 3;
const FAILED_IMPORT_BURST = 3;
const ERROR_BURST = 5;
const PERF_SLOW_BURST = 3;
const OUTAGE_ACCOUNTS = 2;
const DRIFT_AFTER_MS = 6 * 60 * 60 * 1000;

const isRejected = (o: WebhookOutcome) => o === "invalid" || o === "error";

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
    if (!prev || !prev.active || prev.severity !== c.severity) {
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
