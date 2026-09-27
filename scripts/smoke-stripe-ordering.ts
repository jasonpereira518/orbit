/**
 * Out-of-order Stripe subscription events (launch Phase 2, audit B2). Pure: drives
 * `decideStripeEvent` with a context, no database.
 *
 * Run: npx tsx scripts/smoke-stripe-ordering.ts
 */
import type Stripe from "stripe";
import {
  decideStripeEvent,
  isStaleSubscriptionEvent,
  type DecideContext,
} from "../src/lib/billing-stripe";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "user_ordering";
const T1 = 1_800_000_000;
const T2 = T1 + 60;
const at = (s: number) => new Date(s * 1000);

function ctx(over: Partial<DecideContext> = {}): DecideContext {
  return { userId: USER, beforeCents: 500, hadPriorRevenue: true, now: at(T2 + 5), ...over };
}

function sub(type: string, created: number | undefined, status = "active") {
  return {
    id: `evt_${type}_${created ?? "none"}`,
    type,
    ...(created !== undefined ? { created } : {}),
    data: {
      object: {
        id: "sub_ordering",
        object: "subscription",
        status,
        customer: "cus_ordering",
        metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [SUBSCRIPTION_USER_METADATA_KEY]: USER },
        items: { data: [{ id: "si_1", quantity: 1, current_period_end: T2 + 30 * 86400, price: { unit_amount: 500, recurring: { interval: "month", interval_count: 1 } } }] },
      },
    },
  } as unknown as Stripe.Event;
}

function checkout(plan: string, created: number) {
  return {
    id: `evt_checkout_${plan}_${created}`,
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: `cs_${plan}`,
        object: "checkout.session",
        client_reference_id: USER,
        payment_status: "paid",
        amount_total: plan === "lifetime" ? 4900 : 500,
        customer: "cus_ordering",
        metadata: { [LIFETIME_METADATA_KEY]: plan === "lifetime" ? LIFETIME_METADATA_VALUE : PRO_METADATA_VALUE },
      },
    },
  } as unknown as Stripe.Event;
}

console.log("isStaleSubscriptionEvent");
check("never stale with no clock", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: null }, at(T1), false));
check("never stale with no created", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2) }, null, false));
check("older is stale", isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2) }, at(T1), false));
check("newer is fresh", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T1) }, at(T2), false));
check(
  "same second after a cancellation: a non-terminal event loses",
  isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }, at(T2), false)
);
check(
  "same second: a terminal event wins",
  !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "active" }, at(T2), true)
);

console.log("\ndecideStripeEvent");
const stale = decideStripeEvent(sub("customer.subscription.updated", T1), ctx({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }));
check("an updated older than the applied deleted is ignored", stale.outcome === "ignored" && stale.reason === "stale_subscription_event", JSON.stringify(stale));
check("...with no mirror and no booking", stale.mirror === null && stale.bookings.length === 0);

const fresh = decideStripeEvent(sub("customer.subscription.deleted", T2, "canceled"), ctx({ lastSubscriptionEventAt: at(T1) }));
check("a newer deleted is handled", fresh.outcome === "handled");
check(
  "...and carries its created time for the clock",
  fresh.mirror?.type === "subscription" && fresh.mirror.eventAt?.getTime() === at(T2).getTime(),
  JSON.stringify(fresh.mirror)
);

const undated = decideStripeEvent(sub("customer.subscription.updated", undefined), ctx({ lastSubscriptionEventAt: at(T2) }));
check("an event with no created is never gated", undated.outcome === "handled");
check("...and does not move the clock", undated.mirror?.type === "subscription" && (undated.mirror.eventAt ?? null) === null);

const staleCheckout = decideStripeEvent(checkout("pro", T1), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }));
check("a Pro checkout older than the clock is ignored", staleCheckout.reason === "stale_subscription_event", JSON.stringify(staleCheckout));
const freshCheckout = decideStripeEvent(checkout("pro", T2), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T1) }));
check(
  "a fresh Pro checkout grants without moving the clock",
  freshCheckout.mirror?.type === "subscription" && (freshCheckout.mirror.eventAt ?? null) === null
);
const lifetime = decideStripeEvent(checkout("lifetime", T1), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T2) }));
check("Lifetime is never gated by the subscription clock", lifetime.mirror?.type === "lifetime");

if (failures > 0) process.exit(1);
console.log("\nAll ordering checks passed.");
process.exit(0);
