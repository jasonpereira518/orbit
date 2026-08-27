import {
  FREE_CONTACT_LIMIT,
  LIFETIME_INTRO_PRICE,
  LIFETIME_INTRO_SEATS,
  LIFETIME_STANDARD_PRICE,
  type Plan,
} from "@/lib/plan-limits";

/**
 * Single source of truth for how the tiers are described, so the marketing pricing
 * page, the settings card, and any upgrade prompt cannot drift from each other —
 * the same reason `settings/sections.ts` centralises the settings rail.
 *
 * Prices are display copy. The amounts actually charged live in the Stripe prices;
 * changing a string here does not change what anyone pays.
 *
 * Display names and internal ids are deliberately decoupled: the tiers are shown as
 * "Orbit Pro" and "Orbit Lifetime", but the ids stay `orbit` / `lifetime` because they
 * are persisted in `user_settings` and matched against Stripe checkout metadata. Rename
 * the copy freely; renaming an id is a data migration.
 */
export type BillingPeriod = "monthly" | "annual";

export type PlanPrice = {
  amount: string;
  /** Sits beside the amount, e.g. "per month". */
  cadence: string;
  /**
   * The undiscounted price, struck through beside the amount.
   *
   * Only set where a real price change is coming — Lifetime's introductory rate rises to
   * the standard one after `LIFETIME_INTRO_SEATS` buyers. Never set it as decoration: a
   * struck-through number the product has no intention of charging is a fake discount,
   * and it is the kind of thing that is illegal in several of the places Orbit is sold.
   */
  compareAt?: string;
  /** Second line under the price, only where the billing needs explaining. */
  footnote?: string;
};

export type PlanCopy = {
  id: Plan;
  name: string;
  tagline: string;
  /**
   * Priced per billing period. Tiers that ignore the period (Free, Lifetime) simply
   * carry the same value under both keys, so the toggle never has to special-case them.
   */
  price: Record<BillingPeriod, PlanPrice>;
  features: string[];
  /** Shown under the feature list where a tier deliberately excludes something. */
  caveat?: string;
};

/**
 * $5/mo against $50/yr — two months free, 17% off.
 *
 * Worth knowing before changing this: net of Stripe fees (2.9% + $0.30), a subscriber
 * retained a full year nets $54.66 monthly against $48.25 annually, so annual only pays
 * off if they would otherwise churn before roughly month eleven. It is a retention and
 * cash-flow instrument here, not a fee saving.
 */
/** Exported so the admin MRR figure reads the same number the pricing page charges. */
export const MONTHLY_AMOUNT = 5;
const ANNUAL_AMOUNT = 50;

export const ANNUAL_SAVING_PERCENT = Math.round(
  (1 - ANNUAL_AMOUNT / (MONTHLY_AMOUNT * 12)) * 100
);

/**
 * Lifetime's introductory price, with the standard price struck through beside it.
 *
 * Not a marketing device: the standard price is what the next hundred-and-first buyer
 * actually pays, so the comparison is a real one.
 */
const LIFETIME_INTRO_PRICE_COPY: PlanPrice = {
  amount: `$${LIFETIME_INTRO_PRICE}`,
  cadence: "once",
  compareAt: `$${LIFETIME_STANDARD_PRICE}`,
  // States what the struck-through number means. A crossed-out price with no explanation
  // is indistinguishable from manufactured urgency — and this one is real, so it can
  // afford to say exactly what it is.
  footnote: `Introductory price for the first ${LIFETIME_INTRO_SEATS} buyers, then $${LIFETIME_STANDARD_PRICE}.`,
};

export const PLAN_COPY: PlanCopy[] = [
  {
    id: "free",
    name: "Free Plan",
    tagline: "The whole core product, for a network you can hold in your head.",
    price: {
      monthly: { amount: "$0", cadence: "forever" },
      annual: { amount: "$0", cadence: "forever" },
    },
    features: [
      `Up to ${FREE_CONTACT_LIMIT} contacts`,
      "Capture notes with AI extraction",
      "Chat with your network",
      "Constellation map",
      "LinkedIn import",
      "Reminders and follow-up feed",
      "Knowledge base",
      "Export your data anytime",
    ],
    caveat: "Bring your own AI key — Orbit never charges you for AI.",
  },
  {
    id: "orbit",
    name: "Orbit Pro",
    tagline: "For a network worth more than the price of a coffee.",
    price: {
      monthly: { amount: "$5", cadence: "per month" },
      annual: {
        amount: "$50",
        cadence: "per year",
        footnote: "Two months free",
      },
    },
    features: [
      "Everything in the Free Plan, uncapped",
      "Unlimited contacts",
      "Contact enrichment on Orbit's credits",
      "Outreach campaigns with email and SMS sending",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
    ],
  },
  {
    id: "lifetime",
    name: "Orbit Lifetime",
    tagline: "Pay once. Keep it for as long as Orbit exists.",
    // The default is the INTRO offer, so any surface that renders `PLAN_COPY` without
    // consulting the live sale count still shows the cheaper, currently-correct price.
    // `/pricing` and `/upgrade` override this from `lifetimeOffer()`; see `planCopyFor`.
    price: {
      monthly: LIFETIME_INTRO_PRICE_COPY,
      annual: LIFETIME_INTRO_PRICE_COPY,
    },
    features: [
      "Unlimited contacts, forever",
      "Outreach campaigns with email and SMS sending",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
    ],
    caveat:
      "Contact enrichment runs on your own Apollo key instead of Orbit's credits. Enrichment is the one cost with no ceiling, and that is what keeps a one-time price honest.",
  },
];

export function planCopy(plan: Plan) {
  return PLAN_COPY.find((p) => p.id === plan) ?? PLAN_COPY[0];
}

/**
 * `PLAN_COPY` with Lifetime's price replaced by whatever is actually being charged today.
 *
 * Takes the resolved offer rather than reading it, so this stays free of database imports
 * and the client components that render the tiers can keep importing this module.
 */
export function planCopyWithOffer(offer: {
  priceUsd: number;
  compareAtUsd: number | null;
}): PlanCopy[] {
  const price: PlanPrice = {
    amount: `$${offer.priceUsd}`,
    cadence: "once",
    // Both only while the intro is live. Once it ends, $75 is simply the price and there
    // is nothing to strike through or explain.
    ...(offer.compareAtUsd
      ? {
          compareAt: `$${offer.compareAtUsd}`,
          footnote: `Introductory price for the first ${LIFETIME_INTRO_SEATS} buyers, then $${LIFETIME_STANDARD_PRICE}.`,
        }
      : {}),
  };

  return PLAN_COPY.map((plan) =>
    plan.id === "lifetime"
      ? { ...plan, price: { monthly: price, annual: price } }
      : plan
  );
}
