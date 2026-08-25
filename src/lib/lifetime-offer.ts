import {
  LIFETIME_INTRO_PRICE,
  LIFETIME_INTRO_SEATS,
  LIFETIME_STANDARD_PRICE,
} from "@/lib/plan-limits";
import { countLifetimePurchases } from "@/lib/user-settings";

/**
 * What Orbit Lifetime costs right now.
 *
 * LIFETIME IS NOT SEAT-LIMITED. It is available to everyone, permanently. The first
 * `LIFETIME_INTRO_SEATS` buyers pay the introductory price and it rises to the standard
 * price afterwards — a price change, not a closing door. Copy that implies scarcity of
 * *availability* is wrong, and was wrong once already: the Terms promised a 100-buyer cap
 * for weeks after the product stopped enforcing one.
 *
 * ONE SOURCE FOR BOTH THE DISPLAY AND THE CHARGE. The failure that matters here is not
 * showing a stale number, it is showing one price and charging another — which is how a
 * pricing page becomes a consumer-protection problem rather than a typo. So the Stripe
 * price id is chosen from the same `isIntro` flag the page renders from, and the two
 * cannot drift apart without this function being wrong about both at once.
 *
 * WHEN THE STANDARD PRICE IS NOT CONFIGURED, the offer stays on the intro price rather
 * than advertising a price nothing can charge. Continuing to sell at $25 past the hundredth
 * buyer costs Orbit money; advertising $49 and charging $25 is a different category of
 * problem, and the safe failure is the one that only costs money. `needsStandardPrice`
 * flags it so the operator finds out from the console rather than from a customer.
 */

export type LifetimeOffer = {
  /** Dollars, as a number. Format at the call site. */
  priceUsd: number;
  /** The standard price, for the struck-through comparison. Null while they are equal. */
  compareAtUsd: number | null;
  isIntro: boolean;
  sold: number;
  /** Intro purchases still available at this price. Null once the intro has ended. */
  introRemaining: number | null;
  /**
   * True when the intro is over but no standard Stripe price exists, so buyers are still
   * being charged the intro amount. Surfaced in the admin console, never to a visitor.
   */
  needsStandardPrice: boolean;
  /** The Stripe price object to charge. Null when Stripe is not configured at all. */
  stripePriceId: string | null;
};

const INTRO_PRICE_ID = () => process.env.STRIPE_LIFETIME_PRICE_ID || null;
const STANDARD_PRICE_ID = () =>
  process.env.STRIPE_LIFETIME_STANDARD_PRICE_ID || null;

/** Resolve the offer from a known sale count. Pure, so the smoke test can drive it. */
export function offerForCount(
  sold: number,
  ids: { intro: string | null; standard: string | null } = {
    intro: INTRO_PRICE_ID(),
    standard: STANDARD_PRICE_ID(),
  }
): LifetimeOffer {
  const introExhausted = sold >= LIFETIME_INTRO_SEATS;

  // Past the threshold but with nowhere to charge the higher price: stay on the intro.
  // Advertising a price that cannot be charged is the one outcome to avoid.
  const chargeStandard = introExhausted && Boolean(ids.standard);

  return {
    priceUsd: chargeStandard ? LIFETIME_STANDARD_PRICE : LIFETIME_INTRO_PRICE,
    compareAtUsd: chargeStandard ? null : LIFETIME_STANDARD_PRICE,
    isIntro: !chargeStandard,
    sold,
    introRemaining: introExhausted ? null : Math.max(LIFETIME_INTRO_SEATS - sold, 0),
    needsStandardPrice: introExhausted && !ids.standard,
    stripePriceId: chargeStandard ? ids.standard : ids.intro,
  };
}

/** The live offer. Falls back to the intro price if the count cannot be read. */
/**
 * @param soldCount An already-loaded purchase count, when the caller has one.
 *
 * Both `/admin` and `/admin/billing` render this beside their own
 * `countLifetimePurchases()`, so without threading the count through, one cheap query
 * runs twice on each of those screens.
 */
export async function lifetimeOffer(
  soldCount?: Promise<number> | number
): Promise<LifetimeOffer> {
  let sold = 0;
  try {
    sold = await (soldCount ?? countLifetimePurchases());
  } catch {
    // A failed count must not take the pricing page down, and the intro price is both the
    // cheaper and the currently-correct answer.
    sold = 0;
  }
  return offerForCount(sold);
}

/** `$25`. Whole dollars — every Orbit price is one, and `.00` reads as a rounding error. */
export function formatUsd(amount: number): string {
  return `$${amount}`;
}
