/**
 * The Stripe settings that need no SDK: price ids, metadata keys, and whether each tier is on
 * sale. Split out of `stripe.ts` (which re-exports all of it) so the pricing and upgrade pages
 * can ask "is checkout configured?" without loading the Stripe SDK on every render.
 */

/** Price id of the one-time Lifetime product, copied from the Stripe dashboard. */
export const LIFETIME_PRICE_ID = process.env.STRIPE_LIFETIME_PRICE_ID || null;

/** Price ids of the recurring Orbit Pro prices, copied from the Stripe dashboard. */
export const PRO_MONTHLY_PRICE_ID =
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID || null;
export const PRO_ANNUAL_PRICE_ID =
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID || null;

/**
 * Marks a Checkout Session as belonging to one tier. The webhook checks it before
 * granting anything, so adding another Stripe product later cannot silently hand out
 * a plan.
 */
export const LIFETIME_METADATA_KEY = "orbit_plan";
export const LIFETIME_METADATA_VALUE = "lifetime";
export const PRO_METADATA_VALUE = "orbit";

/**
 * Subscription-level metadata key carrying the Clerk user id. `client_reference_id`
 * exists only on the Checkout Session, but every later `customer.subscription.*` event
 * carries the subscription's own metadata — so renewals and cancellations map back to a
 * user without a database lookup.
 */
export const SUBSCRIPTION_USER_METADATA_KEY = "orbit_user_id";

/**
 * Which cadence a Pro checkout was for, carried on the session and the subscription.
 *
 * The webhook grants the plan optimistically the moment checkout completes, before any
 * subscription object exists to read a price off. Without this it has to assume monthly —
 * and once the ledger knows annual is worth $4.17/mo, that assumption books a spurious
 * -83 contraction on every annual signup when the real subscription event arrives.
 */
export const PRO_BILLING_PERIOD_METADATA_KEY = "orbit_billing_period";

/**
 * True only when Stripe can actually take a payment. Everything user-facing checks this
 * first, so a deployment without Stripe keys shows the "not on sale yet" state rather
 * than a button that fails on click.
 *
 * Gates Lifetime only; Pro checkout has its own gate below so the two tiers can go on
 * sale independently.
 */
export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && LIFETIME_PRICE_ID);
}

/** Same contract as `isStripeConfigured`, for the Orbit Pro subscription. */
export function isProCheckoutConfigured() {
  return Boolean(
    process.env.STRIPE_SECRET_KEY && PRO_MONTHLY_PRICE_ID && PRO_ANNUAL_PRICE_ID
  );
}
