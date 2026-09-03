import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import {
  findUserIdByStripeCustomerId,
  setLifetimePurchase,
  setSubscriptionState,
} from "@/lib/user-settings";
import {
  hasPriorRevenue,
  monthlyValueCents,
  recordBillingEvent,
} from "@/lib/billing-events";
import {
  decideStripeEvent,
  stripeEventSubject,
  type DecideContext,
} from "@/lib/billing-stripe";
import {
  WEBHOOK_REASONS,
  recordWebhookDelivery,
} from "@/lib/webhook-deliveries";

/**
 * Fulfils Stripe purchases: the one-time Orbit Lifetime tier and the recurring Orbit Pro
 * subscription, and records what each event meant financially.
 *
 * Webhooks — not the success page — are what actually grant the plan. A customer can pay
 * and then lose their connection before any redirect loads, so the redirect is a
 * convenience and this endpoint is the guarantee.
 *
 * THIS FILE IS A DRIVER, NOT A DECISION. What each event means lives in
 * `@/lib/billing-stripe`, as a pure function of (event, context). That split exists
 * because the old shape — read the mirror, write it, read it back to see what changed —
 * could only ever run inside a live request against a live database, which made it both
 * untestable in isolation and impossible for a backfill to replay. The backfill now shares
 * this exact logic rather than reimplementing it and drifting.
 *
 * MUST ALSO BE ENABLED IN THE STRIPE DASHBOARD — handling an event type in code is not
 * enough, and a type that is handled here but not subscribed there simply never arrives:
 *
 *   checkout.session.completed          checkout.session.async_payment_succeeded
 *   customer.subscription.created       customer.subscription.updated
 *   customer.subscription.deleted       invoice.paid
 *   invoice.payment_failed              charge.refunded
 *   charge.dispute.created              charge.dispute.closed
 */

/**
 * Resolve the event to an account.
 *
 * The only step that needs the database, which is why it is here and not in the pure
 * module: `client_reference_id` and subscription metadata cover our own checkout flow, and
 * the customer-id lookup covers everything created in the Stripe dashboard instead.
 */
async function attribute(event: Stripe.Event): Promise<string | null> {
  const { userIdHint, customerId } = stripeEventSubject(event);
  if (userIdHint) return userIdHint;
  if (!customerId) return null;
  return findUserIdByStripeCustomerId(customerId);
}

/**
 * The recurring value of this account immediately before the event.
 *
 * Read once, before anything is written — the only moment both sides of a transition are
 * knowable, since applying the mirror overwrites the "before".
 */
async function readBeforeCents(userId: string, now: Date): Promise<number> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionPeriodEnd: true,
      subscriptionMonthlyCents: true,
    },
  });
  if (row?.subscriptionPlan !== "orbit") return 0;
  return monthlyValueCents(
    row.subscriptionStatus,
    row.subscriptionPeriodEnd,
    now,
    row.subscriptionMonthlyCents
  );
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing webhook.");
    return new Response("Stripe webhook is not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // Signature verification needs the exact bytes Stripe signed. Reading this as JSON and
  // re-serialising would change the payload and silently fail every signature, so the raw
  // text is read first and parsed only by the SDK.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    // Includes replay attempts and stale secrets after a roll — both should be rejected.
    console.error("Stripe webhook verification failed:", err);
    // Recorded even though nothing can be trusted about the body: a burst of these is how
    // a rolled secret announces itself, and it is invisible if only valid events are logged.
    await recordWebhookDelivery({
      source: "stripe",
      outcome: "invalid",
      reason: WEBHOOK_REASONS.signatureInvalid,
      error: err,
      durationMs: Date.now() - startedAt,
    });
    return new Response("Verification failed", { status: 400 });
  }

  try {
    const now = new Date();
    const userId = await attribute(event);
    const beforeCents = userId ? await readBeforeCents(userId, now) : 0;
    const ctx: DecideContext = {
      userId,
      beforeCents,
      // Only consulted when there is nothing to lose by asking: a 0-to-positive move is
      // the sole case where new and reactivation differ.
      hadPriorRevenue:
        userId && beforeCents === 0 ? await hasPriorRevenue(userId) : false,
      now,
    };

    const decision = decideStripeEvent(event, ctx);

    if (decision.mirror?.type === "lifetime") {
      // Idempotent by design: Stripe retries for up to three days, and both fulfil event
      // types fire for the same session. `setLifetimePurchase` keeps the first timestamp.
      await setLifetimePurchase(decision.mirror.userId, {
        stripeCustomerId: decision.mirror.stripeCustomerId,
      });
    } else if (decision.mirror?.type === "subscription") {
      await setSubscriptionState(
        decision.mirror.userId,
        {
          plan: decision.mirror.plan,
          status: decision.mirror.status,
          periodEnd: decision.mirror.periodEnd,
          monthlyCents: decision.mirror.monthlyCents,
          interval: decision.mirror.interval,
        },
        { stripeCustomerId: decision.mirror.stripeCustomerId }
      );
    }

    for (const booking of decision.bookings) {
      await recordBillingEvent({ source: "stripe", ...booking });
    }

    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(
        `Stripe ${event.type} (${event.id}) could not be attributed to a user.`
      );
    }

    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: decision.outcome,
      reason: decision.reason ?? null,
      targetUserId: decision.targetUserId,
      resourceId: decision.resourceId,
      detail: { bookings: decision.bookings.length },
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.id}:`, err);
    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: "error",
      reason: WEBHOOK_REASONS.handlerThrew,
      error: err,
      durationMs: Date.now() - startedAt,
    });
    // Non-2xx so Stripe retries. The bookings that did land are keyed idempotently, so a
    // retry re-applies the rest without duplicating what already succeeded.
    return new Response("Handler failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
