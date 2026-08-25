import { cache } from "react";
import { recordGateHit } from "@/lib/gate-events";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  FREE_CONTACT_LIMIT,
  ORBIT_PLAN_SLUG,
  PLAN_LABELS,
  type Plan,
} from "@/lib/plan-limits";

// Re-exported so server code keeps importing plan identity from this module, while
// client components can reach `plan-limits` directly without pulling in the database.
export { FREE_CONTACT_LIMIT, ORBIT_PLAN_SLUG, PLAN_LABELS, type Plan };

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
   * Whether Orbit's own Resend/Twilio credentials may be used to send email and SMS.
   * True on both paid tiers. Sending is the one metered cost with a standing ceiling —
   * `DAILY_SEND_LIMIT` caps every user per day regardless of plan — so a one-time
   * payment can carry it without buying an unbounded obligation.
   */
  canUseHostedSending: boolean;
  /**
   * Whether Orbit's own Apollo key may be used for contact enrichment. Orbit Pro only.
   * Enrichment has no quota anywhere in the product, so it is the single genuinely
   * open-ended per-user cost, and the one thing a one-time payment cannot fund forever.
   * Lifetime users add their own Apollo key in Settings, which `getApolloApiKey` prefers
   * over Orbit's on every plan.
   *
   * This is the only entitlement that separates Orbit Pro from Orbit Lifetime.
   */
  canUseHostedEnrichment: boolean;
  canUseRecruiters: boolean;
  canUseSync: boolean;
  canUseExtension: boolean;
};

/** Feature keys that `requireEntitlement` can gate on. */
export type FeatureKey =
  | "outreach"
  | "hostedSending"
  | "hostedEnrichment"
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
 * are additive in practice (see `getEntitlements`, which unions hosted enrichment back in).
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
  opts: { hostedEnrichment?: boolean } = {}
): Entitlements {
  const paid = plan !== "free";
  return {
    plan,
    source,
    contactLimit: paid ? null : FREE_CONTACT_LIMIT,
    canUseOutreach: paid,
    canUseHostedSending: paid,
    canUseHostedEnrichment: opts.hostedEnrichment ?? plan === "orbit",
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
    // A Lifetime holder who also subscribes gets hosted enrichment for as long as the
    // subscription is live, without losing the Lifetime floor when it lapses. Enrichment
    // is the only flag this can still matter for: `resolvePlan` ranks lifetime above
    // subscription, so such a user resolves to `lifetime`, which is denied enrichment on
    // its own. Everything else is already true on both paid tiers.
    const hostedEnrichment =
      plan === "orbit" || (row ? subscriptionIsLive(row, new Date()) : false);
    return entitlementsForPlan(plan, source, { hostedEnrichment });
  }
);

const FEATURE_DENIAL: Record<FeatureKey, string> = {
  outreach: "Outreach is available on Orbit Pro and Orbit Lifetime.",
  hostedSending:
    "Sending email and SMS on Orbit's credits is available on Orbit Pro and Orbit Lifetime.",
  hostedEnrichment:
    "Contact enrichment on Orbit's credits requires Orbit Pro. On any other plan, add your own Apollo key in Settings.",
  recruiters: "Recruiter tracking is available on Orbit Pro and Orbit Lifetime.",
  sync: "Mailbox and calendar sync are available on Orbit Pro and Orbit Lifetime.",
  extension: "The Orbit extension is available on Orbit Pro and Orbit Lifetime.",
};

const FEATURE_FLAG: Record<FeatureKey, keyof Entitlements> = {
  outreach: "canUseOutreach",
  hostedSending: "canUseHostedSending",
  hostedEnrichment: "canUseHostedEnrichment",
  recruiters: "canUseRecruiters",
  sync: "canUseSync",
  extension: "canUseExtension",
};

/**
 * Throws `PaywallError` unless the user's plan covers `feature`.
 *
 * The refusal is recorded before it is thrown. This is the only place demand for a gated
 * feature can be observed — `usage_events` records what happened and by construction never
 * what someone wanted and could not reach — so the pricing question depends entirely on it.
 * `recordGateHit` swallows its own failures, so this cannot turn a paywall into a 500.
 */
export async function requireEntitlement(userId: string, feature: FeatureKey) {
  const ent = await getEntitlements(userId);
  if (ent[FEATURE_FLAG[feature]] !== true) {
    await recordGateHit({ userId, feature, plan: ent.plan });
    throw new PaywallError(feature, ent.plan, FEATURE_DENIAL[feature]);
  }
  return ent;
}
