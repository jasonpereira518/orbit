/**
 * A full refund (or lost dispute) of a subscription charge stays revoked: no later-arriving
 * subscription webhook puts the account back on a paid plan.
 *
 * Two ways back in used to exist, both closed in src/lib/billing-stripe.ts and
 * src/lib/stripe-fulfilment.ts:
 *
 *  1. Watermark. The `subscription_revoked` mirror now carries the refund event's `created` as
 *     `eventAt`, so `user_settings.subscription_event_at` advances on revocation and a delayed
 *     `customer.subscription.updated` created BEFORE the refund is ignored as stale by
 *     `isStaleSubscriptionEvent` instead of re-granting Pro.
 *  2. Period end. A cancellation (`deleted`, or an `updated` with status canceled) applied to a
 *     mirror that is already canceled never extends `subscription_period_end`
 *     (`currentSubscriptionPeriodEnd` in the decide context). A `deleted` genuinely newer than
 *     the refund — the ordinary "refund, then cancel" support flow — therefore keeps the
 *     revocation's period end of "now" rather than Stripe's future `current_period_end`.
 *     A normal, unrefunded cancel still keeps access to the period end: there the mirror's
 *     period end already equals Stripe's.
 *
 * The refund is decided with `chargePurpose: "subscription"` supplied directly — the only
 * part of `readDecideContext` that would call the Stripe API — and applied with the real
 * `applyStripeDecision`. Every subscription event goes through the real `processStripeEvent`.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-stripe-revocation-regrant.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { stripeProcessedEvents, userSettings } from "../src/db/schema";
import { decideStripeEvent } from "../src/lib/billing-stripe";
import { resolvePlan } from "../src/lib/entitlements";
import { LIFETIME_METADATA_KEY, PRO_METADATA_VALUE, SUBSCRIPTION_USER_METADATA_KEY } from "../src/lib/stripe-config";
import { processStripeEvent } from "../src/lib/stripe-event-processor";
import { applyStripeDecision } from "../src/lib/stripe-fulfilment";
import { checker } from "./smoke/check";
import { fakeUserId, purgeUsers } from "./smoke/factories";

const t = checker();
const NOW = new Date();
const NOW_S = Math.floor(NOW.getTime() / 1000);
const HOUR = 3600;
const PERIOD_END = NOW_S + 20 * 86_400;
const eventIds: string[] = [];

function subEvent(user: string, type: string, created: number, status: string): Stripe.Event {
  const id = `evt_${user}_${type}_${created}`;
  eventIds.push(id);
  return {
    id,
    object: "event",
    type,
    created,
    data: {
      object: {
        id: `sub_${user}`,
        object: "subscription",
        status,
        customer: `cus_${user}`,
        metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [SUBSCRIPTION_USER_METADATA_KEY]: user },
        items: {
          data: [{
            id: "si_1",
            quantity: 1,
            current_period_start: PERIOD_END - 30 * 86_400,
            current_period_end: PERIOD_END,
            price: { unit_amount: 500, recurring: { interval: "month", interval_count: 1 } },
          }],
        },
      },
    },
  } as unknown as Stripe.Event;
}

function refundEvent(user: string, created: number): Stripe.Event {
  const id = `evt_${user}_refund_${created}`;
  eventIds.push(id);
  return {
    id,
    object: "event",
    type: "charge.refunded",
    created,
    data: {
      object: {
        id: `ch_${user}`,
        object: "charge",
        customer: `cus_${user}`,
        payment_intent: `pi_${user}`,
        currency: "usd",
        amount_captured: 500,
        amount_refunded: 500,
        refunded: true,
        refunds: { object: "list", data: [{ id: `re_${user}`, object: "refund", amount: 500, created }] },
      },
    },
  } as unknown as Stripe.Event;
}

const process_ = (event: Stripe.Event) =>
  processStripeEvent(event, { now: NOW, updateSubscription: async () => ({}) });

async function settingsOf(user: string) {
  const db = await getDb();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, user));
  return row;
}

/** What the webhook does for a full refund of a subscription charge, minus the Stripe lookup. */
async function applyRefund(user: string, created: number) {
  const row = await settingsOf(user);
  const decision = decideStripeEvent(refundEvent(user, created), {
    userId: user,
    beforeCents: 500,
    hadPriorRevenue: true,
    now: new Date(created * 1000),
    chargePurpose: "subscription",
    lastSubscriptionEventAt: row?.subscriptionEventAt ?? null,
    currentSubscriptionStatus: row?.subscriptionStatus ?? null,
  });
  await applyStripeDecision(decision);
  return decision;
}

run(async () => {
  const db = await getDb();
  const A = fakeUserId("revoke-watermark");
  const B = fakeUserId("revoke-deleted");
  const C = fakeUserId("revoke-guard");
  await purgeUsers(db, [A, B, C]);

  try {
    console.log("\n1. A delayed `updated` created before the refund stays stale...");
    await process_(subEvent(A, "customer.subscription.updated", NOW_S - 3 * HOUR, "active"));
    t.check("setup: the subscriber is on Pro", resolvePlan(await settingsOf(A), NOW).plan === "orbit");
    const revoke = await applyRefund(A, NOW_S - 1 * HOUR);
    t.check("the full refund decides subscription_revoked", revoke.mirror?.type === "subscription_revoked", JSON.stringify(revoke.mirror));
    t.check("…and drops the account to Free", resolvePlan(await settingsOf(A), NOW).plan === "free");
    const delayed = await process_(subEvent(A, "customer.subscription.updated", NOW_S - 2 * HOUR, "active"));
    const outcome = delayed.duplicate ? "duplicate" : `${delayed.decision.outcome}/${delayed.decision.reason ?? ""}`;
    const afterA = await settingsOf(A);
    t.check(
      "an `updated` created before a refund but delivered after it is ignored (revocation advances subscription_event_at)",
      resolvePlan(afterA, NOW).plan === "free",
      `plan=${resolvePlan(afterA, NOW).plan}, status=${afterA?.subscriptionStatus}, decision=${outcome}, watermark=${afterA?.subscriptionEventAt?.toISOString()}`
    );

    console.log("\n2. A newer `deleted` after the refund keeps the account on Free...");
    await process_(subEvent(B, "customer.subscription.updated", NOW_S - 3 * HOUR, "active"));
    await applyRefund(B, NOW_S - 2 * HOUR);
    t.check("setup: the refund drops the account to Free", resolvePlan(await settingsOf(B), NOW).plan === "free");
    await process_(subEvent(B, "customer.subscription.deleted", NOW_S - 1 * HOUR, "canceled"));
    const afterB = await settingsOf(B);
    t.check(
      "a `customer.subscription.deleted` after a full refund does not restore access to the refunded period",
      resolvePlan(afterB, NOW).plan === "free",
      `plan=${resolvePlan(afterB, NOW).plan}, status=${afterB?.subscriptionStatus}, period_end=${afterB?.subscriptionPeriodEnd?.toISOString()}`
    );

    console.log("\nThe existing ordering guard, for contrast...");
    await process_(subEvent(C, "customer.subscription.updated", NOW_S - 3 * HOUR, "active"));
    await process_(subEvent(C, "customer.subscription.deleted", NOW_S - 1 * HOUR, "canceled"));
    const staleC = await process_(subEvent(C, "customer.subscription.updated", NOW_S - 2 * HOUR, "active"));
    t.check(
      "an `updated` older than an applied `deleted` is ignored as stale",
      !staleC.duplicate && staleC.decision.reason === "stale_subscription_event",
      JSON.stringify(staleC)
    );
    t.check("…and the mirror stays canceled", (await settingsOf(C))?.subscriptionStatus === "canceled");
  } finally {
    await purgeUsers(db, [A, B, C]);
    for (const id of eventIds) await db.delete(stripeProcessedEvents).where(eq(stripeProcessedEvents.eventId, id));
  }

  t.done("stripe revocation re-grant");
});
