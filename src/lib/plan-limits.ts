/**
 * Plan identity and limits, with no server-only dependencies.
 *
 * These live apart from `entitlements.ts` on purpose: that module reaches the database
 * through `user-settings.ts`, so anything importing it is server-only. Client components
 * (the pricing tiers and their billing toggle) need the plan ids and the free limit, and
 * pulling them from `entitlements.ts` drags PGlite — and therefore `node:fs` — into the
 * browser bundle, which fails the build.
 *
 * `entitlements.ts` re-exports everything here, so server code can keep importing from
 * the one place it always has.
 */

export type Plan = "free" | "orbit" | "lifetime";

export const FREE_CONTACT_LIMIT = 500;

/**
 * Orbit Lifetime is an introductory price, NOT a limited number of seats.
 *
 * The distinction matters and has already been got wrong once: an earlier version capped
 * Lifetime at 100 buyers, and the Terms went on promising that cap after the product
 * stopped honouring it. Lifetime is available to everyone, permanently. What is limited is
 * the *price* — the first `LIFETIME_INTRO_SEATS` buyers pay the intro amount, and it rises
 * to the standard amount afterwards.
 *
 * So "100" here means "after this many sales the price goes up", never "after this many
 * sales you cannot buy it". Any copy implying scarcity of availability is wrong.
 *
 * These are display and threshold values. What anyone is actually charged is the Stripe
 * price object chosen in `src/lib/lifetime-offer.ts`, which reads these to stay in step —
 * a number changed here alone would make the page advertise a price nobody is charged.
 */
export const LIFETIME_INTRO_PRICE = 25;
export const LIFETIME_STANDARD_PRICE = 75;
export const LIFETIME_INTRO_SEATS = 100;

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Free Plan",
  orbit: "Orbit Pro",
  lifetime: "Orbit Lifetime",
};
