import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import {
  findUserIdByStripeCustomerId,
  revokeLifetimePurchase,
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
  revocationPaymentIntent,
  stripeEventSubject,
  type DecideContext,
} from "@/lib/billing-stripe";
import { resolveChargePurpose } from "@/lib/stripe-charge-purpose";
import { shouldRecordThrottled } from "@/lib/error-events";
import {
  WEBHOOK_REASONS,
  recordWebhookDelivery,
} from "@/lib/webhook-deliveries";
import { reportError } from "@/lib/report-error";

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
    // Recorded (once per hour, since this precedes authentication) so a rolled secret shows
    // up in the ledger the ops sweep reads. Stores nothing from the body.
    if (shouldRecordThrottled("webhook.stripe.invalid")) {
      await recordWebhookDelivery({
        source: "stripe",
        outcome: "invalid",
        reason: WEBHOOK_REASONS.signatureInvalid,
        error: err,
        durationMs: Date.now() - startedAt,
      });
    }
    return new Response("Verification failed", { status: 400 });
  }

  try {
    const now = new Date();
    const userId = await attribute(event);
    const beforeCents = userId ? await readBeforeCents(userId, now) : 0;
    // Only a full refund or a lost dispute can withdraw access, and only those need to know
    // what the charge paid for — so the lookup (ledger first, then Stripe) runs for nothing
    // else. A lookup that throws lands in the catch below: 500, and Stripe retries.
    const revocationPi = userId ? revocationPaymentIntent(event) : null;
    const chargePurpose = revocationPi
      ? await resolveChargePurpose(revocationPi)
      : undefined;
    const ctx: DecideContext = {
      userId,
      beforeCents,
      // Only consulted when there is nothing to lose by asking: a 0-to-positive move is
      // the sole case where new and reactivation differ.
      hadPriorRevenue:
        userId && beforeCents === 0 ? await hasPriorRevenue(userId) : false,
      now,
      chargePurpose,
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
    } else if (decision.mirror?.type === "lifetime_revoked") {
      await revokeLifetimePurchase(decision.mirror.userId);
    } else if (decision.mirror?.type === "subscription_revoked") {
      // monthlyCents and interval are omitted, so the stored price stays for display;
      // status canceled + a period end of now is what drops `resolvePlan` to free.
      await setSubscriptionState(decision.mirror.userId, {
        plan: "orbit",
        status: "canceled",
        periodEnd: decision.mirror.periodEnd,
      });
    }

    for (const booking of decision.bookings) {
      await recordBillingEvent({ source: "stripe", ...booking });
    }

    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(
        `Stripe ${event.type} (${event.id}) could not be attributed to a user.`
      );
    }

    const revoked =
      decision.mirror?.type === "lifetime_revoked" ||
      decision.mirror?.type === "subscription_revoked"
        ? decision.mirror.reason
        : null;
    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: decision.outcome,
      reason: decision.reason ?? null,
      targetUserId: decision.targetUserId,
      resourceId: decision.resourceId,
      detail: {
        bookings: decision.bookings.length,
        ...(chargePurpose ? { chargePurpose } : {}),
        ...(revoked ? { revoked } : {}),
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    // Answered 500 so Stripe retries; reported so a handler that keeps failing — a payment
    // nobody's plan reflects — is seen before the three-day retry window runs out.
    reportError(err, { where: "webhook.stripe", extra: { eventId: event.id, eventType: event.type } });
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
