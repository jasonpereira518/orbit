import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

const SUBSCRIBER = "unit-subman-subscriber";
const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * 86_400;

const sub = {
  id: "sub_unit",
  object: "subscription",
  status: "active",
  created: 100,
  cancel_at_period_end: false,
  cancel_at: null,
  metadata: { orbit_plan: "orbit" },
  items: {
    data: [
      {
        id: "si_unit",
        quantity: 1,
        current_period_end: PERIOD_END,
        price: { id: "price_unit", lookup_key: "orbit_pro_monthly_v2", unit_amount: 899, currency: "usd", recurring: { interval: "month", interval_count: 1 } },
      },
    ],
  },
} as unknown as Stripe.Subscription;

const boom = new Error("stripe down");
const okStripe = {
  list: async () => [sub],
  update: async () => sub,
  portal: async () => ({ url: "https://billing.test/s" }),
  priceFor: async () => "price_unit_max",
  portalConfiguration: async () => "bpc_unit",
};

describe("subscription-management reports caught Stripe failures", () => {
  let sm: typeof import("./subscription-management");
  let errorMock: ReturnType<typeof mock.method>;

  before(async () => {
    const { getDb } = await import("@/db");
    const { userSettings } = await import("@/db/schema");
    const { ensureUserSettings } = await import("@/lib/user-settings");
    sm = await import("./subscription-management");
    const db = await getDb();
    await ensureUserSettings(SUBSCRIBER);
    await db
      .update(userSettings)
      .set({ stripeCustomerId: "cus_unit", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: new Date(PERIOD_END * 1000) })
      .where(eq(userSettings.userId, SUBSCRIBER));
  });

  function capture() {
    errorMock = mock.method(console, "error", () => {});
  }
  function lines(where: string) {
    return errorMock.mock.calls
      .map((c) => String(c.arguments[0]))
      .filter((l) => l.startsWith(`[orbit:${where}] ref=`));
  }
  after(() => mock.restoreAll());

  it("lookup failure", async () => {
    capture();
    const res = await sm.getSubscriptionDetails(SUBSCRIBER, { stripe: { ...okStripe, list: async () => { throw boom; } } });
    assert.deepEqual(res, { ok: false, error: sm.SUBSCRIPTION_COPY.unavailable });
    assert.equal(lines("lib.subscription.lookup").length, 1);
    assert.match(lines("lib.subscription.lookup")[0], new RegExp(`user=${SUBSCRIBER}`));
    errorMock.mock.restore();
  });

  it("update failure", async () => {
    capture();
    const res = await sm.cancelSubscription(SUBSCRIBER, { stripe: { ...okStripe, update: async () => { throw boom; } } });
    assert.deepEqual(res, { ok: false, error: sm.SUBSCRIPTION_COPY.unavailable });
    assert.equal(lines("lib.subscription.update").length, 1);
    errorMock.mock.restore();
  });

  it("plan-switch failure", async () => {
    capture();
    const res = await sm.createPlanSwitchUrl(SUBSCRIBER, "max", { stripe: { ...okStripe, portal: async () => { throw boom; } } });
    assert.deepEqual(res, { ok: false, error: sm.SUBSCRIPTION_COPY.unavailable });
    assert.equal(lines("lib.subscription.plan-switch").length, 1);
    errorMock.mock.restore();
  });

  it("lifetime lookup failure", async () => {
    capture();
    const res = await sm.lifetimeGrantSubscriptionEffect(SUBSCRIBER, { stripe: { ...okStripe, list: async () => { throw boom; } } });
    assert.deepEqual(res, { kind: "error", error: sm.SUBSCRIPTION_COPY.unavailable });
    assert.equal(lines("lib.subscription.lifetime-lookup").length, 1);
    errorMock.mock.restore();
  });

  it("lifetime end failure", async () => {
    capture();
    const res = await sm.endSubscriptionForLifetime(SUBSCRIBER, { stripe: { ...okStripe, update: async () => { throw boom; } } });
    assert.equal(res, "error");
    assert.equal(lines("lib.subscription.lifetime-end").length, 1);
    errorMock.mock.restore();
  });
});
