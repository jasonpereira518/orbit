import { cache } from "react";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  FREE_CONTACT_LIMIT,
  LIFETIME_SEAT_LIMIT,
  ORBIT_PLAN_SLUG,
  PLAN_LABELS,
  type Plan,
} from "@/lib/plan-limits";

// Re-exported so server code keeps importing plan identity from this module, while
// client components can reach `plan-limits` directly without pulling in the database.
export {
  FREE_CONTACT_LIMIT,
  LIFETIME_SEAT_LIMIT,
  ORBIT_PLAN_SLUG,
  PLAN_LABELS,
  type Plan,
};

/**
 * Where a user's plan came from. Purely informational for UI ("Comped", "Orbit Lifetime"),
 * but also the tiebreaker documented in `resolvePlan` below.
 */
export type PlanSource = "comp" | "lifetime" | "subscription" | "free";

export type Entitlements = {
  plan: Plan;
  source: PlanSource;
  /** null = unlimited. Gates contact *creation* only; existing contacts are never hidden. */
  contactLimit: number | null;
  canUseOutreach: boolean;
  /**
   * Whether Orbit's own Resend/Twilio/Apollo keys may be used. False for Lifetime:
   * a one-time payment must never buy an open-ended metered liability, so Lifetime
   * users bring their own keys (Settings already supports this per-user).
   */
  canUseHostedSends: boolean;
  canUseRecruiters: boolean;
  canUseSync: boolean;
  canUseExtension: boolean;
};

/** Feature keys that `requireEntitlement` can gate on. */
export type FeatureKey =
  | "outreach"
  | "hostedSends"
  | "recruiters"
  | "sync"
  | "extension";

/**
 * Thrown when a user's plan does not cover an action. Carries enough structure for the
 * UI to render a specific upgrade prompt rather than a generic failure.
 */
export class PaywallError extends Error {
  readonly feature: FeatureKey | "contacts";
  readonly currentPlan: Plan;

  constructor(
    feature: FeatureKey | "contacts",
    currentPlan: Plan,
    message: string
  ) {
    super(message);
    this.name = "PaywallError";
    this.feature = feature;
    this.currentPlan = currentPlan;
  }
}

export function isPaywallError(err: unknown): err is PaywallError {
  return err instanceof Error && err.name === "PaywallError";
}

type BillingColumns = {
  compedPlan?: "orbit" | "lifetime" | null;
  lifetimePurchasedAt?: Date | null;
  subscriptionPlan?: "orbit" | null;
  subscriptionStatus?: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd?: Date | null;
};

/**
 * A canceled subscription keeps working until the period the user already paid for runs
 * out. `past_due` is also honoured until then — dunning is Clerk's job, and yanking access
 * on a transient card failure is the wrong response for a tool holding personal data.
 */
function subscriptionIsLive(row: BillingColumns, now: Date) {
  if (row.subscriptionPlan !== "orbit") return false;
  if (row.subscriptionStatus === "active") return true;
  if (!row.subscriptionPeriodEnd) return false;
  return row.subscriptionPeriodEnd.getTime() > now.getTime();
}

/**
 * Precedence: comp > lifetime > subscription > free.
 *
 * Comp wins outright so a manually granted account is never downgraded by stale billing
 * state. Lifetime outranks subscription so that someone who bought Lifetime and later also
 * subscribed does not silently lose the Lifetime grant if the subscription lapses — the two
 * are additive in practice (see `getEntitlements`, which unions hosted sends back in).
 */
export function resolvePlan(
  row: BillingColumns | null | undefined,
  now = new Date()
): { plan: Plan; source: PlanSource } {
  if (!row) return { plan: "free", source: "free" };
  if (row.compedPlan === "lifetime") return { plan: "lifetime", source: "comp" };
  if (row.compedPlan === "orbit") return { plan: "orbit", source: "comp" };
  if (row.lifetimePurchasedAt) return { plan: "lifetime", source: "lifetime" };
  if (subscriptionIsLive(row, now)) {
    return { plan: "orbit", source: "subscription" };
  }
  return { plan: "free", source: "free" };
}

export function entitlementsForPlan(
  plan: Plan,
  source: PlanSource,
  opts: { hostedSends?: boolean } = {}
): Entitlements {
  const paid = plan !== "free";
  return {
    plan,
    source,
    contactLimit: paid ? null : FREE_CONTACT_LIMIT,
    canUseOutreach: paid,
    canUseHostedSends: opts.hostedSends ?? plan === "orbit",
    canUseRecruiters: paid,
    canUseSync: paid,
    canUseExtension: paid,
  };
}

/**
 * The single entitlement resolver. Every gate in the app goes through this and nothing
 * else — no gate calls Clerk's `has()` or reads Stripe directly.
 *
 * It reads only the database on purpose. Clerk's `has({ plan })` needs an active request
 * context, so background paths (the import job processor, the ICS feed) could never call
 * it; the Clerk webhook mirrors subscription state into `user_settings` so request and
 * background code resolve identically. Same rationale as the mirrored `email` column.
 */
export const getEntitlements = cache(
  async (userId: string): Promise<Entitlements> => {
    const row = await ensureUserSettings(userId);
    const { plan, source } = resolvePlan(row);
    // A Lifetime holder who also subscribes gets hosted sends for as long as the
    // subscription is live, without losing the Lifetime floor when it lapses.
    const hostedSends =
      plan === "orbit" || (row ? subscriptionIsLive(row, new Date()) : false);
    return entitlementsForPlan(plan, source, { hostedSends });
  }
);

const FEATURE_DENIAL: Record<FeatureKey, string> = {
  outreach: "Outreach is available on Orbit Pro and Orbit Lifetime.",
  hostedSends:
    "Sending on Orbit's email/SMS credits requires Orbit Pro. On Orbit Lifetime, add your own Resend or Twilio key in Settings.",
  recruiters: "Recruiter tracking is available on Orbit Pro and Orbit Lifetime.",
  sync: "Mailbox and calendar sync are available on Orbit Pro and Orbit Lifetime.",
  extension: "The Orbit extension is available on Orbit Pro and Orbit Lifetime.",
};

const FEATURE_FLAG: Record<FeatureKey, keyof Entitlements> = {
  outreach: "canUseOutreach",
  hostedSends: "canUseHostedSends",
  recruiters: "canUseRecruiters",
  sync: "canUseSync",
  extension: "canUseExtension",
};

/** Throws `PaywallError` unless the user's plan covers `feature`. */
export async function requireEntitlement(userId: string, feature: FeatureKey) {
  const ent = await getEntitlements(userId);
  if (ent[FEATURE_FLAG[feature]] !== true) {
    throw new PaywallError(feature, ent.plan, FEATURE_DENIAL[feature]);
  }
  return ent;
}
