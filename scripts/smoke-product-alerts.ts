/**
 * Pins every product-health and money-integrity alert: the condition fires past its
 * threshold, stays quiet under its floor, and the loader that feeds it runs against a real
 * (empty) database without throwing.
 *
 * The floors matter as much as the thresholds: a rule that fires on two sign-ups gets muted,
 * and a muted alert is worse than none.
 *
 * Run: npx tsx scripts/smoke-product-alerts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { PRODUCT_ALERT_THRESHOLDS as T, productConditions, type ProductOpsFacts } from "../src/lib/product-alerts";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { loadProductOpsFacts } from "../src/lib/product-ops";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const now = new Date("2026-10-18T15:00:00Z");
const quiet = (): ProductOpsFacts => ({
  ledger: { driftCents: 0, lastEventAt: new Date(now.getTime() - 3 * 3_600_000) },
  stripeReconcile: { lastStartedAt: new Date(now.getTime() - 3_600_000), lastState: "ok", mismatches: 0, checked: 40 },
  signups: { last7d: 30, prev7d: 30 },
  activation: { cohortMatured: 30, cohortActivated: 15, priorMatured: 120, priorActivated: 60, priorCohorts: 4 },
  funnel: { accountsCreated48h: 8, capturesSaved48h: 12, checkoutsStarted24h: 2, paidEvents24h: 0 },
  failures: [
    { flow: "capture", attempts: 100, failed: 2 },
    { flow: "import", attempts: 10, failed: 0 },
    { flow: "email", attempts: 50, failed: 1 },
  ],
  tracking: { pageViews2h: 40, pageViewsPrev24h: 400, productEvents6h: 30, productEventsPrev7d: 500, hourUtc: 15 },
  heavyUsers: { accounts: 0, topCostMicros: 0, topPlan: null },
  silentJobs: [{ job: "email.drain", label: "The email outbox drain", lastStartedAt: new Date(now.getTime() - 600_000), silentAfterMs: 3_600_000 }],
});
const ids = (f: ProductOpsFacts) => productConditions(f, now).map((c) => c.id);
const with_ = (patch: Partial<ProductOpsFacts>): ProductOpsFacts => ({ ...quiet(), ...patch });

run(async () => {
  console.log("a healthy product raises nothing");
  check("quiet facts, no conditions", ids(quiet()).length === 0, ids(quiet()).join(", "));

  console.log("\nledger drift");
  check("drift with nothing recent opens billing.ledger_drift", ids(with_({ ledger: { driftCents: 500, lastEventAt: new Date(now.getTime() - 2 * 3_600_000) } })).includes("billing.ledger_drift"));
  check("drift while a webhook is landing is not drift yet", !ids(with_({ ledger: { driftCents: 500, lastEventAt: new Date(now.getTime() - 60_000) } })).includes("billing.ledger_drift"));
  check("no ledger, no condition", ids(with_({ ledger: null })).length === 0);

  console.log("\nStripe comparison");
  const rec = (patch: Partial<ProductOpsFacts["stripeReconcile"]>) => with_({ stripeReconcile: { ...quiet().stripeReconcile, ...patch } });
  check("a mismatch is critical", productConditions(rec({ mismatches: 2 }), now).find((c) => c.id === "billing.stripe_drift")?.severity === "critical");
  check("the alert names counts, not accounts", !/user_[A-Za-z0-9]{20,}/.test(productConditions(rec({ mismatches: 2 }), now).find((c) => c.id === "billing.stripe_drift")?.detail ?? ""));
  check("a failed run is reported", ids(rec({ lastState: "failed" })).includes("billing.reconcile_failed"));
  check("a run that stopped is reported", ids(rec({ lastStartedAt: new Date(now.getTime() - T.reconcileMissedMs - 60_000) })).includes("billing.reconcile_missed"));
  check("never having run is not news", ids(rec({ lastStartedAt: null, lastState: null, mismatches: null, checked: null })).length === 0);

  console.log("\nsign-ups");
  check("a halving with a real baseline opens", ids(with_({ signups: { last7d: 10, prev7d: 30 } })).includes("product.signups_drop"));
  check("under the floor it stays quiet", !ids(with_({ signups: { last7d: 1, prev7d: T.signupsFloor - 1 } })).includes("product.signups_drop"));
  check("a small dip stays quiet", !ids(with_({ signups: { last7d: 20, prev7d: 30 } })).includes("product.signups_drop"));

  console.log("\nactivation");
  const act = (patch: Partial<ProductOpsFacts["activation"]>) => with_({ activation: { ...quiet().activation, ...patch } });
  check("a cohort far below the trailing rate opens", ids(act({ cohortActivated: 6 })).includes("product.activation_drop"));
  check("a small cohort stays quiet", !ids(act({ cohortMatured: T.activationCohortFloor - 1, cohortActivated: 0 })).includes("product.activation_drop"));
  check("one prior cohort is not a baseline", !ids(act({ cohortActivated: 0, priorCohorts: 1 })).includes("product.activation_drop"));

  console.log("\nfunnel");
  check("accounts but no captures is critical", productConditions(with_({ funnel: { ...quiet().funnel, accountsCreated48h: 12, capturesSaved48h: 0 } }), now).find((c) => c.id === "product.funnel_break")?.severity === "critical");
  check("few accounts, no captures, is just a slow weekend", !ids(with_({ funnel: { ...quiet().funnel, accountsCreated48h: 3, capturesSaved48h: 0 } })).includes("product.funnel_break"));
  check("checkouts that never pay are caught", ids(with_({ funnel: { ...quiet().funnel, checkoutsStarted24h: 4, paidEvents24h: 0 } })).includes("product.checkout_break"));
  check("one abandoned checkout is not", !ids(with_({ funnel: { ...quiet().funnel, checkoutsStarted24h: 1, paidEvents24h: 0 } })).includes("product.checkout_break"));

  console.log("\nfailures");
  check("six percent of enough attempts opens, per flow", ids(with_({ failures: [{ flow: "capture", attempts: 50, failed: 3 }] })).includes("quality.failure_rate:capture"));
  check("the same rate on a handful of attempts does not", !ids(with_({ failures: [{ flow: "capture", attempts: 5, failed: 1 }] })).some((i) => i.startsWith("quality.failure_rate")));

  console.log("\ncost");
  check("a heavy account opens, without naming it", !/user_[A-Za-z0-9]{20,}/.test(productConditions(with_({ heavyUsers: { accounts: 1, topCostMicros: 5_000_000, topPlan: "free" } }), now).find((c) => c.id === "cost.heavy_user")?.detail ?? "user_xxxxxxxxxxxxxxxxxxxxxx"));

  console.log("\nthe measurement itself");
  check("no page views for two hours in the day is critical", productConditions(with_({ tracking: { ...quiet().tracking, pageViews2h: 0 } }), now).find((c) => c.id === "tracking.silence")?.severity === "critical");
  check("but not at 03:00 UTC", !ids(with_({ tracking: { ...quiet().tracking, pageViews2h: 0, hourUtc: 3 } })).includes("tracking.silence"));
  check("and not on a site that never had traffic", !ids(with_({ tracking: { ...quiet().tracking, pageViews2h: 0, pageViewsPrev24h: 3 } })).includes("tracking.silence"));
  check("product events going quiet is a warning", ids(with_({ tracking: { ...quiet().tracking, productEvents6h: 0 } })).includes("tracking.events_silence"));

  console.log("\njobs that had no alert");
  const silent = with_({ silentJobs: [{ job: "email.drain", label: "The email outbox drain", lastStartedAt: new Date(now.getTime() - 4 * 3_600_000), silentAfterMs: 3_600_000 }] });
  check("a drain that stopped is named", ids(silent).includes("cron.silent:email.drain"));
  check("a job that never ran is not", !ids(with_({ silentJobs: [{ job: "email.drain", label: "x", lastStartedAt: null, silentAfterMs: 1 }] })).length);

  console.log("\nthe loader");
  // The throwaway database is shared by every script in a suite run, so "empty" is made true
  // here rather than assumed: accounts from other scripts would open the funnel alert.
  const db = await getDb();
  await db.execute(sql`UPDATE user_settings SET created_at = now() - interval '60 days' WHERE created_at > now() - interval '30 days'`);
  for (const table of ["capture_jobs", "imports", "email_sends", "product_events", "page_views", "cron_runs"]) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  const facts = await loadProductOpsFacts(new Date());
  check("reads an empty database without throwing", Array.isArray(facts.failures) && facts.signups.last7d >= 0);
  check("reports the four silent jobs", facts.silentJobs.length === 4);
  check("an empty database raises nothing", productConditions(facts, new Date()).filter((c) => !c.id.startsWith("billing.")).length === 0, productConditions(facts, new Date()).map((c) => c.id).join(", "));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll product-alert checks passed.");
});
