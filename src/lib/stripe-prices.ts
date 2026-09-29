import type Stripe from "stripe";
import { PRICE_LOOKUP_KEYS } from "@/lib/stripe-config";
import { getStripe } from "@/lib/stripe";

/**
 * The live price ids for pricing v2, resolved by lookup key and cached per server instance.
 *
 * One `prices.list` call answers all three. The cache holds for the life of the instance —
 * prices are immutable, and a new one gets a new lookup key — but a failed or partial answer
 * is never cached, so a deploy that races the setup script heals on the next call.
 */
export type PriceIds = { orbit: string; max: string; creditPack: string };

let cached: PriceIds | null = null;

export async function resolvePriceIds(stripe: Stripe = getStripe()): Promise<PriceIds> {
  if (cached) return cached;
  const keys = Object.values(PRICE_LOOKUP_KEYS);
  const { data } = await stripe.prices.list({ lookup_keys: keys, active: true, limit: keys.length });
  const byKey = new Map(data.map((price) => [price.lookup_key, price.id]));
  const ids = {
    orbit: byKey.get(PRICE_LOOKUP_KEYS.orbit),
    max: byKey.get(PRICE_LOOKUP_KEYS.max),
    creditPack: byKey.get(PRICE_LOOKUP_KEYS.creditPack),
  };
  if (!ids.orbit || !ids.max || !ids.creditPack) {
    const missing = Object.entries(ids)
      .filter(([, id]) => !id)
      .map(([name]) => name);
    throw new Error(
      `Stripe has no active price for ${missing.join(", ")}. Run scripts/stripe-pricing-v2.ts for this mode.`
    );
  }
  cached = ids as PriceIds;
  return cached;
}

/** For tests: forget the cached ids. */
export function resetPriceIdCache() {
  cached = null;
}

/**
 * The customer-portal configuration `scripts/stripe-pricing-v2.ts` creates (tagged
 * `orbit_config=pricing_v2`): Pro ↔ Max switching, downgrades at period end. Undefined when
 * it has not been created in this mode, which falls back to the account's default portal.
 */
let portalConfig: string | null | undefined;

export async function resolvePortalConfigurationId(
  stripe: Stripe = getStripe()
): Promise<string | undefined> {
  if (portalConfig !== undefined) return portalConfig ?? undefined;
  for await (const configuration of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (configuration.metadata?.orbit_config === "pricing_v2") {
      portalConfig = configuration.id;
      return portalConfig;
    }
  }
  // Not cached when missing: the setup script may run after this instance started.
  return undefined;
}
