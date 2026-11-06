import { desc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { cronRuns, usageEvents, userSettings } from "@/db/schema";
import { ACTIVATION_WINDOW_DAYS, activatedSql } from "@/lib/activity";
import { managedCostSql } from "@/lib/ai-access";
import { internalAccountSql } from "@/lib/analytics-internal";
import { mrrReconciliation } from "@/lib/billing-events";
import { deriveCronRunState } from "@/lib/cron-runs";
import { resolvePlan, type Plan } from "@/lib/entitlements";
import type { ProductOpsFacts } from "@/lib/product-alerts";
import { speechCostMicros, type SpeechSecondsRow } from "@/lib/speech-cost";

/**
 * The facts `product-alerts.ts` decides on, read in as few statements as the questions allow.
 * Every count excludes internal and tester accounts (`internalAccountSql`) except the two
 * that are about the measurement itself (page views and product events), where the operator's
 * own traffic is as good a heartbeat as anyone's.
 *
 * Optional in the snapshot: a failed read costs these alerts for one sweep, never the run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** What one account may cost Orbit in a day before it is worth a look, by plan (micros). */
export const DAILY_COST_CEILING_MICROS: Record<Plan, number> = {
  free: 2_000_000,
  lifetime: 2_000_000,
  orbit: 4_000_000,
  max: 8_000_000,
};

/**
 * Jobs that write `cron_runs` but had no condition for going quiet, and how long is too long.
 * A dead email drain was noticed only when someone's message never arrived.
 */
export const SILENT_JOBS = [
  { job: "email.drain", label: "The email outbox drain", silentAfterMs: 60 * 60_000 },
  { job: "connectors.outbox", label: "The connector outbox", silentAfterMs: 60 * 60_000 },
  { job: "credits.notices", label: "Credit notices", silentAfterMs: 2 * HOUR_MS },
  { job: "cloud-notes.run", label: "The cloud-notes sync", silentAfterMs: 3 * HOUR_MS },
] as const;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function loadProductOpsFacts(now: Date): Promise<ProductOpsFacts> {
  const db = await getDb();
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const nonInternal = (col: string) => sql`NOT ${internalAccountSql(sql.raw(col))}`;

  const [ledger, lastEvent, reconcileRows, counts, activation, perUserCost, speechRows, cronLast] =
    await Promise.all([
      mrrReconciliation(now).catch(() => null),
      db.execute(sql`SELECT max(created_at) AS at FROM billing_events`),
      db
        .select()
        .from(cronRuns)
        .where(eq(cronRuns.job, "billing.reconcile"))
        .orderBy(desc(cronRuns.startedAt))
        .limit(1),
      db.execute(sql`
        SELECT
          (SELECT count(*) FROM user_settings WHERE created_at >= ${at(7 * DAY_MS)} AND ${nonInternal("user_id")})::int AS signups_7d,
          (SELECT count(*) FROM user_settings WHERE created_at >= ${at(14 * DAY_MS)} AND created_at < ${at(7 * DAY_MS)} AND ${nonInternal("user_id")})::int AS signups_prev,
          (SELECT count(*) FROM user_settings WHERE created_at >= ${at(2 * DAY_MS)} AND ${nonInternal("user_id")})::int AS accounts_48h,
          (SELECT count(*) FROM capture_jobs WHERE status = 'saved' AND created_at >= ${at(2 * DAY_MS)} AND ${nonInternal("user_id")})::int AS captures_48h,
          (SELECT count(*) FROM product_events WHERE name = 'checkout_started' AND occurred_at >= ${at(DAY_MS)} AND is_internal = false)::int AS checkouts_24h,
          (SELECT count(*) FROM billing_events WHERE created_at >= ${at(DAY_MS)}
             AND kind IN ('new', 'reactivation', 'lifetime', 'credit_pack', 'payment') AND ${nonInternal("user_id")})::int AS paid_24h,
          (SELECT count(*) FILTER (WHERE status = 'saved')::int FROM capture_jobs
             WHERE status IN ('saved', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS capture_ok,
          (SELECT count(*) FILTER (WHERE status = 'failed')::int FROM capture_jobs
             WHERE status IN ('saved', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS capture_failed,
          (SELECT count(*)::int FROM imports
             WHERE status IN ('completed', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS import_attempts,
          (SELECT count(*) FILTER (WHERE status = 'failed')::int FROM imports
             WHERE status IN ('completed', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS import_failed,
          (SELECT count(*)::int FROM email_sends
             WHERE status IN ('sent', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS email_attempts,
          (SELECT count(*) FILTER (WHERE status = 'failed')::int FROM email_sends
             WHERE status IN ('sent', 'failed') AND created_at >= ${at(DAY_MS)} AND ${nonInternal("user_id")}) AS email_failed,
          (SELECT count(*) FROM page_views WHERE created_at >= ${at(2 * HOUR_MS)} AND is_bot = false)::int AS pv_2h,
          (SELECT count(*) FROM page_views WHERE created_at >= ${at(26 * HOUR_MS)} AND created_at < ${at(2 * HOUR_MS)} AND is_bot = false)::int AS pv_prev,
          (SELECT count(*) FROM product_events WHERE occurred_at >= ${at(6 * HOUR_MS)})::int AS pe_6h,
          (SELECT count(*) FROM product_events WHERE occurred_at >= ${at(7 * DAY_MS)} AND occurred_at < ${at(6 * HOUR_MS)})::int AS pe_prev
      `),
      // The cohort that just finished its activation window (created 7 to 14 days ago) against
      // the weekly cohorts before it (14 to 42 days ago), judged by the shared definition.
      db.execute(sql`
        WITH s AS (
          SELECT s.user_id, s.created_at,
                 ${activatedSql(sql`s.user_id`, sql`s.created_at`)} AS activated
          FROM user_settings s
          WHERE s.created_at >= ${at(42 * DAY_MS)}
            AND s.created_at < ${at(ACTIVATION_WINDOW_DAYS * DAY_MS)}
            AND ${nonInternal("s.user_id")}
        )
        SELECT
          count(*) FILTER (WHERE created_at >= ${at(14 * DAY_MS)})::int AS cohort_matured,
          count(*) FILTER (WHERE created_at >= ${at(14 * DAY_MS)} AND activated)::int AS cohort_activated,
          count(*) FILTER (WHERE created_at < ${at(14 * DAY_MS)})::int AS prior_matured,
          count(*) FILTER (WHERE created_at < ${at(14 * DAY_MS)} AND activated)::int AS prior_activated,
          count(DISTINCT floor(extract(epoch FROM (${at(0)}::timestamptz - created_at)) / ${7 * 86400}))
            FILTER (WHERE created_at < ${at(14 * DAY_MS)})::int AS prior_cohorts
        FROM s
      `),
      db
        .select({
          userId: usageEvents.userId,
          micros: sql<string>`coalesce(sum(${managedCostSql()}), 0)`,
        })
        .from(usageEvents)
        .where(sql`${usageEvents.keyOwner} = 'orbit' AND ${usageEvents.createdAt} >= ${at(DAY_MS)}`)
        .groupBy(usageEvents.userId),
      db.execute(sql`
        SELECT user_id, kind, source, coalesce(sum(seconds), 0) AS seconds
        FROM speech_usage WHERE created_at >= ${at(DAY_MS)}
        GROUP BY user_id, kind, source
      `),
      db.execute(sql`
        SELECT job, max(started_at) AS last_started
        FROM cron_runs
        WHERE job IN (${sql.join(SILENT_JOBS.map((j) => sql`${j.job}`), sql`, `)})
        GROUP BY job
      `),
    ]);

  const c = rowsOf<Record<string, number | string>>(counts)[0] ?? {};
  const a = rowsOf<Record<string, number | string>>(activation)[0] ?? {};
  const lastEventAt = rowsOf<{ at: string | Date | null }>(lastEvent)[0]?.at;
  const rec = reconcileRows[0];
  const recStats = (rec?.stats ?? {}) as Record<string, number>;

  // Per-account daily cost: managed AI plus priced Deepgram, over each plan's ceiling.
  const cost = new Map<string, number>();
  for (const r of perUserCost) cost.set(r.userId, (cost.get(r.userId) ?? 0) + num(r.micros));
  const speechByUser = new Map<string, SpeechSecondsRow[]>();
  for (const r of rowsOf<{ user_id: string; kind: SpeechSecondsRow["kind"]; source: SpeechSecondsRow["source"]; seconds: string | number }>(speechRows)) {
    const list = speechByUser.get(r.user_id) ?? [];
    list.push({ kind: r.kind, source: r.source, seconds: num(r.seconds) });
    speechByUser.set(r.user_id, list);
  }
  for (const [userId, rows] of speechByUser) cost.set(userId, (cost.get(userId) ?? 0) + speechCostMicros(rows));
  const candidates = [...cost.entries()]
    .filter(([, micros]) => micros >= DAILY_COST_CEILING_MICROS.free)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 50);
  let heavy = { accounts: 0, topCostMicros: 0, topPlan: null as string | null };
  if (candidates.length > 0) {
    const ids = candidates.map(([id]) => id);
    const accounts = await db
      .select({
        userId: userSettings.userId,
        compedPlan: userSettings.compedPlan,
        lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
        subscriptionPlan: userSettings.subscriptionPlan,
        subscriptionStatus: userSettings.subscriptionStatus,
        subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
        accountKind: userSettings.accountKind,
      })
      .from(userSettings)
      .where(sql`${userSettings.userId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    const byId = new Map(accounts.map((x) => [x.userId, x]));
    for (const [userId, micros] of candidates) {
      const acct = byId.get(userId);
      if (!acct || acct.accountKind) continue; // internal and tester accounts never count
      const { plan } = resolvePlan(acct);
      if (micros > DAILY_COST_CEILING_MICROS[plan]) {
        heavy.accounts += 1;
        if (micros > heavy.topCostMicros) heavy = { ...heavy, topCostMicros: micros, topPlan: plan };
      }
    }
  }

  const lastBy = new Map(
    rowsOf<{ job: string; last_started: string | Date | null }>(cronLast).map((r) => [
      r.job,
      r.last_started ? new Date(r.last_started) : null,
    ])
  );

  return {
    ledger: ledger
      ? { driftCents: ledger.driftCents, lastEventAt: lastEventAt ? new Date(lastEventAt) : null }
      : null,
    stripeReconcile: {
      lastStartedAt: rec?.startedAt ?? null,
      lastState: rec ? deriveCronRunState(rec, now) : null,
      mismatches: rec ? num(recStats.mismatches) : null,
      checked: rec ? num(recStats.checked) : null,
    },
    signups: { last7d: num(c.signups_7d), prev7d: num(c.signups_prev) },
    activation: {
      cohortMatured: num(a.cohort_matured),
      cohortActivated: num(a.cohort_activated),
      priorMatured: num(a.prior_matured),
      priorActivated: num(a.prior_activated),
      priorCohorts: num(a.prior_cohorts),
    },
    funnel: {
      accountsCreated48h: num(c.accounts_48h),
      capturesSaved48h: num(c.captures_48h),
      checkoutsStarted24h: num(c.checkouts_24h),
      paidEvents24h: num(c.paid_24h),
    },
    failures: [
      { flow: "capture", attempts: num(c.capture_ok) + num(c.capture_failed), failed: num(c.capture_failed) },
      { flow: "import", attempts: num(c.import_attempts), failed: num(c.import_failed) },
      { flow: "email", attempts: num(c.email_attempts), failed: num(c.email_failed) },
    ],
    tracking: {
      pageViews2h: num(c.pv_2h),
      pageViewsPrev24h: num(c.pv_prev),
      productEvents6h: num(c.pe_6h),
      productEventsPrev7d: num(c.pe_prev),
      hourUtc: now.getUTCHours(),
    },
    heavyUsers: heavy,
    silentJobs: SILENT_JOBS.map((j) => ({
      job: j.job,
      label: j.label,
      lastStartedAt: lastBy.get(j.job) ?? null,
      silentAfterMs: j.silentAfterMs,
    })),
  };
}
