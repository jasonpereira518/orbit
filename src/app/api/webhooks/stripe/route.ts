import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  getStripe,
} from "@/lib/stripe";
import { setLifetimePurchase } from "@/lib/user-settings";
import { recordOperationalEvent } from "@/lib/operational-events";

/**
 * Fulfils a completed Orbit Lifetime purchase.
 *
 * Webhooks — not the success page — are what actually grant the plan. A customer can pay
 * and then lose their connection before any redirect loads, so the redirect is a
 * convenience and this endpoint is the guarantee.
 */

/** `checkout.session.completed` fires for instant methods; the async variant covers
 *  delayed ones (bank debits), where funds land after the session closes. */
const FULFIL_EVENTS = new Set<Stripe.Event["type"]>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** `customer` arrives as an id, an expanded object, or null depending on the session. */
function customerIdOf(session: Stripe.Checkout.Session) {
  const customer = session.customer;
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing webhook.");
    await recordOperationalEvent({
      severity: "error",
      source: "webhook",
      eventType: "webhook.stripe.not_configured",
      message: "Stripe webhook delivery arrived while the signing secret was unavailable.",
      success: false,
      dedupeKey: "stripe:webhook:not-configured",
    });
    return new Response("Stripe webhook is not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    await recordOperationalEvent({
      severity: "warn",
      source: "webhook",
      eventType: "webhook.stripe.missing_signature",
      message: "Stripe webhook delivery did not include a signature.",
      success: false,
    });
    return new Response("Missing signature", { status: 400 });
  }

  // Signature verification needs the exact bytes Stripe signed. Reading this as JSON and
  // re-serialising would change the payload and silently fail every signature, so the raw
  // text is read first and parsed only by the SDK.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch {
    // Includes replay attempts and stale secrets after a roll — both should be rejected.
    console.error("Stripe webhook verification failed.");
    await recordOperationalEvent({
      severity: "warn",
      source: "webhook",
      eventType: "webhook.stripe.verification_failed",
      message: "Stripe rejected a webhook signature.",
      success: false,
    });
    return new Response("Verification failed", { status: 400 });
  }

  let journalUserId: string | null = null;
  try {
  if (FULFIL_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;

    // Ignore sessions for any other product, so a second Stripe price added later cannot
    // grant Lifetime by accident.
    const isLifetime =
      session.metadata?.[LIFETIME_METADATA_KEY] === LIFETIME_METADATA_VALUE;
    const userId = session.client_reference_id;
    journalUserId = userId;

    // `unpaid` covers sessions that completed without funds actually settling.
    if (isLifetime && userId && session.payment_status !== "unpaid") {
      // Idempotent by design: Stripe retries for up to three days, and both event types
      // above can fire for the same session. `setLifetimePurchase` keeps the first
      // purchase timestamp and ignores repeats.
      await setLifetimePurchase(userId, {
        stripeCustomerId: customerIdOf(session),
        eventKey: `stripe:${session.id}`,
      });
    }
  }
  } catch {
    await recordOperationalEvent({
      severity: "error",
      source: "webhook",
      eventType: `webhook.stripe.${event.type}`,
      message: "Stripe webhook processing failed.",
      success: false,
      userId: journalUserId,
      correlationId: event.id,
      dedupeKey: `stripe:${event.id}:failed`,
    });
    return new Response("Processing failed", { status: 500 });
  }

  await recordOperationalEvent({
    severity: "info",
    source: "webhook",
    eventType: `webhook.stripe.${event.type}`,
    message: "Stripe webhook processed.",
    success: true,
    userId: journalUserId,
    correlationId: event.id,
    dedupeKey: `stripe:${event.id}:processed`,
    metadata: { relevant: FULFIL_EVENTS.has(event.type) },
  });

  return new Response("OK", { status: 200 });
}
