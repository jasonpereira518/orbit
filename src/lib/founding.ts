import type Stripe from "stripe";
import { addMonthsSeconds, foundingTerms, subscriptionShape } from "@/lib/billing-stripe";
import {
  FOUNDING_AMOUNT_OFF_CENTS,
  FOUNDING_MONTHS,
  FOUNDING_OFF_METADATA_KEY,
  FOUNDING_TIER_METADATA_KEY,
  FOUNDING_UNTIL_METADATA_KEY,
  foundingCouponId,
  planForLookupKey,
} from "@/lib/stripe-config";
import type { PurchasablePlan } from "@/lib/plans/plan-config";

/**
 * Founding pricing for beta invitees (pricing v2).
 *
 *  - Eligibility is a stored fact: `user_settings.founding_eligible`, set when an account is
 *    created through a beta invitation. Never inferred later.
 *  - It applies to the account's FIRST paid subscription only (`founding_redeemed_at`).
 *  - It lasts three billing cycles: $2 off Pro, $4 off Max, via Stripe `repeating` coupons.
 *  - A tier switch inside the window keeps the discount for the whole months that remain,
 *    by swapping to the matching coupon (`reconcileFoundingDiscount`).
 *
 * Disclosure rule: founding prices are shown only to eligible signed-in accounts and always
 * with the full terms — no strike-through, no countdown, no scarcity language.
 *
 * No `next/server` and no `@/db`: the webhook route calls this after its own writes.
 */

export type FoundingSettings = {
  foundingEligible?: boolean | null;
  foundingRedeemedAt?: Date | null;
};

/** Whether a new subscription for this account gets the founding coupon. */
export function foundingAppliesToNewSubscription(settings: FoundingSettings | null | undefined): boolean {
  return Boolean(settings?.foundingEligible) && !settings?.foundingRedeemedAt;
}

/** Checkout parameters for a founding subscription: the coupon and the metadata that values it. */
export function foundingCheckoutTerms(plan: PurchasablePlan) {
  const offCents = FOUNDING_AMOUNT_OFF_CENTS[plan];
  return {
    coupon: foundingCouponId(plan, FOUNDING_MONTHS),
    offCents,
    metadata: {
      [FOUNDING_OFF_METADATA_KEY]: String(offCents),
      [FOUNDING_TIER_METADATA_KEY]: plan,
    },
  };
}

/**
 * How many more invoices fall inside the founding window, counting the one at `periodEnd`:
 * every renewal date `periodEnd + k months` that is still before `until`. At most the
 * full window, so a malformed date can never mint a longer discount than was promised.
 */
export function remainingFoundingInvoices(periodEnd: number, until: number): number {
  let count = 0;
  while (count < FOUNDING_MONTHS && addMonthsSeconds(periodEnd, count) < until) count++;
  return count;
}

export type FoundingReconcile =
  | { action: "none"; reason: string }
  | { action: "stamped" }
  | { action: "swapped"; coupon: string | null; tier: PurchasablePlan };

/** What a subscription's founding discount should become — pure, so the smoke can drive it. */
export function planFoundingReconcile(
  sub: Pick<Stripe.Subscription, "metadata" | "status" | "items"> & { start_date?: number },
  nowSeconds: number
): { update: Stripe.SubscriptionUpdateParams | null; result: FoundingReconcile } {
  const terms = foundingTerms(sub.metadata, sub.start_date ?? null);
  if (!terms || terms.until === null) return { update: null, result: { action: "none", reason: "not_founding" } };
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return { update: null, result: { action: "none", reason: "ended" } };
  }

  const metadata: Record<string, string> = {};
  if (!sub.metadata?.[FOUNDING_UNTIL_METADATA_KEY]) {
    metadata[FOUNDING_UNTIL_METADATA_KEY] = String(terms.until);
  }

  const shape = subscriptionShape(sub as Stripe.Subscription);
  const tier = planForLookupKey(shape.lookupKey);
  const discountedTier = sub.metadata?.[FOUNDING_TIER_METADATA_KEY];
  const switched = discountedTier !== tier;
  if (!switched) {
    return Object.keys(metadata).length
      ? { update: { metadata }, result: { action: "stamped" } }
      : { update: null, result: { action: "none", reason: "in_step" } };
  }

  // The tier changed (in the portal or in-app). Carry the discount to the new tier for the
  // invoices still inside the original window, and never past it.
  const remaining =
    nowSeconds < terms.until && shape.periodEnd !== null
      ? remainingFoundingInvoices(shape.periodEnd, terms.until)
      : 0;
  const coupon = remaining > 0 ? foundingCouponId(tier, remaining) : null;
  return {
    update: {
      metadata: {
        ...metadata,
        [FOUNDING_TIER_METADATA_KEY]: tier,
        [FOUNDING_OFF_METADATA_KEY]: String(FOUNDING_AMOUNT_OFF_CENTS[tier]),
      },
      discounts: coupon ? [{ coupon }] : [],
      // A discount swap is not a plan change: nothing to prorate.
      proration_behavior: "none",
    },
    result: { action: "swapped", coupon, tier },
  };
}

/**
 * Bring a founding subscription's coupon in line with its current tier, and stamp its window
 * end. Called by the webhook after every subscription event; idempotent (the update it makes
 * produces an event that finds everything in step). Never throws: the event it follows has
 * already been applied, and failing the webhook would retry that instead.
 */
export async function reconcileFoundingDiscount(
  sub: Stripe.Subscription,
  update: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<unknown>,
  now = new Date()
): Promise<FoundingReconcile> {
  try {
    const plan = planFoundingReconcile(sub, Math.floor(now.getTime() / 1000));
    if (plan.update) await update(sub.id, plan.update);
    return plan.result;
  } catch (err) {
    console.error(`Founding discount reconcile for ${sub.id} did not complete:`, err);
    return { action: "none", reason: "error" };
  }
}
