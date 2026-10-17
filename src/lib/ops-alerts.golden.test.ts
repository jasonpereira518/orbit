import "../../scripts/smoke/_env";
// Off production, so the production-only snapshot fields stay quiet.
delete process.env.VERCEL_ENV;

import { after, before, describe, it, mock } from "node:test";
import { getDb } from "@/db";
import { cronRuns, imports } from "@/db/schema";
import { evaluateOpsConditions, type OpsSnapshot } from "@/lib/ops-alerts";
import { loadOpsSnapshot } from "@/lib/ops-sweep";
import { expectGolden, FROZEN_NOW as NOW, freezeClock } from "@/test-support/golden";

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** Everything healthy. Each row of the table overrides some of it. */
const HEALTHY: OpsSnapshot = {
  cron: {
    processStalled: { lastStartedAt: hoursAgo(2), lastState: "ok" },
    syncRun: { lastStartedAt: hoursAgo(1), lastState: "ok" },
    drain: { lastStartedAt: hoursAgo(0.2), lastState: "ok" },
    jobFeed: { lastStartedAt: hoursAgo(1), lastState: "ok" },
    radarRun: { lastStartedAt: hoursAgo(10), lastState: "ok" },
    radarFeeds: { lastStartedAt: hoursAgo(1), lastState: "ok" },
    radarDigest: { lastStartedAt: hoursAgo(30), lastState: "ok" },
    workHistory: { lastStartedAt: hoursAgo(1), lastState: "ok" },
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
  syncOldestDueAgeMs: null,
  aiRefusals24h: { unembeddable: 0, quotaAccounts: 0 },
  calendarDisarmed: 0,
  sharedBudgets: { avatarSourcesExhausted: [], apolloCapHits: 0 },
  managedAi: {
    configured: true,
    switchedOff: false,
    includedAccounts: 3,
    spentLast24hMicros: 40_000,
    spentLast30dMicros: 600_000,
    revenueLast30dCents: 7_500,
    accountsAtCap: 0,
    failingProviders: [],
    poolSpentMicros: {},
  },
};

type Over = Partial<Omit<OpsSnapshot, "cron" | "managedAi">> & {
  cron?: Partial<OpsSnapshot["cron"]>;
  managedAi?: Partial<OpsSnapshot["managedAi"]>;
};
const snap = (o: Over): OpsSnapshot => ({
  ...HEALTHY,
  ...o,
  cron: { ...HEALTHY.cron, ...o.cron },
  managedAi: { ...HEALTHY.managedAi, ...o.managedAi },
});

const CASES: Array<[string, OpsSnapshot]> = [
  ["healthy", HEALTHY],
  ["cron: process-stalled never ran", snap({ cron: { processStalled: { lastStartedAt: null, lastState: null } } })],
  ["cron: process-stalled last run failed", snap({ cron: { processStalled: { lastStartedAt: hoursAgo(1), lastState: "failed" } } })],
  ["cron: process-stalled partial streak", snap({ processStalledRecent: ["partial", "partial", "partial"] })],
  ["cron: drain failed", snap({ cron: { drain: { lastStartedAt: minutesAgo(5), lastState: "failed" } } })],
  ["cron: drain silent for 3h", snap({ cron: { drain: { lastStartedAt: hoursAgo(3), lastState: "ok" } } })],
  ["cron: sync missed and failed", snap({ cron: { syncRun: { lastStartedAt: hoursAgo(9), lastState: "failed" } } })],
  ["cron: job feed missed", snap({ cron: { jobFeed: { lastStartedAt: hoursAgo(8), lastState: "ok" } } })],
  ["cron: radar nightly failed", snap({ cron: { radarRun: { lastStartedAt: hoursAgo(10), lastState: "failed" } } })],
  ["cron: radar feeds / digest / work history missed", snap({ cron: { radarFeeds: { lastStartedAt: hoursAgo(12), lastState: "ok" }, radarDigest: { lastStartedAt: hoursAgo(80), lastState: "ok" }, workHistory: { lastStartedAt: hoursAgo(40), lastState: "ok" } } })],
  ["stripe: checkout errors", snap({ stripeCheckoutErrorsLastHour: 3 })],
  ["stripe: unattributed fulfilment", snap({ stripeUnattributed24h: { fulfilments: 1, other: 0 } })],
  ["stripe: unattributed other", snap({ stripeUnattributed24h: { fulfilments: 0, other: 4 } })],
  ["ai security burst", snap({ aiSecurityLastHour: { events: 6, accounts: 2 } })],
  ["resend rejected", snap({ resendRejectedLastHour: 2 })],
  ["webhooks: clerk errors", snap({ webhooks: { clerk: ["error", "error", "error"], stripe: ["invalid"], resend: ["handled"] } })],
  ["imports: wedged and failed burst", snap({ wedgedImports: 2, failedImportsLast24h: 6 })],
  ["sync: wedged, failing, lagging", snap({ wedgedSyncs: 1, failingSyncs: 2, syncOldestDueAgeMs: 3 * 3_600_000 })],
  ["calendar disarmed", snap({ calendarDisarmed: 6 })],
  ["outreach overdue", snap({ outreach: { overdue: 4, oldestOverdueDays: 9 } })],
  ["backfill failures", snap({ backfillFailures24h: { accounts: 2, kinds: ["embeddings", "avatars"] } })],
  ["embedding backlog and unembeddable", snap({ embeddingBacklog: { accounts: 3, oldestAt: hoursAgo(9) }, aiRefusals24h: { unembeddable: 12, quotaAccounts: 2 } })],
  ["shared budgets exhausted", snap({ sharedBudgets: { avatarSourcesExhausted: ["unavatar"], apolloCapHits: 3 } })],
  ["ai outages", snap({ aiOutages: [{ provider: "gemini", errorKind: "auth", accounts: 3 }, { provider: null, errorKind: "timeout", accounts: 1 }] })],
  ["error and perf bursts", snap({ errorEventsLastHour: 80, perfSlowLastHour: 40 })],
  ["config: missing env, no slack, unbounded timeout", snap({ missingRequiredEnv: ["CLERK_SECRET_KEY"], missingExpectedEnv: ["SLACK_OPS_WEBHOOK_URL"], statementTimeout: "0" })],
  ["deploy drift", snap({ deploy: { prodSha: "1111111aaaa", mainSha: "2222222bbbb", mainCommittedAt: hoursAgo(30) } })],
  ["deploy behind but fresh", snap({ deploy: { prodSha: "1111111aaaa", mainSha: "2222222bbbb", mainCommittedAt: hoursAgo(0.5) } })],
  ["deploy unknown", snap({ deploy: null })],
  ["reauth and stuck purges", snap({ reauthNeeded: 5, stuckPurges: 1 })],
  ["managed ai: failing provider + unconfigured", snap({ managedAi: { configured: false, failingProviders: ["gemini", "openai"] } })],
  ["managed ai: switched off", snap({ managedAi: { configured: false, switchedOff: true } })],
  ["managed ai: spend spike and runway", snap({ managedAi: { spentLast24hMicros: 60_000_000, spentLast30dMicros: 10_000_000, revenueLast30dCents: 1_500 } })],
  ["managed ai: accounts at cap", snap({ managedAi: { accountsAtCap: 2 } })],
  ["managed ai: pool spend", snap({ managedAi: { poolSpentMicros: { gemini: 900_000_000 } } })],
];

describe("evaluateOpsConditions (golden)", () => {
  it("pins the condition list for each snapshot state", () => {
    const table = CASES.map(([name, snapshot]) => ({
      name,
      conditions: evaluateOpsConditions(snapshot, NOW)
        .map((c) => ({ id: c.id, severity: c.severity, title: c.title, detail: c.detail, href: c.href ?? null }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    }));
    expectGolden(import.meta.url, "ops-alerts-table", table);
  });

  describe("against a seeded database", () => {
    before(() => freezeClock());
    after(() => mock.timers.reset());

    it("pins the conditions loadOpsSnapshot derives from rows", async () => {
      const db = await getDb();
      const before = evaluateOpsConditions(await loadOpsSnapshot(NOW, null), NOW);

      await db.insert(cronRuns).values([
        { job: "imports.process-stalled", trigger: "manual", status: "failed", startedAt: minutesAgo(30), finishedAt: minutesAgo(29) },
        { job: "webhooks.drain", trigger: "manual", status: "ok", startedAt: minutesAgo(5), finishedAt: minutesAgo(5) },
        { job: "sync.run", trigger: "manual", status: "ok", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) },
      ]);
      // A wedged import: still processing, untouched for far longer than any run should take.
      await db.insert(imports).values({
        userId: "golden-user", importType: "linkedin_connections", fileName: "x.csv", status: "processing",
        totalRows: 10, stats: {}, createdAt: hoursAgo(30), updatedAt: hoursAgo(30),
      });
      const after = evaluateOpsConditions(await loadOpsSnapshot(NOW, null), NOW);

      const view = (cs: typeof before) =>
        cs.map((c) => ({ id: c.id, severity: c.severity, title: c.title, detail: c.detail })).sort((a, b) => (a.id < b.id ? -1 : 1));
      expectGolden(import.meta.url, "ops-alerts-seeded-db", { emptyDatabase: view(before), afterSeeding: view(after) });
    });
  });
});
