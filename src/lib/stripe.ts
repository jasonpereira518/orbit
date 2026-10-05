import Stripe from "stripe";

/**
 * Stripe sells the two subscription tiers (Orbit Pro and Orbit Max, monthly) and the $5
 * credit pack. Orbit Lifetime is no longer sold — admins grant it — but purchases made
 * before pricing v2 still exist and can still be refunded, so the webhook keeps handling them.
 *
 * Entitlements are never read from Stripe. The webhook mirrors a completed purchase into
 * the `subscription_*` columns (or `lifetime_purchased_at`, for legacy Lifetime), and
 * `src/lib/entitlements.ts` resolves from the database alone — so request and background
 * code agree, and there is one source of truth.
 *
 * Server-only, though not via the `server-only` package: that throws under plain Node and
 * would break the `scripts/smoke-*.ts` convention, which imports these modules directly.
 * Importing this into a client component fails the build anyway, because the Stripe SDK
 * pulls in Node built-ins the browser chunker cannot resolve.
 */

export * from "@/lib/stripe-config";

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
      "STRIPE_SECRET_KEY is not set. Add it before enabling checkout."
    );
  }
  client ??= new Stripe(key);
  return client;
}
