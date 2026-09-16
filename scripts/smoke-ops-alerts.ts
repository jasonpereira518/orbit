/**
 * Asserts the ops-alert catalogue and its state machine in `src/lib/ops-alerts.ts`.
 *
 * The sweep evaluates a snapshot of known conditions every ten minutes. What makes that
 * bearable in Slack is the state machine, not the predicates: a condition is announced
 * when it OPENS, reminded on a per-severity cadence while it persists, and announced once
 * more when it RECOVERS — never once per sweep. Both halves are pure, so they are pinned
 * here without a database.
 *
 * Run: npx tsx scripts/smoke-ops-alerts.ts
 */
import {
  evaluateOpsConditions,
  planTransitions,
  REMIND_AFTER_MS,
  type OpsAlertRow,
  type OpsSnapshot,
} from "../src/lib/ops-alerts";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-02T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Everything healthy. Each case overrides one field. */
const HEALTHY: OpsSnapshot = {
  cron: {
    processStalled: { lastStartedAt: hoursAgo(2), lastState: "ok" },
    syncRun: { lastStartedAt: hoursAgo(1), lastState: "ok" },
    drain: { lastStartedAt: hoursAgo(0.2), lastState: "ok" },
  },
  webhooks: { clerk: ["handled", "handled", "ignored"], stripe: ["handled"], resend: [] },
  stripeCheckoutErrorsLastHour: 0,
  resendRejectedLastHour: 0,
  wedgedImports: 0,
  failedImportsLast24h: 0,
  outreach: { overdue: 0, oldestOverdueDays: null },
  aiOutages: [],
  errorEventsLastHour: 0,
  perfSlowLastHour: 0,
  missingRequiredEnv: [],
  missingExpectedEnv: [],
  deploy: { prodSha: "abc", mainSha: "abc", mainCommittedAt: hoursAgo(30) },
  reauthNeeded: 0,
  wedgedSyncs: 0,
  failingSyncs: 0,
  stuckPurges: 0,
  processStalledRecent: ["ok"],
  backfillFailures24h: { accounts: 0, kinds: [] },
  statementTimeout: "20s",
  stripeUnattributed24h: { fulfilments: 0, other: 0 },
  embeddingBacklog: { accounts: 0, oldestAt: null },
};

const ids = (s: OpsSnapshot) => evaluateOpsConditions(s, NOW).map((c) => c.id).sort();
const find = (s: OpsSnapshot, id: string) => evaluateOpsConditions(s, NOW).find((c) => c.id === id);

function main() {
  console.log("Condition catalogue...");
  check("a healthy snapshot raises nothing", ids(HEALTHY).length === 0, ids(HEALTHY).join(","));

  check("cron never ran → cron.missed (warning)",
    find({ ...HEALTHY, cron: { ...HEALTHY.cron, processStalled: { lastStartedAt: null, lastState: null } } }, "cron.missed")?.severity === "warning");
  check("cron last ran 26h ago → cron.missed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, processStalled: { lastStartedAt: hoursAgo(26), lastState: "ok" } } }, "cron.missed")));
  check("cron last run failed → cron.failed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, processStalled: { lastStartedAt: hoursAgo(2), lastState: "failed" } } }, "cron.failed")));
  check("cron last run stale (killed) → cron.failed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, processStalled: { lastStartedAt: hoursAgo(2), lastState: "stale" } } }, "cron.failed")));

  check("three partial nightly runs in a row → cron.partial_streak (warning)",
    find({ ...HEALTHY, processStalledRecent: ["partial", "partial", "partial"] }, "cron.partial_streak")?.severity === "warning");
  check("two partials then an ok is not a streak",
    !find({ ...HEALTHY, processStalledRecent: ["partial", "partial", "ok"] }, "cron.partial_streak"));
  check("only two runs recorded is not yet a streak",
    !find({ ...HEALTHY, processStalledRecent: ["partial", "partial"] }, "cron.partial_streak"));
  check("a failed drain → drain.failed",
    find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(0.1), lastState: "failed" } } }, "drain.failed")?.severity === "warning");
  check("a killed drain → drain.failed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(1), lastState: "stale" } } }, "drain.failed")));
  check("a partial drain (customer endpoints refusing) is not drain.failed",
    !find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(0.1), lastState: "partial" } } }, "drain.failed"));

  // Connector sync. Its freshness window is its own (3h), not the nightly job's 25h — a job
  // that should run every fifteen minutes must not be able to go a full day unnoticed.
  check("sync never ran → sync.schedule_missed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: null, lastState: null } } }, "sync.schedule_missed")));
  check("sync silent for 4h → sync.schedule_missed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: hoursAgo(4), lastState: "ok" } } }, "sync.schedule_missed")));
  check("sync silent for 2h is still within tolerance",
    !find({ ...HEALTHY, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: hoursAgo(2), lastState: "ok" } } }, "sync.schedule_missed"));
  check("a 26h-silent sync would be missed by the nightly job's threshold but not by this one",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: hoursAgo(26), lastState: "ok" } } }, "sync.schedule_missed")));
  check("sync last run failed → sync.run_failed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: hoursAgo(1), lastState: "failed" } } }, "sync.run_failed")));
  check("a wedged sync lease → sync.wedged",
    find({ ...HEALTHY, wedgedSyncs: 2 }, "sync.wedged")?.severity === "warning");
  check("a disarmed connection → sync.failing",
    find({ ...HEALTHY, failingSyncs: 1 }, "sync.failing")?.severity === "warning");

  check("three invalid Clerk deliveries in a row → critical",
    find({ ...HEALTHY, webhooks: { ...HEALTHY.webhooks, clerk: ["invalid", "invalid", "invalid"] } }, "webhook.invalid_streak:clerk")?.severity === "critical");
  check("three invalid Stripe deliveries → critical",
    find({ ...HEALTHY, webhooks: { ...HEALTHY.webhooks, stripe: ["invalid", "error", "invalid"] } }, "webhook.invalid_streak:stripe")?.severity === "critical");
  check("three invalid Resend deliveries → warning",
    find({ ...HEALTHY, webhooks: { ...HEALTHY.webhooks, resend: ["invalid", "invalid", "invalid"] } }, "webhook.invalid_streak:resend")?.severity === "warning");
  check("two invalid then a handled one is not a streak",
    !find({ ...HEALTHY, webhooks: { ...HEALTHY.webhooks, clerk: ["invalid", "invalid", "handled"] } }, "webhook.invalid_streak:clerk"));
  check("only two deliveries, both invalid, is not yet a streak",
    !find({ ...HEALTHY, webhooks: { ...HEALTHY.webhooks, clerk: ["invalid", "invalid"] } }, "webhook.invalid_streak:clerk"));

  check("a Stripe checkout error in the last hour → critical",
    find({ ...HEALTHY, stripeCheckoutErrorsLastHour: 1 }, "stripe.checkout_error")?.severity === "critical");
  check("a Resend rejection in the last hour → resend.rejected (warning)",
    find({ ...HEALTHY, resendRejectedLastHour: 1 }, "resend.rejected")?.severity === "warning");
  check("…whose detail names the usual cause",
    Boolean(find({ ...HEALTHY, resendRejectedLastHour: 3 }, "resend.rejected")?.detail.includes("RESEND_FROM_EMAIL")));
  check("a wedged import → warning", find({ ...HEALTHY, wedgedImports: 1 }, "import.wedged")?.severity === "warning");
  check("three failed imports in 24h → import.failed_burst", Boolean(find({ ...HEALTHY, failedImportsLast24h: 3 }, "import.failed_burst")));
  check("two failed imports is not a burst", !find({ ...HEALTHY, failedImportsLast24h: 2 }, "import.failed_burst"));
  check("overdue outreach a day old → warning",
    find({ ...HEALTHY, outreach: { overdue: 2, oldestOverdueDays: 1.5 } }, "outreach.overdue")?.severity === "warning");
  check("overdue outreach an hour old is not yet an alert",
    !find({ ...HEALTHY, outreach: { overdue: 2, oldestOverdueDays: 0.05 } }, "outreach.overdue"));
  check("an AI error kind across two accounts → ai.provider_outage:gemini",
    Boolean(find({ ...HEALTHY, aiOutages: [{ provider: "gemini", errorKind: "timeout", accounts: 2 }] }, "ai.provider_outage:gemini")));
  check("the same across one account is that user's key, not an outage",
    !find({ ...HEALTHY, aiOutages: [{ provider: "gemini", errorKind: "timeout", accounts: 1 }] }, "ai.provider_outage:gemini"));
  check("five error events in an hour → errors.burst", Boolean(find({ ...HEALTHY, errorEventsLastHour: 5 }, "errors.burst")));
  check("three slow calls in an hour → perf.slow_burst", Boolean(find({ ...HEALTHY, perfSlowLastHour: 3 }, "perf.slow_burst")));
  const missing = find({ ...HEALTHY, missingRequiredEnv: ["CRON_SECRET", "APP_BASE_URL"] }, "config.missing");
  check("missing required env → config.missing naming the variables",
    missing?.severity === "warning" && missing.detail.includes("CRON_SECRET") && missing.detail.includes("APP_BASE_URL"), missing?.detail);
  check("backfills failing for two accounts → backfill.failed (warning)",
    find({ ...HEALTHY, backfillFailures24h: { accounts: 2, kinds: ["embeddings"] } }, "backfill.failed")?.severity === "warning");
  check("one account's failing backfill is that user's key, not an ops alert",
    !find({ ...HEALTHY, backfillFailures24h: { accounts: 1, kinds: ["embeddings"] } }, "backfill.failed"));

  check("an account with a flag older than 6h → embedding.backlog (warning)",
    find({ ...HEALTHY, embeddingBacklog: { accounts: 1, oldestAt: hoursAgo(30) } }, "embedding.backlog")?.severity === "warning");
  check("fresh flags only (the backfill is working) → quiet",
    !find({ ...HEALTHY, embeddingBacklog: { accounts: 0, oldestAt: hoursAgo(2) } }, "embedding.backlog"));

  check("an unattributed checkout → stripe.unattributed (critical)",
    find({ ...HEALTHY, stripeUnattributed24h: { fulfilments: 1, other: 0 } }, "stripe.unattributed")?.severity === "critical");
  check("an unattributed invoice or refund only → warning",
    find({ ...HEALTHY, stripeUnattributed24h: { fulfilments: 0, other: 2 } }, "stripe.unattributed")?.severity === "warning");

  check("statement_timeout 0 → config.statement_timeout_unbounded (warning)",
    find({ ...HEALTHY, statementTimeout: "0" }, "config.statement_timeout_unbounded")?.severity === "warning");
  check("a bounded or unknown timeout is quiet",
    !find(HEALTHY, "config.statement_timeout_unbounded") && !find({ ...HEALTHY, statementTimeout: null }, "config.statement_timeout_unbounded"));

  check("Slack unset in production → config.alerts_undeliverable (warning)",
    find({ ...HEALTHY, missingExpectedEnv: ["SLACK_OPS_WEBHOOK_URL"] }, "config.alerts_undeliverable")?.severity === "warning");
  check("another missing expected variable is not an alert",
    !find({ ...HEALTHY, missingExpectedEnv: ["SENTRY_DSN"] }, "config.alerts_undeliverable"));

  check("prod behind main by more than 6h → deploy.drift",
    Boolean(find({ ...HEALTHY, deploy: { prodSha: "abc", mainSha: "def", mainCommittedAt: hoursAgo(7) } }, "deploy.drift")));
  check("prod behind main by an hour is just a deploy in flight",
    !find({ ...HEALTHY, deploy: { prodSha: "abc", mainSha: "def", mainCommittedAt: hoursAgo(1) } }, "deploy.drift"));
  check("no deploy payload → no drift condition", !find({ ...HEALTHY, deploy: null }, "deploy.drift"));
  check("accounts needing re-auth → info", find({ ...HEALTHY, reauthNeeded: 3 }, "reauth.needed")?.severity === "info");
  check("a failed deletion run → purge.stuck (critical)",
    find({ ...HEALTHY, stuckPurges: 1 }, "purge.stuck")?.severity === "critical");
  check("no failed deletion runs → no purge.stuck", !find(HEALTHY, "purge.stuck"));
  check("every condition carries a title and a detail",
    evaluateOpsConditions({ ...HEALTHY, wedgedImports: 1, reauthNeeded: 1, errorEventsLastHour: 9 }, NOW).every((c) => c.title && c.detail));

  console.log("\nTransitions (planTransitions)...");
  const cond = (id: string, severity: "critical" | "warning" | "info") => ({ id, severity, title: id, detail: "d" });
  const row = (id: string, over: Partial<OpsAlertRow> = {}): OpsAlertRow => ({
    id, severity: "warning", active: true, openedAt: hoursAgo(10), lastSeenAt: hoursAgo(1), lastNotifiedAt: hoursAgo(1), notifyCount: 1, detail: {}, ...over,
  });

  let t = planTransitions([], [cond("a", "warning")], NOW);
  check("a new condition opens", t.open.length === 1 && t.open[0].id === "a" && t.remind.length === 0 && t.recover.length === 0);

  t = planTransitions([row("a", { severity: "critical", lastNotifiedAt: hoursAgo(1) })], [cond("a", "critical")], NOW);
  check("a critical condition seen an hour ago is unchanged", t.unchanged.length === 1 && t.remind.length === 0);

  t = planTransitions([row("a", { severity: "critical", lastNotifiedAt: hoursAgo(7) })], [cond("a", "critical")], NOW);
  check("a critical condition is reminded after 6h", t.remind.length === 1 && REMIND_AFTER_MS.critical === 6 * 3_600_000);

  t = planTransitions([row("a", { severity: "warning", lastNotifiedAt: hoursAgo(7) })], [cond("a", "warning")], NOW);
  check("a warning is not reminded at 7h", t.remind.length === 0 && t.unchanged.length === 1);
  t = planTransitions([row("a", { severity: "warning", lastNotifiedAt: hoursAgo(25) })], [cond("a", "warning")], NOW);
  check("a warning is reminded after 24h", t.remind.length === 1);

  t = planTransitions([row("a", { severity: "info", lastNotifiedAt: hoursAgo(200) })], [cond("a", "info")], NOW);
  check("info is never reminded", t.remind.length === 0);

  t = planTransitions([row("a")], [], NOW);
  check("an active row with no condition recovers", t.recover.length === 1 && t.recover[0].id === "a");

  t = planTransitions([row("a", { active: false })], [], NOW);
  check("an already-recovered row stays quiet", t.recover.length === 0 && t.open.length === 0);

  t = planTransitions([row("a", { active: false })], [cond("a", "warning")], NOW);
  check("a recovered row re-opens when the condition returns", t.open.length === 1);

  t = planTransitions([row("a", { severity: "warning" })], [cond("a", "critical")], NOW);
  check("an escalation in severity re-opens", t.open.length === 1 && t.open[0].severity === "critical");

  t = planTransitions([row("a", { lastNotifiedAt: null, notifyCount: 0 })], [cond("a", "warning")], NOW);
  check("an active row Slack never took is offered as an open again", t.open.length === 1 && t.unchanged.length === 0 && t.remind.length === 0);

  t = planTransitions([row("a", { lastNotifiedAt: null, notifyCount: 0 })], [], NOW);
  check("a never-announced row still recovers (state closes)", t.recover.length === 1);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ops-alert checks passed.");
}

main();
