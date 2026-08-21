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

/**
 * Slug of the recurring plan in the Clerk Dashboard. Overridable so a differently named
 * plan (or a staging instance) does not require a code change.
 */
export const ORBIT_PLAN_SLUG = process.env.CLERK_ORBIT_PLAN_SLUG || "orbit";

export const FREE_CONTACT_LIMIT = 100;

/** Lifetime is an early-adopter tier; past this many purchases it retires. */
export const LIFETIME_SEAT_LIMIT = 100;

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Free",
  orbit: "Orbit Pro",
  lifetime: "Orbit Lifetime",
};

/** Feature keys that can be gated by plan. */
export type FeatureKey =
  | "outreach"
  | "hostedSends"
  | "recruiters"
  | "sync"
  | "extension";

/**
 * Which plans grant each feature — the single source for both the server-side gate
 * (`entitlementsForPlan`) and the "Included in …" copy the locked UI shows. Deriving both
 * from one table is what stops a tooltip promising something the gate then refuses.
 *
 * `hostedSends` is deliberately Orbit Pro only: sending on Orbit's own Resend/Twilio
 * credits is metered, and a one-time payment must never buy an open-ended liability.
 */
export const FEATURE_PLANS: Record<FeatureKey, readonly Plan[]> = {
  outreach: ["orbit", "lifetime"],
  hostedSends: ["orbit"],
  recruiters: ["orbit", "lifetime"],
  sync: ["orbit", "lifetime"],
  extension: ["orbit", "lifetime"],
};

/**
 * Maps a feature to the `Entitlements` flag that grants it. Lives here rather than in
 * `entitlements.ts` so client components (locked nav rows) can read it without importing
 * the database.
 */
export const FEATURE_FLAG = {
  outreach: "canUseOutreach",
  hostedSends: "canUseHostedSends",
  recruiters: "canUseRecruiters",
  sync: "canUseSync",
  extension: "canUseExtension",
} as const satisfies Record<FeatureKey, string>;

export function planIncludes(plan: Plan, feature: FeatureKey) {
  return FEATURE_PLANS[feature].includes(plan);
}

/** e.g. "Orbit Pro and Orbit Lifetime" — for locked-state tooltips. */
export function includedInLabel(feature: FeatureKey) {
  const names = FEATURE_PLANS[feature].map((p) => PLAN_LABELS[p]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Ring colour worn by the Orbit mark once a plan is paid for — blue for Orbit Pro, gold
 * for Orbit Lifetime, nothing for Free. Both are drawn from colours the product already
 * uses: the dark theme's primary blue and the landing's accent gold.
 */
export const PLAN_RING: Record<Plan, string | null> = {
  free: null,
  orbit: "#599de7",
  lifetime: "#f2c14e",
};
