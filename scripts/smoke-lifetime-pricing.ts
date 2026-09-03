/**
 * Orbit Lifetime's introductory price.
 *
 * THE FAILURE THIS GUARDS AGAINST is not a stale number on a page. It is the page
 * advertising one price while Stripe charges another — which stops being a typo and starts
 * being a consumer-protection problem. So the display amount and the Stripe price id are
 * resolved by one function, and these assertions pin them together.
 *
 * The second thing it guards is the framing. An earlier version of Orbit capped Lifetime
 * at 100 buyers, and the Terms went on promising that cap for weeks after the product
 * stopped enforcing it. 100 is a price threshold, never a supply limit — `offerForCount`
 * must keep selling past it.
 *
 * Run: npx tsx scripts/smoke-lifetime-pricing.ts
 */
import "./smoke/_env";

import { offerForCount } from "../src/lib/lifetime-offer";
import { planCopyWithOffer } from "../src/lib/plan-copy";
import {
  LIFETIME_INTRO_PRICE,
  LIFETIME_INTRO_SEATS,
  LIFETIME_STANDARD_PRICE,
} from "../src/lib/plan-limits";

const IDS = { intro: "price_intro", standard: "price_standard" };
const NO_STANDARD = { intro: "price_intro", standard: null };

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  /* ------------------------------------------------------------------ during the intro */

  const first = offerForCount(0, IDS);
  check("the first buyer pays the intro price", first.priceUsd === LIFETIME_INTRO_PRICE);
  check(
    "the standard price is shown struck through",
    first.compareAtUsd === LIFETIME_STANDARD_PRICE
  );
  check("...and checkout charges the intro price object", first.stripePriceId === "price_intro");
  check(
    "the remaining count is the whole intro allocation",
    first.introRemaining === LIFETIME_INTRO_SEATS
  );

  // Off-by-one at the boundary decides whether buyer 100 gets the price they were shown.
  const last = offerForCount(LIFETIME_INTRO_SEATS - 1, IDS);
  check(
    `buyer ${LIFETIME_INTRO_SEATS} still pays the intro price`,
    last.priceUsd === LIFETIME_INTRO_PRICE && last.isIntro
  );
  check("...with one place left", last.introRemaining === 1);

  /* -------------------------------------------------------------------- after the intro */

  const after = offerForCount(LIFETIME_INTRO_SEATS, IDS);
  check("the next buyer pays the standard price", after.priceUsd === LIFETIME_STANDARD_PRICE);
  check("...and checkout charges the standard price object", after.stripePriceId === "price_standard");
  check("the intro allocation is reported as gone", after.introRemaining === null);

  // A struck-through price that never goes away is a fake discount, and it is the exact
  // pattern regulators look for. Once $75 IS the price there is nothing to compare to.
  check("the struck-through comparison disappears with the discount", after.compareAtUsd === null);

  /* ------------------------------------------------- LIFETIME IS NOT LIMITED IN SUPPLY */

  // The whole point. 100 is a price threshold; the product must keep selling past it.
  const wayPast = offerForCount(10_000, IDS);
  check("Lifetime is still purchasable long past the threshold", wayPast.stripePriceId !== null);
  check("...at the standard price", wayPast.priceUsd === LIFETIME_STANDARD_PRICE);

  /* --------------------------------------------- the safe failure when Stripe is behind */

  // If the standard price object does not exist yet, keep charging (and showing) the intro
  // price. Selling too cheap costs money; advertising $75 and charging $25 is a different
  // category of problem, so the safe failure is the one that only costs money.
  const unconfigured = offerForCount(LIFETIME_INTRO_SEATS + 5, NO_STANDARD);
  check(
    "an unconfigured standard price keeps the intro price rather than mis-charging",
    unconfigured.priceUsd === LIFETIME_INTRO_PRICE &&
      unconfigured.stripePriceId === "price_intro"
  );
  check(
    "...and flags itself so the operator finds out",
    unconfigured.needsStandardPrice === true
  );
  check(
    "...while the intro is correctly flagged during it",
    offerForCount(0, IDS).needsStandardPrice === false
  );

  /* ---------------------------------------------------------------------- the rendering */

  const introCopy = planCopyWithOffer(first).find((p) => p.id === "lifetime");
  check(
    "the tier renders the intro amount",
    introCopy?.price.monthly.amount === `$${LIFETIME_INTRO_PRICE}`,
    introCopy?.price.monthly.amount
  );
  check(
    "...with the standard price struck through",
    introCopy?.price.monthly.compareAt === `$${LIFETIME_STANDARD_PRICE}`
  );
  check(
    "...and a footnote saying what that means",
    Boolean(introCopy?.price.monthly.footnote?.includes(String(LIFETIME_INTRO_SEATS)))
  );

  // Lifetime ignores the billing toggle, so both periods must carry the same price —
  // otherwise switching to annual would appear to reprice a one-time purchase.
  check(
    "the billing toggle does not reprice a one-time purchase",
    introCopy?.price.monthly.amount === introCopy?.price.annual.amount
  );

  const afterCopy = planCopyWithOffer(after).find((p) => p.id === "lifetime");
  check(
    "once the intro ends the tier shows the standard price alone",
    afterCopy?.price.monthly.amount === `$${LIFETIME_STANDARD_PRICE}` &&
      afterCopy?.price.monthly.compareAt === undefined &&
      afterCopy?.price.monthly.footnote === undefined
  );

  // Nothing here should disturb the recurring tiers.
  const pro = planCopyWithOffer(first).find((p) => p.id === "orbit");
  check("Orbit Pro is untouched", pro?.price.monthly.compareAt === undefined);

  console.log("\nAll lifetime-pricing checks passed.");
}

main();
process.exit(0);
