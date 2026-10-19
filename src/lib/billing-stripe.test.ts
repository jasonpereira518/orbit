/**
 * Characterization of `decideStripeEvent` (plan P0.4). Pins TODAY's decisions, quirks
 * included. The function is pure: the clock arrives as `ctx.now` and the event's `created`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Stripe from "stripe";
import {
  decideStripeEvent,
  type ChargePurpose,
  type DecideContext,
  type StripeDecision,
} from "@/lib/billing-stripe";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const CREATED = 1_772_323_200; // 2026-03-01T00:00:00Z
const PERIOD_END = CREATED + 20 * 86400;
const USER = "user_1";

function ctx(over: Partial<DecideContext> = {}): DecideContext {
  return { userId: USER, beforeCents: 0, hadPriorRevenue: false, now: NOW, ...over };
}

function event(type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { id: "evt_1", type, created: CREATED, data: { object }, ...over } as unknown as Stripe.Event;
}

function subscription(over: Record<string, unknown> = {}, price: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    customer: "cus_1",
    metadata: { orbit_plan: "orbit", orbit_user_id: USER },
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_start: CREATED,
          current_period_end: PERIOD_END,
          price: {
            id: "price_1",
            unit_amount: 500,
            recurring: { interval: "month", interval_count: 1 },
            ...price,
          },
        },
      ],
    },
    ...over,
  };
}

const summarize = (d: StripeDecision) => ({
  outcome: d.outcome,
  reason: d.reason,
  mirrorType: d.mirror?.type ?? null,
  bookings: d.bookings.map((b) => [b.eventId, b.kind, b.amountCents ?? 0, b.mrrDeltaCents ?? 0]),
  targetUserId: d.targetUserId,
  resourceId: d.resourceId,
});

describe("decideStripeEvent: checkout", () => {
  it("lifetime session -> lifetime mirror + cash booking keyed on the session", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_1",
        customer: "cus_1",
        payment_status: "paid",
        amount_total: 14900,
        currency: "usd",
        payment_intent: "pi_1",
        metadata: { orbit_plan: "lifetime" },
      }),
      ctx()
    );
    assert.deepEqual(d.mirror, { type: "lifetime", userId: USER, stripeCustomerId: "cus_1" });
    assert.deepEqual(summarize(d).bookings, [["cs:cs_1", "lifetime", 14900, 0]]);
    assert.equal(d.outcome, "handled");
    assert.equal(d.bookings[0].detail.paymentIntentId, "pi_1");
    assert.equal(d.bookings[0].effectiveAt.getTime(), CREATED * 1000);
  });

  it("async_payment_succeeded books the same key as completed", () => {
    const obj = {
      id: "cs_1",
      payment_status: "paid",
      amount_total: 14900,
      metadata: { orbit_plan: "lifetime" },
    };
    const a = decideStripeEvent(event("checkout.session.completed", obj), ctx());
    const b = decideStripeEvent(event("checkout.session.async_payment_succeeded", obj, { id: "evt_2" }), ctx());
    assert.equal(a.bookings[0].eventId, b.bookings[0].eventId);
  });

  it("unpaid session is ignored", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "unpaid",
        metadata: { orbit_plan: "lifetime" },
      }),
      ctx()
    );
    assert.deepEqual(summarize(d), {
      outcome: "ignored",
      reason: "unpaid_session",
      mirrorType: null,
      bookings: [],
      targetUserId: USER,
      resourceId: "cs_1",
    });
  });

  it("no resolved user -> ignored missing_user_id with a null target", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", { id: "cs_1", metadata: { orbit_plan: "lifetime" } }),
      ctx({ userId: null })
    );
    assert.equal(d.reason, "missing_user_id");
    assert.equal(d.targetUserId, null);
  });

  it("credit pack -> credit_pack mirror, one-time revenue, default 250 credits", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_pack",
        customer: "cus_1",
        payment_status: "paid",
        amount_total: 500,
        payment_intent: "pi_pack",
        metadata: { orbit_plan: "credit_pack" },
      }),
      ctx()
    );
    assert.deepEqual(d.mirror, {
      type: "credit_pack",
      userId: USER,
      grantKey: "pack:cs:cs_pack",
      stripeRef: "pi_pack",
      amountCents: 500,
      credits: 250,
      stripeCustomerId: "cus_1",
    });
    assert.deepEqual(summarize(d).bookings, [["cs:cs_pack", "credit_pack", 500, 0]]);
  });

  it("monthly subscription checkout -> active mirror at the v2 list price (899c) and a 'new' MRR row", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_sub",
        customer: "cus_1",
        payment_status: "paid",
        amount_total: 500,
        metadata: { orbit_plan: "orbit", orbit_interval: "month" },
      }),
      ctx()
    );
    assert.equal(d.mirror?.type, "subscription");
    assert.deepEqual(d.mirror, {
      type: "subscription",
      userId: USER,
      plan: "orbit",
      status: "active",
      periodEnd: null,
      monthlyCents: 899,
      interval: "month",
      stripeCustomerId: "cus_1",
    });
    assert.deepEqual(summarize(d).bookings, [["csm:cs_sub", "new", 0, 899]]);
  });

  it("annual legacy checkout (amount_total 5000, no interval metadata) infers year", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_year",
        payment_status: "paid",
        amount_total: 5000,
        metadata: { orbit_plan: "orbit" },
      }),
      ctx()
    );
    assert.equal(d.mirror?.type, "subscription");
    if (d.mirror?.type === "subscription") {
      assert.equal(d.mirror.interval, "year");
      assert.equal(d.mirror.monthlyCents, 417);
    }
  });

  it("reactivation: prior revenue and before=0 files the MRR row as reactivation", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_sub",
        payment_status: "paid",
        metadata: { orbit_plan: "orbit", orbit_interval: "month" },
      }),
      ctx({ hadPriorRevenue: true })
    );
    assert.equal(d.bookings[0].kind, "reactivation");
  });

  it("subscription checkout older than the mirror is ignored as stale", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", {
        id: "cs_sub",
        payment_status: "paid",
        metadata: { orbit_plan: "orbit", orbit_interval: "month" },
      }),
      ctx({ lastSubscriptionEventAt: new Date((CREATED + 10) * 1000) })
    );
    assert.equal(d.reason, "stale_subscription_event");
  });

  it("unknown plan slug is ignored other_plan_slug", () => {
    const d = decideStripeEvent(
      event("checkout.session.completed", { id: "cs_x", payment_status: "paid", metadata: {} }),
      ctx()
    );
    assert.equal(d.reason, "other_plan_slug");
    assert.equal(d.outcome, "ignored");
  });
});

describe("decideStripeEvent: subscription lifecycle", () => {
  it("created (active, before=0) -> active mirror + 'new' row keyed on the EVENT", () => {
    const d = decideStripeEvent(event("customer.subscription.created", subscription()), ctx());
    assert.equal(d.outcome, "handled");
    assert.deepEqual(d.mirror, {
      type: "subscription",
      userId: USER,
      plan: "orbit",
      status: "active",
      periodStart: CREATED,
      periodEnd: PERIOD_END,
      monthlyCents: 500,
      interval: "month",
      stripeCustomerId: "cus_1",
      eventAt: new Date(CREATED * 1000),
    });
    assert.deepEqual(summarize(d).bookings, [["evt_1", "new", 0, 500]]);
  });

  it("updated with no value change books nothing but still mirrors", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription()),
      ctx({ beforeCents: 500 })
    );
    assert.equal(d.outcome, "handled");
    assert.deepEqual(d.bookings, []);
    assert.equal(d.mirror?.type, "subscription");
  });

  it("updated to a pricier price -> expansion", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription({}, { unit_amount: 1000 })),
      ctx({ beforeCents: 500 })
    );
    assert.deepEqual(summarize(d).bookings, [["evt_1", "expansion", 0, 500]]);
  });

  it("past_due keeps the plan with status past_due and the full value", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription({ status: "past_due" })),
      ctx({ beforeCents: 500 })
    );
    assert.equal(d.mirror?.type === "subscription" && d.mirror.status, "past_due");
    assert.deepEqual(d.bookings, []);
  });

  it("incomplete status -> null plan/status and a zero value (churn if there was value)", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription({ status: "incomplete" })),
      ctx({ beforeCents: 500 })
    );
    assert.equal(d.mirror?.type === "subscription" && d.mirror.plan, null);
    assert.equal(d.mirror?.type === "subscription" && d.mirror.status, null);
    assert.deepEqual(summarize(d).bookings, [["evt_1", "churn", 0, -500]]);
  });

  it("deleted -> canceled mirror, forced zero value, churn row flagged terminal", () => {
    const d = decideStripeEvent(
      event("customer.subscription.deleted", subscription({ status: "canceled" })),
      ctx({ beforeCents: 500 })
    );
    assert.equal(d.mirror?.type === "subscription" && d.mirror.status, "canceled");
    assert.deepEqual(summarize(d).bookings, [["evt_1", "churn", 0, -500]]);
    assert.equal(d.bookings[0].detail.terminal, true);
    assert.equal(d.bookings[0].detail.afterCents, 0);
  });

  it("deleted when the mirror is already at zero books nothing", () => {
    const d = decideStripeEvent(
      event("customer.subscription.deleted", subscription({ status: "canceled" })),
      ctx({ beforeCents: 0 })
    );
    assert.deepEqual(d.bookings, []);
    assert.equal(d.outcome, "handled");
  });

  it("an `updated` older than the last applied event is stale", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription()),
      ctx({ lastSubscriptionEventAt: new Date((CREATED + 5) * 1000) })
    );
    assert.equal(d.reason, "stale_subscription_event");
    assert.equal(d.mirror, null);
  });

  it("same-second: a terminal event is not stale, a non-terminal after cancel is", () => {
    const base = { lastSubscriptionEventAt: new Date(CREATED * 1000), currentSubscriptionStatus: "canceled" as const };
    assert.equal(
      decideStripeEvent(event("customer.subscription.updated", subscription()), ctx(base)).reason,
      "stale_subscription_event"
    );
    assert.equal(
      decideStripeEvent(event("customer.subscription.deleted", subscription({ status: "canceled" })), ctx(base)).outcome,
      "handled"
    );
  });

  it("foreign orbit_plan metadata is ignored; no user is ignored", () => {
    const foreign = subscription({ metadata: { orbit_plan: "lifetime", orbit_user_id: USER } });
    assert.equal(decideStripeEvent(event("customer.subscription.created", foreign), ctx()).reason, "other_plan_slug");
    assert.equal(
      decideStripeEvent(event("customer.subscription.created", subscription()), ctx({ userId: null })).reason,
      "missing_user_id"
    );
  });
});

describe("decideStripeEvent: invoices", () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: "in_1",
    subscription: "sub_1",
    amount_paid: 500,
    currency: "usd",
    billing_reason: "subscription_cycle",
    status_transitions: { paid_at: CREATED + 60 },
    ...over,
  });

  it("paid -> cash row keyed on the invoice, mirror null", () => {
    const d = decideStripeEvent(event("invoice.paid", invoice()), ctx());
    assert.equal(d.mirror, null);
    assert.deepEqual(summarize(d).bookings, [["in:in_1", "payment", 500, 0]]);
    assert.equal(d.bookings[0].effectiveAt.getTime(), (CREATED + 60) * 1000);
  });

  it("paid reads the subscription from parent.subscription_details too", () => {
    const d = decideStripeEvent(
      event("invoice.paid", invoice({ subscription: undefined, parent: { subscription_details: { subscription: "sub_9" } } })),
      ctx()
    );
    assert.equal(d.bookings[0].detail.subscriptionId, "sub_9");
  });

  it("paid without a subscription / with zero amount is ignored", () => {
    assert.equal(
      decideStripeEvent(event("invoice.paid", invoice({ subscription: null })), ctx()).reason,
      "no_subscription_on_invoice"
    );
    assert.equal(decideStripeEvent(event("invoice.paid", invoice({ amount_paid: 0 })), ctx()).reason, "zero_amount");
  });

  it("paid in a foreign currency books zero cash but is 'handled' with a reason", () => {
    const d = decideStripeEvent(event("invoice.paid", invoice({ currency: "EUR" })), ctx());
    assert.equal(d.outcome, "handled");
    assert.equal(d.reason, "currency_unsupported");
    assert.deepEqual(summarize(d).bookings, [["in:in_1", "payment", 0, 0]]);
    assert.equal(d.bookings[0].detail.amountPaid, 500);
  });

  it("payment_failed -> payment_failed row keyed on the event", () => {
    const d = decideStripeEvent(
      event("invoice.payment_failed", invoice({ attempt_count: 2, amount_due: 500 })),
      ctx()
    );
    assert.equal(d.mirror, null);
    assert.deepEqual(summarize(d).bookings, [["evt_1", "payment_failed", 0, 0]]);
    assert.equal(d.bookings[0].detail.attemptCount, 2);
  });
});

describe("decideStripeEvent: refunds and disputes", () => {
  const charge = (over: Record<string, unknown> = {}) => ({
    id: "ch_1",
    currency: "usd",
    payment_intent: "pi_1",
    refunded: false,
    amount_captured: 1000,
    amount_refunded: 500,
    refunds: { data: [{ id: "re_1", amount: 500, created: CREATED + 5, reason: null }] },
    ...over,
  });
  const dispute = (over: Record<string, unknown> = {}) => ({
    id: "dp_1",
    charge: "ch_1",
    payment_intent: "pi_1",
    amount: 1000,
    reason: "fraudulent",
    status: "lost",
    ...over,
  });

  it("partial refund -> one refund row per refund, no revocation", () => {
    const d = decideStripeEvent(event("charge.refunded", charge()), ctx({ chargePurpose: "lifetime" }));
    assert.equal(d.mirror, null);
    assert.deepEqual(summarize(d).bookings, [["re:re_1", "refund", 500, 0]]);
  });

  it("partial refund with unexpanded refunds is ignored zero_amount", () => {
    const d = decideStripeEvent(event("charge.refunded", charge({ refunds: undefined })), ctx());
    assert.equal(d.reason, "zero_amount");
  });

  // KNOWN QUIRK: without `ctx.chargePurpose` (the backfill passes none) a FULL refund
  // returns mirror: null — access is never revoked. Revocation depends on the driver.
  it("QUIRK: full refund with no chargePurpose -> mirror null (nothing revoked)", () => {
    const d = decideStripeEvent(event("charge.refunded", charge({ refunded: true })), ctx());
    assert.equal(d.mirror, null);
    assert.equal(d.outcome, "handled");
    assert.deepEqual(summarize(d).bookings, [["re:re_1", "refund", 500, 0]]);
  });

  it("QUIRK: chargePurpose 'unknown' also revokes nothing", () => {
    const d = decideStripeEvent(event("charge.refunded", charge({ refunded: true })), ctx({ chargePurpose: "unknown" }));
    assert.equal(d.mirror, null);
  });

  const revocations: Array<[ChargePurpose, string | null]> = [
    ["lifetime", "lifetime_revoked"],
    ["credit_pack", "credit_pack_revoked"],
    ["subscription", "subscription_revoked"],
    ["unknown", null],
  ];
  for (const [purpose, mirrorType] of revocations) {
    it(`full refund with chargePurpose '${purpose}' -> ${mirrorType ?? "no mirror"}`, () => {
      const d = decideStripeEvent(
        event("charge.refunded", charge({ refunded: true })),
        ctx({ chargePurpose: purpose, beforeCents: 500 })
      );
      assert.equal(d.mirror?.type ?? null, mirrorType);
      // Subscription revocation adds a churn row beside the refund row.
      assert.equal(d.bookings.length, purpose === "subscription" ? 2 : 1);
    });
  }

  it("dispute.created -> an incident row (kind payment_failed), no mirror, no cash", () => {
    const d = decideStripeEvent(event("charge.dispute.created", dispute({ status: "needs_response" })), ctx());
    assert.equal(d.mirror, null);
    assert.deepEqual(summarize(d).bookings, [["evt_1", "payment_failed", 0, 0]]);
    assert.equal(d.bookings[0].detail.disputedCents, 1000);
  });

  it("dispute.closed won -> ignored dispute_won", () => {
    const d = decideStripeEvent(event("charge.dispute.closed", dispute({ status: "won" })), ctx());
    assert.equal(d.reason, "dispute_won");
    assert.equal(d.outcome, "ignored");
  });

  it("QUIRK: dispute.closed lost with no chargePurpose books the loss but mirror is null", () => {
    const d = decideStripeEvent(event("charge.dispute.closed", dispute()), ctx());
    assert.equal(d.mirror, null);
    assert.deepEqual(summarize(d).bookings, [["dp:dp_1", "refund", 1000, 0]]);
  });

  it("dispute.closed lost + lifetime purpose -> lifetime_revoked", () => {
    const d = decideStripeEvent(event("charge.dispute.closed", dispute()), ctx({ chargePurpose: "lifetime" }));
    assert.deepEqual(d.mirror, { type: "lifetime_revoked", userId: USER, reason: "dispute_lost" });
  });

  it("dispute.closed lost + subscription purpose -> revoked now plus churn row", () => {
    const d = decideStripeEvent(
      event("charge.dispute.closed", dispute()),
      ctx({ chargePurpose: "subscription", beforeCents: 500 })
    );
    assert.deepEqual(d.mirror, {
      type: "subscription_revoked",
      userId: USER,
      reason: "dispute_lost",
      periodEnd: Math.floor(NOW.getTime() / 1000),
    });
    assert.deepEqual(summarize(d).bookings, [
      ["dp:dp_1", "refund", 1000, 0],
      ["evt_1", "churn", 0, -500],
    ]);
  });
});

describe("decideStripeEvent: other", () => {
  it("unknown type -> ignored unhandled_type, carrying the resource id", () => {
    const d = decideStripeEvent(event("customer.created", { id: "cus_9" }), ctx());
    assert.deepEqual(summarize(d), {
      outcome: "ignored",
      reason: "unhandled_type",
      mirrorType: null,
      bookings: [],
      targetUserId: USER,
      resourceId: "cus_9",
    });
  });

  it("an event without `created` falls back to ctx.now and is never gated as stale", () => {
    const d = decideStripeEvent(
      event("customer.subscription.updated", subscription(), { created: undefined }),
      ctx({ lastSubscriptionEventAt: new Date(CREATED * 1000 + 99_000) })
    );
    assert.equal(d.outcome, "handled");
    assert.equal(d.mirror?.type === "subscription" && d.mirror.eventAt, null);
  });
});
