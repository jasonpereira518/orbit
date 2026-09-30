/**
 * Pricing v2's server-side limits, on PGlite:
 *
 *  - Contact enrichment on Orbit's Apollo key: 10 a month on Pro, 25 on Max and Lifetime,
 *    none on Free — enforced atomically, even for two requests at the edge.
 *  - The Free Plan's one Google OR Microsoft account: a second provider is refused; the one
 *    already connected can always reconnect; a Free account that had both keeps its earlier
 *    one syncing and the later one paused (never disconnected).
 *  - REST API webhooks are Max/Lifetime only: a Pro account's endpoints are kept but receive
 *    nothing, and the account is told why.
 *
 * Run: npx tsx scripts/smoke-plan-enforcement.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const FREE = "smoke-pe-free";
const PRO = "smoke-pe-pro";
const MAX = "smoke-pe-max";
const BOTH = "smoke-pe-both";

run(async () => {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { consumePlanMeter, planMeterUsed, meterPeriodKey } = await import("../src/lib/plan-meters");
  const { apolloMonthlyLimitMessage } = await import("../src/lib/apollo");
  const { canConnect, extraConnectionPaused, refusedConnectUrl } = await import("../src/lib/connection-limits");
  const { enqueueWebhookEvents } = await import("../src/lib/webhooks/dispatch");
  const { evaluateAccountHealth, toAccountAlerts } = await import("../src/lib/account-alerts");
  const { describeOAuthReason } = await import("../src/lib/errors");
  const { EXTRA_CONNECTION_DENIAL } = await import("../src/lib/plans/plan-config");
  const { loadAccountHealthInput } = await import("../src/lib/account-health");

  const db = await getDb();
  const users = [FREE, PRO, MAX, BOTH];
  const reset = async () => {
    for (const t of [schema.planMeterUsage, schema.gateEvents, schema.gmailConnections, schema.outlookConnections,
      schema.outboundWebhookDeliveries, schema.webhookEndpoints, schema.apiKeys]) {
      await db.delete(t).where(inArray((t as typeof schema.gateEvents).userId, users));
    }
    await db.delete(schema.userSettings).where(inArray(schema.userSettings.userId, users));
  };
  await reset();
  await db.insert(schema.userSettings).values([
    { userId: FREE },
    { userId: PRO, subscriptionPlan: "orbit", subscriptionStatus: "active" },
    { userId: MAX, compedPlan: "max" },
    { userId: BOTH },
  ]);

  console.log("Monthly contact enrichments on Orbit's key");
  let used = 0;
  for (let i = 0; i < 10; i++) used += (await consumePlanMeter(PRO, "hosted_enrichment", 1, 10)) ? 1 : 0;
  check("Pro: ten enrichments fit", used === 10 && (await planMeterUsed(PRO, "hosted_enrichment")) === 10);
  check("…the eleventh is refused and not counted",
    !(await consumePlanMeter(PRO, "hosted_enrichment", 1, 10)) && (await planMeterUsed(PRO, "hosted_enrichment")) === 10);
  check("a batch that would overshoot is refused whole", !(await consumePlanMeter(MAX, "hosted_enrichment", 26, 25)));
  await consumePlanMeter(MAX, "hosted_enrichment", 24, 25);
  const race = await Promise.all([
    consumePlanMeter(MAX, "hosted_enrichment", 1, 25),
    consumePlanMeter(MAX, "hosted_enrichment", 1, 25),
  ]);
  check("two requests at 24 of 25: exactly one lands", race.filter(Boolean).length === 1 && (await planMeterUsed(MAX, "hosted_enrichment")) === 25, race);
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2));
  check("next month starts from zero", (await consumePlanMeter(PRO, "hosted_enrichment", 1, 10, nextMonth)) &&
    meterPeriodKey(nextMonth) !== meterPeriodKey());
  check("the Pro message offers Max and a key; Max's does not offer Max",
    /move to Max/.test(apolloMonthlyLimitMessage("orbit", 10)) && !/move to Max/.test(apolloMonthlyLimitMessage("max", 25)) &&
      /own Apollo key/.test(apolloMonthlyLimitMessage("max", 25)));

  console.log("\nThe Free Plan's one Google or Microsoft account");
  const conn = (userId: string, createdAt: Date) => ({
    userId, emailAddress: `${userId}@example.test`, accessTokenEncrypted: "x", createdAt,
  });
  check("Free with nothing connected may connect Google", await canConnect(FREE, "google"));
  await db.insert(schema.gmailConnections).values(conn(FREE, new Date()));
  check("…and reconnect Google", await canConnect(FREE, "google"));
  check("…but not add Microsoft", !(await canConnect(FREE, "microsoft")));
  const [hit] = await db.select().from(schema.gateEvents).where(and(eq(schema.gateEvents.userId, FREE), eq(schema.gateEvents.feature, "extraConnections")));
  check("…and the refusal is recorded, unlocking on Pro", hit?.unlockPlan === "orbit", hit);
  await db.insert(schema.gmailConnections).values(conn(PRO, new Date()));
  check("Pro connects both", await canConnect(PRO, "microsoft"));
  check("the refusal goes back to the page with a reason the UI already describes",
    refusedConnectUrl("/settings?integration=microsoft", "microsoft") === "/settings?integration=microsoft&outlook=error&reason=plan_limit" &&
      describeOAuthReason("plan_limit", "Outlook").message === EXTRA_CONNECTION_DENIAL);

  const earlier = new Date(Date.now() - 30 * 86_400_000);
  await db.insert(schema.gmailConnections).values(conn(BOTH, earlier));
  await db.insert(schema.outlookConnections).values(conn(BOTH, new Date()));
  check("a Free account that already had both keeps its earlier one syncing", !(await extraConnectionPaused(BOTH, "google")));
  check("…and pauses the later one", await extraConnectionPaused(BOTH, "microsoft"));
  check("…whose connection row is kept", (await db.select().from(schema.outlookConnections).where(eq(schema.outlookConnections.userId, BOTH))).length === 1);
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, BOTH));
  check("on Pro both sync again", !(await extraConnectionPaused(BOTH, "microsoft")));

  console.log("\nWebhooks are Max and Lifetime only");
  for (const userId of [PRO, MAX]) {
    await db.insert(schema.webhookEndpoints).values({
      userId, url: "https://hooks.example.test/x", secretEncrypted: "x", eventTypes: ["contact.created"], status: "active",
    });
  }
  const proQueued = await enqueueWebhookEvents(PRO, "contact.created", [{ object: { id: "c1" } }]);
  const maxQueued = await enqueueWebhookEvents(MAX, "contact.created", [{ object: { id: "c1" } }]);
  check("a Pro account's endpoint receives nothing", proQueued.length === 0 &&
    (await db.select().from(schema.outboundWebhookDeliveries).where(eq(schema.outboundWebhookDeliveries.userId, PRO))).length === 0);
  check("…and is kept, still active", (await db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.userId, PRO)))[0]?.status === "active");
  check("a Max account's endpoint is queued", maxQueued.length === 1);

  const input = await loadAccountHealthInput(PRO);
  check("the Pro account's health counts its paused endpoint", input?.pausedApiItems === 1, input?.pausedApiItems);
  const alert = toAccountAlerts(evaluateAccountHealth({ ...(input as NonNullable<typeof input>), onboardingCompletedAt: new Date() }))
    .find((a) => a.code === "plan.api_paused");
  check("…and tells them why, with the way back", Boolean(alert) && alert!.cta?.href === "/upgrade" && /kept exactly as they are/.test(alert!.body ?? ""), alert);
  const maxInput = await loadAccountHealthInput(MAX);
  check("Max hears nothing about it", (maxInput?.pausedApiItems ?? 0) === 0);

  await reset();
  if (failures > 0) throw new Error(`${failures} plan-enforcement check(s) failed`);
  console.log("\nAll plan-enforcement checks passed.");
});
