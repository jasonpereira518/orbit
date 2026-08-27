import Stripe from "stripe";

/**
 * Stripe sells both paid tiers: the one-time Orbit Lifetime purchase and the recurring
 * Orbit Pro subscription. (Pro was originally architected on Clerk Billing; no Clerk
 * subscription was ever sold, and its webhook mirror in `api/webhooks/clerk` is legacy.)
 *
 * Entitlements are never read from Stripe. The webhook mirrors a completed purchase into
 * `user_settings.lifetime_purchased_at` (Lifetime) or the `subscription_*` columns (Pro),
 * and `src/lib/entitlements.ts` resolves from the database alone — so request and
 * background code agree, and there is one source of truth.
 *
 * Server-only, though not via the `server-only` package: that throws under plain Node and
 * would break the `scripts/smoke-*.ts` convention, which imports these modules directly.
 * Importing this into a client component fails the build anyway, because the Stripe SDK
 * pulls in Node built-ins the browser chunker cannot resolve.
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

let client: Stripe | null = null;

/**
 * Lazily constructed so importing this module never throws at build time — the pricing
 * page renders fine on a deployment that has no Stripe keys yet.
 *
 * `apiVersion` is deliberately not pinned here: the SDK pins its own, and hardcoding a
 * version string means a mismatch every time the package is upgraded.
 */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it before enabling Lifetime checkout."
    );
  }
  client ??= new Stripe(key);
  return client;
}
