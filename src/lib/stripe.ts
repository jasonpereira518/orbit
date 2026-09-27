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

export {
  LIFETIME_PRICE_ID,
  PRO_MONTHLY_PRICE_ID,
  PRO_ANNUAL_PRICE_ID,
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
  PRO_BILLING_PERIOD_METADATA_KEY,
  isStripeConfigured,
  isProCheckoutConfigured,
} from "@/lib/stripe-config";

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
