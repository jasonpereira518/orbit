import {
  FREE_CONTACT_LIMIT,
  PLAN_CONFIG,
  annualMonthlyEquivalentCents,
  formatPlanPrice,
  type BillingPeriod,
  type Plan,
  type PurchasablePlan,
} from "@/lib/plans/plan-config";

export type { BillingPeriod } from "@/lib/plans/plan-config";
export { ANNUAL_SAVING_PERCENT } from "@/lib/plans/plan-config";
import { FOUNDING_AMOUNT_OFF_CENTS, FOUNDING_MONTHS } from "@/lib/stripe-config";
import type { DemoAccountReason } from "@/lib/demo-account";

/**
 * Single source of truth for how the tiers are described, so the marketing pricing
 * page, the settings card, and any upgrade prompt cannot drift from each other —
 * the same reason `settings/sections.ts` centralises the settings rail.
 *
 * Prices are read from `PLAN_CONFIG`, which is also what the gates enforce; the amount
 * actually charged is the Stripe price with the matching lookup key.
 *
 * TWO RULES THIS COPY KEEPS:
 *  - Only shipped features. Outreach, Events and the Chrome extension are behind their
 *    coming-soon gates and appear in no plan copy until they ship.
 *  - No fake urgency: no struck-through prices, countdowns or scarcity. A founding price is
 *    shown only to an eligible account, and always with its full terms.
 *
 * Display names and internal ids are deliberately decoupled: "Orbit Pro" is id `orbit`,
 * persisted in `user_settings` and Stripe metadata. Rename the copy freely; renaming an id
 * is a data migration.
 */

export type PlanPrice = {
  amount: string;
  /** Sits beside the amount, e.g. "per month". */
  cadence: string;
  /** Second line under the price, only where the billing needs explaining. */
  footnote?: string;
};

export type PlanCopy = {
  id: Plan;
  name: string;
  tagline: string;
  /** What the card shows for each billing period the toggle offers. */
  price: Record<BillingPeriod, PlanPrice>;
  features: string[];
  /** Shown under the feature list where a tier deliberately excludes something. */
  caveat?: string;
};

/** The one-line positioning, used wherever plans are summarised. */
export const AI_POSITIONING = "Free: bring your own AI key. Pro and Max: AI included.";

const HOURS = (seconds: number) => `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
const pro = PLAN_CONFIG.orbit;
const max = PLAN_CONFIG.max;
const lifetime = PLAN_CONFIG.lifetime;
const free = PLAN_CONFIG.free;

/** A paid plan's two prices. Annual is two months free, and says what that works out to. */
function prices(plan: PurchasablePlan): Record<BillingPeriod, PlanPrice> {
  return {
    monthly: { amount: formatPlanPrice(PLAN_CONFIG[plan].monthlyPriceCents ?? 0), cadence: "per month" },
    annual: {
      amount: formatPlanPrice(PLAN_CONFIG[plan].annualPriceCents ?? 0),
      cadence: "per year",
      // One line on the narrowest card: the saving first, then what it works out to.
      footnote: `Two months free · ${formatPlanPrice(annualMonthlyEquivalentCents(plan))}/mo`,
    },
  };
}

function samePrice(price: PlanPrice): Record<BillingPeriod, PlanPrice> {
  return { monthly: price, annual: price };
}

export const PLAN_COPY: PlanCopy[] = [
  {
    id: "free",
    name: "Free Plan",
    tagline: "The whole core product, for a network you can hold in your head.",
    price: samePrice({ amount: "$0", cadence: "forever" }),
    features: [
      `Up to ${FREE_CONTACT_LIMIT} contacts`,
      "Capture notes, chat with your network, and summaries, on your own AI key",
      "Constellation map",
      "Reminders and follow-up feed",
      "Knowledge base",
      "LinkedIn import and export anytime",
      "Claude and ChatGPT connector",
      "One Google or Microsoft account",
      `${HOURS(free.speech.shortformSeconds)} of voice notes a month`,
    ],
    caveat: "Bring your own AI key.",
  },
  {
    id: "orbit",
    name: "Orbit Pro",
    tagline: "For a network worth more than the price of a coffee.",
    price: prices("orbit"),
    features: [
      "Everything in the Free Plan, uncapped",
      "Unlimited contacts",
      `AI included: ${pro.monthlyCredits} credits a month`,
      "Top up with $5 packs of 250 credits",
      "Recruiter tracking",
      "Connect both Google and Microsoft",
      "Calendar subscriptions",
      `${HOURS(pro.speech.meetingSeconds)} of meeting transcription a month`,
      `${HOURS(pro.speech.shortformSeconds)} of voice notes a month`,
      `${pro.hostedEnrichmentsPerMonth} contact enrichments a month`,
    ],
    caveat: "Prefer your own AI key? Add it any time; calls on it never use credits.",
  },
  {
    id: "max",
    name: "Orbit Max",
    tagline: "For the people whose network is the job.",
    price: prices("max"),
    features: [
      "Everything in Orbit Pro",
      `AI included: ${max.monthlyCredits} credits a month`,
      `${HOURS(max.speech.meetingSeconds)} of meeting transcription a month`,
      `${HOURS(max.speech.shortformSeconds)} of voice notes a month`,
      `${max.hostedEnrichmentsPerMonth} contact enrichments a month`,
      "REST API and webhooks",
    ],
    caveat: "Prefer your own AI key? Add it any time; calls on it never use credits.",
  },
  {
    // Not sold: granted by Orbit. Described for the plan card and the celebration only.
    id: "lifetime",
    name: "Orbit Lifetime",
    tagline: "Yours for as long as Orbit exists.",
    price: samePrice({ amount: "Granted", cadence: "by Orbit" }),
    features: [
      "Unlimited contacts",
      "Recruiter tracking, with Google and Microsoft together",
      `${HOURS(lifetime.speech.meetingSeconds)} of meeting transcription a month`,
      `${HOURS(lifetime.speech.shortformSeconds)} of voice notes a month`,
      `${lifetime.hostedEnrichmentsPerMonth} contact enrichments a month`,
      "REST API and webhooks",
    ],
    caveat: "AI runs on your own provider key.",
  },
];

export function planCopy(plan: Plan) {
  return PLAN_COPY.find((p) => p.id === plan) ?? PLAN_COPY[0];
}

/** The plans on sale, in the order the pricing page shows them. */
export const PUBLIC_PLAN_COPY: PlanCopy[] = PLAN_COPY.filter((p) => p.id !== "lifetime");

/**
 * Founding pricing for an eligible account, always stated with its full terms — e.g.
 * "$6.99/month for your first 3 months, then $8.99/month". Only ever rendered for a
 * signed-in account whose `founding_eligible` is set and not yet redeemed. Monthly billing
 * only: an annual plan is already two months free.
 */
export function foundingPriceTerms(plan: PurchasablePlan): string {
  const list = PLAN_CONFIG[plan].monthlyPriceCents ?? 0;
  const founding = list - FOUNDING_AMOUNT_OFF_CENTS[plan];
  return `${formatPlanPrice(founding)}/month for your first ${FOUNDING_MONTHS} months, then ${formatPlanPrice(list)}/month`;
}

/**
 * The plan card's line when contacts are uncapped. A demo account's limits are lifted by
 * `getEntitlements`, not bought, so it says so — otherwise a free plan on localhost read
 * "Unlimited contacts" right beside its own "Up to 500 contacts".
 */
export function unlimitedContactsLine(used: number, demo: DemoAccountReason | null): string {
  if (demo === "localhost") return `Demo account — plan limits lifted on localhost. ${used} in your orbit.`;
  if (demo === "showcase") return `Showcase account — plan limits lifted. ${used} in your orbit.`;
  return `Unlimited contacts — ${used} in your orbit.`;
}
