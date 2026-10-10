/**
 * THE plan table. Every plan limit and feature gate in Orbit is read from here.
 *
 * Client-safe on purpose: no DB, no env, no server imports. The pricing page, the
 * comparison table and the settings plan card render from the same object the server
 * gates on, so what a page promises and what a gate allows cannot drift apart.
 *
 * Before this module the same facts lived in five places (plan-limits, speech-limits,
 * rate-limit, managed-ai-policy, apollo) and `entitlementsForPlan` was essentially
 * `plan !== "free"`. Anything that needs a per-plan number or flag reads it from
 * `planConfig(plan)`; nothing should branch on a plan id to decide a limit.
 *
 * Plan ids are storage values. `orbit` is Orbit Pro — renaming it would be a data
 * migration across user_settings, gate_events, billing metadata and Stripe metadata, for
 * no user-visible gain, so the label changes and the id stays.
 */

export type Plan = "free" | "orbit" | "max" | "lifetime";

/** Every plan, cheapest first. Lifetime last: it is never sold, only granted. */
export const PLANS: readonly Plan[] = ["free", "orbit", "max", "lifetime"];

/**
 * Order of "more access". A move up this ladder is an upgrade (and gets the celebration);
 * Lifetime ranks above Max because granting it to a Max subscriber is still a step up.
 */
export const PLAN_RANK: Record<Plan, number> = { free: 0, orbit: 1, max: 2, lifetime: 3 };

/** The plans a person can buy. Lifetime is admin-assigned only. */
export type PurchasablePlan = "orbit" | "max";
export const PURCHASABLE_PLANS: readonly PurchasablePlan[] = ["orbit", "max"];

/** A plan Orbit bills monthly (the two subscription tiers). */
export function isPurchasablePlan(plan: string | null | undefined): plan is PurchasablePlan {
  return plan === "orbit" || plan === "max";
}

/**
 * Where a user's plan came from. Purely informational for UI ("Comped", "Orbit Lifetime"),
 * but also the tiebreaker documented in `resolvePlan`.
 */
export type PlanSource = "comp" | "lifetime" | "subscription" | "free";

export const FREE_CONTACT_LIMIT = 500;

/** A Free account's one-time AI grant, spent after each month's allowance. Never renews. */
export const FREE_STARTER_CREDITS = 25;

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Free Plan",
  orbit: "Orbit Pro",
  max: "Orbit Max",
  lifetime: "Orbit Lifetime",
};

/** Short names for chips and dense tables. */
export const PLAN_SHORT_LABELS: Record<Plan, string> = {
  free: "Free",
  orbit: "Pro",
  max: "Max",
  lifetime: "Lifetime",
};

/**
 * Feature keys that `requireEntitlement` can gate on.
 *
 * A runtime array with the type derived from it, rather than a bare type: a cross-module
 * guard ("every connector manifest names an entitlement this layer knows",
 * `scripts/smoke-connector-registry.ts`) needs a list it can actually read at runtime.
 *
 * - `outreach`, `hostedSending`: Outreach is NOT shipped (coming-soon gate). The flags stay
 *   so the gated code keeps a plan answer, but no pricing copy may mention them.
 * - `extension`: the extension's CORE is free on every plan; its Pro depth is decided by the
 *   extension's own gate (open PR #248), not by this flag.
 * - `sync`: pasted-ICS calendar subscriptions and event sources.
 * - `extraConnections`: a second Google or Microsoft account. Free keeps its first one.
 * - `hostedAi`: AI on Orbit's provider keys, metered in credits (Free, Pro and Max; not Lifetime).
 * - `creditPacks`: buying a $5 top-up pack (Pro and Max only).
 */
export const FEATURE_KEYS = [
  "outreach",
  "hostedSending",
  "hostedEnrichment",
  "recruiters",
  "sync",
  "extension",
  "api",
  "meetings",
  "hostedAi",
  "creditPacks",
  "extraConnections",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type PlanConfig = {
  label: string;
  /** Monthly price in cents, or null when the plan is not sold. */
  monthlyPriceCents: number | null;
  /** Price for a year paid up front, in cents (two months free), or null when not sold yearly. */
  annualPriceCents: number | null;
  /** null = unlimited. Gates contact *creation* only; existing contacts are never hidden. */
  contactLimit: number | null;
  /** Managed-AI credits granted each cycle, or null when AI runs only on the user's key. */
  monthlyCredits: number | null;
  /** Deepgram audio seconds per month. */
  speech: { meetingSeconds: number; shortformSeconds: number };
  /** Contact enrichments per month on Orbit's own Apollo key. */
  hostedEnrichmentsPerMonth: number;
  /** Connected Google + Microsoft accounts. null = no limit. */
  googleMicrosoftConnections: number | null;
  /** The MCP rate-limit bucket (MCP itself is free on every plan). */
  mcpRateTier: "mcpFree" | "mcp";
  features: Record<FeatureKey, boolean>;
};

const HOUR = 3_600;

const PAID_FEATURES: Record<FeatureKey, boolean> = {
  outreach: true,
  hostedSending: true,
  hostedEnrichment: true,
  recruiters: true,
  sync: true,
  extension: true,
  api: true,
  meetings: true,
  hostedAi: true,
  creditPacks: true,
  extraConnections: true,
};

export const PLAN_CONFIG: Record<Plan, PlanConfig> = {
  free: {
    label: PLAN_LABELS.free,
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    contactLimit: FREE_CONTACT_LIMIT,
    monthlyCredits: 10,
    speech: { meetingSeconds: 0, shortformSeconds: 1 * HOUR },
    hostedEnrichmentsPerMonth: 0,
    googleMicrosoftConnections: 1,
    mcpRateTier: "mcpFree",
    features: {
      outreach: false,
      hostedSending: false,
      hostedEnrichment: false,
      recruiters: false,
      sync: false,
      extension: true,
      api: false,
      meetings: false,
      hostedAi: true,
      creditPacks: false,
      extraConnections: false,
    },
  },
  orbit: {
    label: PLAN_LABELS.orbit,
    monthlyPriceCents: 899,
    annualPriceCents: 8999,
    contactLimit: null,
    monthlyCredits: 200,
    speech: { meetingSeconds: 5 * HOUR, shortformSeconds: 5 * HOUR },
    hostedEnrichmentsPerMonth: 10,
    googleMicrosoftConnections: null,
    mcpRateTier: "mcp",
    // The REST API and outbound webhooks are Max and Lifetime only.
    features: { ...PAID_FEATURES, api: false },
  },
  max: {
    label: PLAN_LABELS.max,
    monthlyPriceCents: 1999,
    annualPriceCents: 19999,
    contactLimit: null,
    monthlyCredits: 500,
    speech: { meetingSeconds: 10 * HOUR, shortformSeconds: 10 * HOUR },
    hostedEnrichmentsPerMonth: 25,
    googleMicrosoftConnections: null,
    mcpRateTier: "mcp",
    features: PAID_FEATURES,
  },
  // Every Max entitlement, except that AI runs only on the user's own key: no managed
  // AI allowance and no packs.
  lifetime: {
    label: PLAN_LABELS.lifetime,
    monthlyPriceCents: null,
    annualPriceCents: null,
    contactLimit: null,
    monthlyCredits: null,
    speech: { meetingSeconds: 10 * HOUR, shortformSeconds: 10 * HOUR },
    hostedEnrichmentsPerMonth: 25,
    googleMicrosoftConnections: null,
    mcpRateTier: "mcp",
    features: { ...PAID_FEATURES, hostedAi: false, creditPacks: false },
  },
};

/**
 * How a paid plan is billed. Annual is two months free; the included AI allowance still
 * arrives MONTHLY on an annual plan (see `creditPeriodFor`), never as one yearly lump.
 */
export type BillingPeriod = "monthly" | "annual";
export const BILLING_PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];

/** The recurring value of an annual plan per month, as MRR books it (Stripe's own rounding). */
export function annualMonthlyEquivalentCents(plan: PurchasablePlan): number {
  return Math.round((PLAN_CONFIG[plan].annualPriceCents ?? 0) / 12);
}

/** What a year of the plan costs, in cents, for the period chosen. */
export function planPriceCents(plan: PurchasablePlan, period: BillingPeriod): number {
  return (period === "annual" ? PLAN_CONFIG[plan].annualPriceCents : PLAN_CONFIG[plan].monthlyPriceCents) ?? 0;
}

/** Whole percent saved by paying yearly, from Pro's prices (Max rounds to the same). */
export const ANNUAL_SAVING_PERCENT = Math.round(
  (1 - (PLAN_CONFIG.orbit.annualPriceCents ?? 0) / ((PLAN_CONFIG.orbit.monthlyPriceCents ?? 1) * 12)) * 100
);

export function planConfig(plan: Plan): PlanConfig {
  return PLAN_CONFIG[plan];
}

export function planHasFeature(plan: Plan, feature: FeatureKey): boolean {
  return PLAN_CONFIG[plan].features[feature];
}

/**
 * The cheapest plan someone can BUY that unlocks `feature` — what an upgrade prompt
 * should offer, and what `gate_events.unlock_plan` records. Lifetime is never the answer:
 * it is not for sale. The free contact cap unlocks on Pro.
 */
export function unlockPlanFor(feature: FeatureKey | "contacts"): PurchasablePlan {
  if (feature === "contacts") return "orbit";
  return PURCHASABLE_PLANS.find((plan) => PLAN_CONFIG[plan].features[feature]) ?? "max";
}

/** The refusal for a Free account's second Google or Microsoft account. */
export const EXTRA_CONNECTION_DENIAL =
  "The Free Plan includes one Google or Microsoft account. Connecting both is available on Orbit Pro and Orbit Max.";

/** Display money: 899 → "$8.99". */
export function formatPlanPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
