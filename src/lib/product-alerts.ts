import type { CronRunState } from "@/lib/cron-runs";
import type { OpsCondition } from "@/lib/ops-alerts";

/**
 * Product-health and money-integrity alert conditions: the ones the existing ops catalogue
 * had no way to raise. Everything it watched was infrastructure (a cron stopped, a webhook
 * secret rolled). Nothing noticed sign-ups going to zero, captures never being saved, a
 * ledger that disagreed with Stripe, or the traffic beacon going silent — all of which look
 * identical to a quiet week.
 *
 * Pure on purpose, like `ops-alerts.ts`: `product-ops.ts` loads the facts, this decides, and
 * `scripts/smoke-product-alerts.ts` pins every threshold and its floor.
 *
 * EVERY RULE HAS AN ABSOLUTE FLOOR AS WELL AS A RELATIVE DROP. At a few dozen sign-ups a week
 * "down 50%" is two people, and a rule that fires on two people is a rule that gets muted.
 * Below the floor nothing here speaks; the console still shows the counts.
 */

export type ProductOpsFacts = {
  /** Ledger MRR against live MRR, and when the newest ledger row landed (an in-flight webhook is not drift). */
  ledger: { driftCents: number; lastEventAt: Date | null } | null;
  /** The daily Stripe-vs-database comparison (`/api/ops/billing-reconcile`). */
  stripeReconcile: {
    lastStartedAt: Date | null;
    lastState: CronRunState | null;
    mismatches: number | null;
    checked: number | null;
  };
  signups: { last7d: number; prev7d: number };
  /** The cohort that just finished its activation window, against the four before it. */
  activation: {
    cohortMatured: number;
    cohortActivated: number;
    priorMatured: number;
    priorActivated: number;
    priorCohorts: number;
  };
  funnel: {
    accountsCreated48h: number;
    capturesSaved48h: number;
    checkoutsStarted24h: number;
    paidEvents24h: number;
  };
  /** Terminal outcomes in the last day, per flow a person watches succeed or fail. */
  failures: Array<{ flow: "capture" | "import" | "email"; attempts: number; failed: number }>;
  tracking: {
    pageViews2h: number;
    pageViewsPrev24h: number;
    productEvents6h: number;
    productEventsPrev7d: number;
    hourUtc: number;
  };
  /** Accounts whose cost in the last day exceeds their plan's daily ceiling. */
  heavyUsers: { accounts: number; topCostMicros: number; topPlan: string | null };
  /** Jobs that record a run but had no alert for going quiet. */
  silentJobs: Array<{ job: string; label: string; lastStartedAt: Date | null; silentAfterMs: number }>;
};

/** Floors and thresholds, exported so the smoke pins them and the plan's wording stays honest. */
export const PRODUCT_ALERT_THRESHOLDS = {
  /** Sign-ups drop: needs this many in the previous week, then fires below this share of it. */
  signupsFloor: 10,
  signupsDropShare: 0.5,
  /** Activation drop: a cohort this big, below this share of the trailing mean. */
  activationCohortFloor: 20,
  activationDropShare: 0.6,
  /** Funnel break: accounts created with zero captures saved. */
  funnelAccountsFloor: 10,
  /** Checkouts started with no payment booked. */
  checkoutsFloor: 3,
  /** Failure rate: at least this many attempts, then above this share. */
  failureAttemptsFloor: 20,
  failureShare: 0.05,
  /** Ledger drift is only drift once nothing has landed for this long. */
  ledgerQuietMs: 60 * 60_000,
  /** The beacon is "silent" after this long with no page view, within these UTC hours. */
  trackingSilentHoursStart: 8,
  trackingSilentHoursEnd: 24,
  trackingPrevFloor: 20,
  productEventsSilentFloor: 20,
  /** The Stripe comparison is overdue after this long. */
  reconcileMissedMs: 30 * 60 * 60_000,
} as const;

const T = PRODUCT_ALERT_THRESHOLDS;

const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

export function productConditions(f: ProductOpsFacts, now: Date): OpsCondition[] {
  const out: OpsCondition[] = [];

  // --- Money integrity ---------------------------------------------------------------
  if (f.ledger && f.ledger.driftCents !== 0) {
    const quiet =
      !f.ledger.lastEventAt || now.getTime() - f.ledger.lastEventAt.getTime() > T.ledgerQuietMs;
    if (quiet) {
      out.push({
        id: "billing.ledger_drift",
        severity: "warning",
        title: "The revenue ledger disagrees with live MRR",
        detail: `Live MRR is ${f.ledger.driftCents > 0 ? "above" : "below"} the ledger by ${money(f.ledger.driftCents)} a month, and nothing has landed for an hour. A webhook was missed, an account was comped over a subscription, or a deletion was not booked.`,
        href: "/admin/billing",
      });
    }
  }

  const rec = f.stripeReconcile;
  // Only once the job has ever run: before the scheduler is wired a missing row is not news.
  const reconcileMissed =
    rec.lastStartedAt !== null && now.getTime() - rec.lastStartedAt.getTime() > T.reconcileMissedMs;
  if (reconcileMissed) {
    out.push({
      id: "billing.reconcile_missed",
      severity: "warning",
      title: "The daily Stripe comparison has stopped running",
      detail: `Last started ${rec.lastStartedAt!.toISOString()}; a subscription Stripe and the database disagree about would go unnoticed.`,
      href: "/admin/billing",
    });
  } else if (rec.lastState === "failed" || rec.lastState === "stale") {
    out.push({
      id: "billing.reconcile_failed",
      severity: "warning",
      title: `The daily Stripe comparison ${rec.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${rec.lastStartedAt?.toISOString() ?? "unknown"} ended ${rec.lastState}.`,
      href: "/admin/billing",
    });
  } else if ((rec.mismatches ?? 0) > 0) {
    out.push({
      id: "billing.stripe_drift",
      severity: "critical",
      title: "Stripe and the database disagree about subscriptions",
      detail: `${rec.mismatches} of ${rec.checked ?? "?"} subscriptions differ in plan, status or amount between Stripe and user_settings. Someone is paying for something they do not have, or has something they do not pay for.`,
      href: "/admin/billing",
    });
  }

  // --- Growth and activation ---------------------------------------------------------
  const { last7d, prev7d } = f.signups;
  if (prev7d >= T.signupsFloor && last7d < prev7d * T.signupsDropShare) {
    out.push({
      id: "product.signups_drop",
      severity: "warning",
      title: "Sign-ups have dropped",
      detail: `${last7d} new accounts in the last 7 days against ${prev7d} in the 7 before.`,
      href: "/admin/growth",
    });
  }

  const a = f.activation;
  if (a.cohortMatured >= T.activationCohortFloor && a.priorMatured > 0 && a.priorCohorts >= 2) {
    const rate = a.cohortActivated / a.cohortMatured;
    const prior = a.priorActivated / a.priorMatured;
    if (prior > 0 && rate < prior * T.activationDropShare) {
      out.push({
        id: "product.activation_drop",
        severity: "warning",
        title: "Fewer new accounts are activating",
        detail: `${a.cohortActivated} of ${a.cohortMatured} accounts from the week that just matured activated, against ${a.priorActivated} of ${a.priorMatured} over the ${a.priorCohorts} weeks before.`,
        href: "/admin/growth",
      });
    }
  }

  // --- Funnel breakage ---------------------------------------------------------------
  const fn = f.funnel;
  if (fn.accountsCreated48h >= T.funnelAccountsFloor && fn.capturesSaved48h === 0) {
    out.push({
      id: "product.funnel_break",
      severity: "critical",
      title: "Nobody has saved a capture",
      detail: `${fn.accountsCreated48h} accounts were created in 48 hours and not one capture has been saved by anyone. Capture is probably broken.`,
      href: "/admin/health",
    });
  }
  if (fn.checkoutsStarted24h >= T.checkoutsFloor && fn.paidEvents24h === 0) {
    out.push({
      id: "product.checkout_break",
      severity: "critical",
      title: "Checkouts are starting but nothing is being paid",
      detail: `${fn.checkoutsStarted24h} checkouts started in 24 hours and no payment, subscription or purchase was booked.`,
      href: "/admin/billing",
    });
  }

  // --- Quality -----------------------------------------------------------------------
  for (const flow of f.failures) {
    if (flow.attempts >= T.failureAttemptsFloor && flow.failed / flow.attempts > T.failureShare) {
      out.push({
        id: `quality.failure_rate:${flow.flow}`,
        severity: "warning",
        title: `${flow.flow[0]!.toUpperCase()}${flow.flow.slice(1)} failures are above ${Math.round(T.failureShare * 100)}%`,
        detail: `${flow.failed} of ${flow.attempts} ${flow.flow} attempts failed in the last 24 hours.`,
        href: "/admin/health",
      });
    }
  }

  // --- Cost --------------------------------------------------------------------------
  if (f.heavyUsers.accounts > 0) {
    out.push({
      id: "cost.heavy_user",
      severity: "warning",
      title: "An account cost more in a day than its plan can carry",
      detail: `${f.heavyUsers.accounts} account(s) are over their daily cost ceiling; the heaviest cost ${money(Math.round(f.heavyUsers.topCostMicros / 10_000))} in 24 hours${f.heavyUsers.topPlan ? ` on ${f.heavyUsers.topPlan}` : ""}.`,
      href: "/admin/billing/costs",
    });
  }

  // --- The measurement itself --------------------------------------------------------
  const tr = f.tracking;
  const inActiveHours = tr.hourUtc >= T.trackingSilentHoursStart && tr.hourUtc < T.trackingSilentHoursEnd;
  if (inActiveHours && tr.pageViews2h === 0 && tr.pageViewsPrev24h >= T.trackingPrevFloor) {
    out.push({
      id: "tracking.silence",
      severity: "critical",
      title: "Traffic tracking has gone silent",
      detail: `No page view in two hours, after ${tr.pageViewsPrev24h} in the day before. The beacon, the route or the salt is broken — every traffic number is going stale.`,
      href: "/admin/analytics",
    });
  }
  if (inActiveHours && tr.productEvents6h === 0 && tr.productEventsPrev7d >= T.productEventsSilentFloor) {
    out.push({
      id: "tracking.events_silence",
      severity: "warning",
      title: "Product events have stopped",
      detail: `No product event in six hours, after ${tr.productEventsPrev7d} in the week before.`,
      href: "/admin/health",
    });
  }

  // --- Jobs that recorded runs but never had an alert --------------------------------
  for (const job of f.silentJobs) {
    // Only once it has run: a job nobody has scheduled yet is not "silent".
    if (job.lastStartedAt && now.getTime() - job.lastStartedAt.getTime() > job.silentAfterMs) {
      out.push({
        id: `cron.silent:${job.job}`,
        severity: "warning",
        title: `${job.label} has stopped running`,
        detail: `Last started ${job.lastStartedAt.toISOString()}.`,
        href: "/admin/health",
      });
    }
  }

  return out;
}
