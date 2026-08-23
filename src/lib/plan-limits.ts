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

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Free Plan",
  orbit: "Orbit Pro",
  lifetime: "Orbit Lifetime",
};
