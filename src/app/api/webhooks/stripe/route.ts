import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { decideStripeEvent } from "@/lib/billing-stripe";
import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";
import {
  applyStripeDecision,
  isStripeEventProcessed,
  markStripeEventProcessed,
  readDecideContext,
} from "@/lib/stripe-fulfilment";
import { WEBHOOK_REASONS, recordWebhookDelivery } from "@/lib/webhook-deliveries";
import { reportError } from "@/lib/report-error";

/**
 * (Existing header comment from lines 29–51 of 33a213c, unchanged, then:)
 *
 * DEDUPE, ORDER AND RETRIES. A delivery whose event id is already in
 * `stripe_processed_events` answers 200 and touches nothing. Only `handled` events are
 * recorded there, so an event ignored for a reason that can change is re-evaluated on
 * retry. Reading context and applying the decision live in `@/lib/stripe-fulfilment`,
 * which books before it mirrors: see that module for why a retry can never lose a row.
 */

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
    if (await isStripeEventProcessed(event.id)) {
      await recordWebhookDelivery({
        source: "stripe",
        eventId: event.id,
        eventType: event.type,
        outcome: "ignored",
        reason: WEBHOOK_REASONS.duplicateEvent,
        durationMs: Date.now() - startedAt,
      });
      return new Response("OK", { status: 200 });
    }

    const ctx = await readDecideContext(event, new Date());
    const decision = decideStripeEvent(event, ctx);
    await applyStripeDecision(decision);
    if (decision.outcome === "handled") {
      await markStripeEventProcessed(event.id, event.type);
    }

    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(
        `Stripe ${event.type} (${event.id}) could not be attributed to a user.`
      );
      // Logs expire in an hour; this row is what the ops sweep reads. Ids only — no amounts,
      // emails or names from the payload. Not throttled: each one is a real incident.
      await recordErrorEvent({
        source: ERROR_SOURCES.stripeUnattributed,
        kind: event.type,
        context: { eventId: event.id, resourceId: decision.resourceId },
      });
    }

    // Kept from Phase 0: /admin/health reads this to show when access was withdrawn.
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
    // Non-2xx so Stripe retries. Bookings are written before the mirror and are keyed, so the
    // retry derives the same rows and the unique index drops the ones that already landed.
    return new Response("Handler failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
