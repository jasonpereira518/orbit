import { FREE_CONTACT_LIMIT, type Plan } from "@/lib/entitlements";

/**
 * Single source of truth for how the tiers are described, so the marketing pricing
 * section, the settings card, and any upgrade prompt cannot drift from each other —
 * the same reason `settings/sections.ts` centralises the settings rail.
 *
 * Prices are display copy. The amounts actually charged live in the Clerk plan and the
 * Stripe price; changing a string here does not change what anyone pays.
 */
export type PlanCopy = {
  id: Plan;
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  /** Shown under the feature list where a tier deliberately excludes something. */
  caveat?: string;
};

export const PLAN_COPY: PlanCopy[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "forever",
    tagline: "The whole core product, for a network you can hold in your head.",
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
    name: "Orbit",
    price: "$5",
    cadence: "per month",
    tagline: "For a real network, with the connected pieces running.",
    features: [
      "Unlimited contacts",
      "Everything in Free",
      "Outreach campaigns, sent on Orbit's credits",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
    ],
  },
  {
    id: "lifetime",
    name: "Lifetime",
    price: "$19",
    cadence: "once",
    tagline: "Early adopters only. Pay once, keep it.",
    features: [
      "Unlimited contacts, forever",
      "Recruiter tracking",
      "Gmail, Outlook, and calendar sync",
      "Chrome extension",
      "Every feature Orbit ships that costs nothing to run",
    ],
    caveat:
      "Outreach uses your own Apollo, Resend, and Twilio keys rather than Orbit's credits — that is what keeps a one-time price honest.",
  },
];

export function planCopy(plan: Plan) {
  return PLAN_COPY.find((p) => p.id === plan) ?? PLAN_COPY[0];
}
