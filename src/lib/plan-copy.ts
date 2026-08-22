import { FREE_CONTACT_LIMIT, type Plan } from "@/lib/plan-limits";

/**
 * Single source of truth for how the tiers are described, so the marketing pricing
 * page, the settings card, and any upgrade prompt cannot drift from each other —
 * the same reason `settings/sections.ts` centralises the settings rail.
 *
 * Prices are display copy. The amounts actually charged live in the Clerk plan and the
 * Stripe price; changing a string here does not change what anyone pays.
 *
 * Display names and internal ids are deliberately decoupled: the tiers are shown as
 * "Orbit Pro" and "Orbit Lifetime", but the ids stay `orbit` / `lifetime` because they
 * are persisted in `user_settings` and matched against the Clerk plan slug. Rename the
 * copy freely; renaming an id is a data migration.
 */
export type BillingPeriod = "monthly" | "annual";

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
 * Worth knowing before changing this: net of fees (Clerk 0.7% + Stripe 2.9% + $0.30),
 * a subscriber retained a full year nets $54.24 monthly against $47.90 annually, so
 * annual only pays off if they would otherwise churn before roughly month eleven. It is
 * a retention and cash-flow instrument here, not a fee saving.
 */
const MONTHLY_AMOUNT = 5;
const ANNUAL_AMOUNT = 50;

export const ANNUAL_SAVING_PERCENT = Math.round(
  (1 - ANNUAL_AMOUNT / (MONTHLY_AMOUNT * 12)) * 100
);

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
      "Outreach campaigns on Orbit's sending credits",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
    ],
  },
  {
    id: "lifetime",
    name: "Orbit Lifetime",
    tagline: "Pay once. Keep it for as long as Orbit exists.",
    price: {
      monthly: { amount: "$19", cadence: "once" },
      annual: { amount: "$19", cadence: "once" },
    },
    features: [
      "Unlimited contacts, forever",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
      "Every feature that costs nothing to run",
    ],
    caveat:
      "Outreach runs on your own Apollo, Resend, and Twilio keys instead of Orbit's credits. That is what keeps a one-time price honest.",
  },
];

export function planCopy(plan: Plan) {
  return PLAN_COPY.find((p) => p.id === plan) ?? PLAN_COPY[0];
}
