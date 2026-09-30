import type Stripe from "stripe";
import { decideStripeEvent, type StripeDecision } from "@/lib/billing-stripe";
import { reconcileFoundingDiscount } from "@/lib/founding";
import {
  applyStripeDecision,
  isStripeEventProcessed,
  markStripeEventProcessed,
  readDecideContext,
} from "@/lib/stripe-fulfilment";

/**
 * One verified Stripe event, end to end: dedupe, decide, book and mirror, then the founding
 * discount reconcile, then mark it processed. The webhook route wraps this with signature
 * checks and delivery logging; `smoke-stripe-testclock` drives it with real sandbox events
 * and a test clock's time, so both run exactly the same path.
 *
 * `now` is the moment the event is judged at — wall time in production, the test clock's
 * frozen time in the smoke.
 */
export async function processStripeEvent(
  event: Stripe.Event,
  deps: {
    now?: Date;
    updateSubscription: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<unknown>;
  }
): Promise<{ duplicate: true } | { duplicate: false; decision: StripeDecision }> {
  if (await isStripeEventProcessed(event.id)) return { duplicate: true };
  const now = deps.now ?? new Date();

  const ctx = await readDecideContext(event, now);
  const decision = decideStripeEvent(event, ctx);
  await applyStripeDecision(decision);
  // Founding pricing: stamp the window end on a new founding subscription, and carry the
  // discount across a Pro <-> Max switch. Best effort and idempotent; never throws.
  if (
    decision.outcome === "handled" &&
    (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated")
  ) {
    await reconcileFoundingDiscount(event.data.object as Stripe.Subscription, deps.updateSubscription, now);
  }
  if (decision.outcome === "handled") {
    await markStripeEventProcessed(event.id, event.type);
  }
  return { duplicate: false, decision };
}
