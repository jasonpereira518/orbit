/**
 * The Stripe settings that need no SDK: lookup keys, coupon ids and metadata keys. Split out
 * of `stripe.ts` (which re-exports all of it) so the pricing and upgrade pages can ask "is
 * checkout configured?" without loading the Stripe SDK on every render.
 *
 * PRICING V2. Prices are found by LOOKUP KEY at runtime (`src/lib/stripe-prices.ts`), not by
 * env var: `scripts/stripe-pricing-v2.ts` creates them with these keys in each mode, so a
 * deploy never waits on someone pasting a price id into Vercel — and a missing price id is
 * exactly the kind of gap the production env gate turns into a blocked deploy.
 */

export const PRICE_LOOKUP_KEYS = {
  orbit: "orbit_pro_monthly_v2",
  max: "orbit_max_monthly_v2",
  orbitAnnual: "orbit_pro_annual_v2",
  maxAnnual: "orbit_max_annual_v2",
  creditPack: "orbit_credit_pack_250",
} as const;

/** The lookup key that sells `plan` billed `period`. */
export function subscriptionLookupKey(plan: "orbit" | "max", period: "monthly" | "annual"): string {
  if (plan === "max") return period === "annual" ? PRICE_LOOKUP_KEYS.maxAnnual : PRICE_LOOKUP_KEYS.max;
  return period === "annual" ? PRICE_LOOKUP_KEYS.orbitAnnual : PRICE_LOOKUP_KEYS.orbit;
}

/** Credits in one $5 pack. */
export const CREDIT_PACK_CREDITS = 250;
export const CREDIT_PACK_PRICE_CENTS = 500;

/**
 * Founding coupons: `orbit-founding-<tier>-<n>m`, $2 off Pro or $4 off Max for n whole
 * months. Three lengths per tier because a repeating coupon's clock restarts when applied:
 * a tier switch inside the window swaps to the coupon for the months that remain.
 */
export const FOUNDING_MONTHS = 3;
export const FOUNDING_AMOUNT_OFF_CENTS = { orbit: 200, max: 400 } as const;
export function foundingCouponId(tier: "orbit" | "max", months: number): string {
  return `orbit-founding-${tier === "orbit" ? "pro" : "max"}-${months}m`;
}

/**
 * Marks a Checkout Session (and the subscription it creates) with what was bought. The
 * webhook checks it before granting anything, so adding another Stripe product later cannot
 * silently hand out a plan. Values: `orbit` (Pro), `max`, `credit_pack`, and the legacy
 * `lifetime`, which is no longer sold but whose old purchases can still be refunded.
 */
export const LIFETIME_METADATA_KEY = "orbit_plan";
export const PLAN_METADATA_KEY = LIFETIME_METADATA_KEY;
export const LIFETIME_METADATA_VALUE = "lifetime";
export const PRO_METADATA_VALUE = "orbit";
export const MAX_METADATA_VALUE = "max";
export const CREDIT_PACK_METADATA_VALUE = "credit_pack";

/**
 * Subscription-level metadata key carrying the Clerk user id. `client_reference_id`
 * exists only on the Checkout Session, but every later `customer.subscription.*` event
 * carries the subscription's own metadata — so renewals and cancellations map back to a
 * user without a database lookup.
 */
export const SUBSCRIPTION_USER_METADATA_KEY = "orbit_user_id";

/**
 * Which cadence a LEGACY ($5/$50) Pro checkout was for. Still read so an old annual session
 * replayed by the backfill books its real value — and its presence is what marks a session
 * as legacy, which is why pricing v2 does not reuse it.
 */
export const PRO_BILLING_PERIOD_METADATA_KEY = "orbit_billing_period";

/**
 * The billing period of a pricing-v2 subscription checkout: `month` or `year`. A separate key
 * from the legacy one above, so a v2 annual session is never mistaken for a $50 one.
 */
export const INTERVAL_METADATA_KEY = "orbit_interval";

/**
 * Founding pricing, carried on the subscription's metadata so the PURE webhook decision can
 * value the subscription correctly (webhook payloads never expand `discounts`):
 *  - `orbit_founding_off`: cents off per month while the window is open
 *  - `orbit_founding_until`: epoch seconds the window closes (start + 3 months)
 * Written at checkout (off) and on the first subscription event (until), and rewritten when a
 * tier switch swaps the coupon.
 */
export const FOUNDING_OFF_METADATA_KEY = "orbit_founding_off";
export const FOUNDING_UNTIL_METADATA_KEY = "orbit_founding_until";
export const FOUNDING_TIER_METADATA_KEY = "orbit_founding_tier";

/**
 * True only when Stripe can take a payment. Everything user-facing checks this first, so a
 * deployment without Stripe keys shows the "not on sale yet" state rather than a button that
 * fails on click. Prices themselves are resolved by lookup key on first use.
 */
export function isCheckoutConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Which tier a subscription price sells, from its lookup key. Pure, so the webhook decision
 * can read it off the price embedded in every subscription payload. A price with no v2 key
 * is a legacy Orbit Pro price ($5/month or $50/year): those subscribers keep their price and
 * get the Pro plan.
 */
export function planForLookupKey(lookupKey: string | null | undefined): "orbit" | "max" {
  return lookupKey === PRICE_LOOKUP_KEYS.max || lookupKey === PRICE_LOOKUP_KEYS.maxAnnual ? "max" : "orbit";
}
