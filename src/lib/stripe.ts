import Stripe from "stripe";

/**
 * Stripe sells the one-time Orbit Lifetime tier. The recurring Orbit Pro plan is sold by
 * Clerk Billing instead — Clerk's plans are `month | annual` only and cannot express a
 * one-time purchase, which is why this second payment path exists at all.
 *
 * Entitlements are never read from Stripe. The webhook mirrors a completed purchase into
 * `user_settings.lifetime_purchased_at`, and `src/lib/entitlements.ts` resolves from the
 * database alone — so request and background code agree, and there is one source of truth.
 *
 * Server-only, though not via the `server-only` package: that throws under plain Node and
 * would break the `scripts/smoke-*.ts` convention, which imports these modules directly.
 * Importing this into a client component fails the build anyway, because the Stripe SDK
 * pulls in Node built-ins the browser chunker cannot resolve.
 */

/** Price id of the one-time Lifetime product, copied from the Stripe dashboard. */
export const LIFETIME_PRICE_ID = process.env.STRIPE_LIFETIME_PRICE_ID || null;

/**
 * Marks a Checkout Session as belonging to this tier. The webhook checks it before
 * granting anything, so adding a second Stripe product later cannot silently hand out
 * Lifetime.
 */
export const LIFETIME_METADATA_KEY = "orbit_plan";
export const LIFETIME_METADATA_VALUE = "lifetime";

/**
 * True only when Stripe can actually take a payment. Everything user-facing checks this
 * first, so a deployment without Stripe keys shows the "not on sale yet" state rather
 * than a button that fails on click.
 */
export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && LIFETIME_PRICE_ID);
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
