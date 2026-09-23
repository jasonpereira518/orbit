import { cache } from "react";
import { isDemoAccount } from "@/lib/demo-account";
import { recordGateHit } from "@/lib/gate-events";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  FREE_CONTACT_LIMIT,
  PLAN_LABELS,
  type Plan,
  type PlanSource,
} from "@/lib/plan-limits";

// Re-exported so server code keeps importing plan identity from this module, while
// client components can reach `plan-limits` directly without pulling in the database.
export { FREE_CONTACT_LIMIT, PLAN_LABELS, type Plan, type PlanSource };

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
  /**
   * The public API, outbound webhooks and the MCP server.
   *
   * A key of its own rather than folding into `canUseSync`, for two reasons. The denial copy
   * for sync says "Mailbox and calendar sync are available on…", which is simply wrong on an
   * API 402. More importantly `gate_events` is the only place demand for a gated feature is
   * observable, and the pricing question depends entirely on it — conflating "someone wanted
   * to connect Zapier" with "someone wanted mailbox sync" destroys exactly the signal that
   * table exists to collect.
   */
  canUseApi: boolean;
  /**
   * The MCP server — Orbit inside Claude, ChatGPT or any other assistant that speaks the
   * protocol. True on every plan, including free, which is the one deliberate exception to
   * the paid-connector line above.
   *
   * The reasoning is that this is the funnel, not an add-on. Someone who asks their assistant
   * "who do I know at Stripe?" and gets a real answer has understood the product in one
   * sentence, which no landing page has managed. The plan limits that cost money still apply
   * underneath: the free contact cap bounds `create_contact`, and sending is not a tool at
   * all — an agent can only queue a message for the user to approve.
   *
   * Kept as its own flag rather than reusing `canUseApi` so that the REST API and webhooks,
   * which really are paid, do not silently become free with it.
   */
  canUseMcp: boolean;
  /**
   * Meeting recording and transcription. Orbit pays a per-minute transcription bill for
   * every meeting, so unlike the rest of Capture (notes, voice, scans — all free), this is
   * paid on both tiers. `loadMeetingTranscript` and `discardMeetingSession` stay ungated so
   * a downgraded account can still read and delete meetings it already recorded — only
   * starting, resuming, ending and analyzing a NEW recording cost money.
   */
  canUseMeetings: boolean;
};

/** Feature keys that `requireEntitlement` can gate on. */
export type FeatureKey =
  | "outreach"
  | "hostedSending"
  | "hostedEnrichment"
  | "recruiters"
  | "sync"
  | "extension"
  | "api"
  | "meetings";

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

export type BillingColumns = {
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
 * state. Lifetime outranks subscription: an account holds one plan at a time, and buying
 * Lifetime ends Pro, so a subscription row left behind (canceled but not yet past its
 * period end) must never outrank the Lifetime that replaced it.
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
    canUseApi: paid,
    canUseMcp: true,
    canUseMeetings: paid,
  };
}

/** Every flag on and no contact cap, under whatever plan the account actually holds. */
function unrestrictedEntitlements(plan: Plan, source: PlanSource): Entitlements {
  return {
    ...entitlementsForPlan("orbit", source, { hostedEnrichment: true }),
    plan,
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
    // Demo accounts get every feature whatever their plan. `plan` and `source` stay as
    // resolved, deliberately: the showcase runs the upgrade (Ctrl+Shift+U → celebration)
    // from a free account, and the pricing surfaces should still tell the truth about
    // what was bought. Only the gates are lifted.
    if (isDemoAccount(userId)) return unrestrictedEntitlements(plan, source);
    // One plan at a time: a Lifetime holder resolves to Lifetime and gets Lifetime's flags,
    // even while a Pro subscription is still winding down. Buying Lifetime cancels Pro on
    // the spot (`endProForLifetime`), so the two are never meant to overlap; the resolver
    // no longer unions a lingering subscription's enrichment back in.
    const hostedEnrichment = plan === "orbit";
    return entitlementsForPlan(plan, source, { hostedEnrichment });
  }
);

export const FEATURE_DENIAL: Record<FeatureKey, string> = {
  outreach: "Outreach is available on Orbit Pro and Orbit Lifetime.",
  hostedSending:
    "Sending email and SMS on Orbit's credits is available on Orbit Pro and Orbit Lifetime.",
  hostedEnrichment:
    "Contact enrichment on Orbit's credits requires Orbit Pro. On any other plan, add your own Apollo key in Settings.",
  recruiters: "Recruiter tracking is available on Orbit Pro and Orbit Lifetime.",
  api: "The Orbit API and webhooks are available on Orbit Pro and Orbit Lifetime. Claude and ChatGPT connect on any plan, with no key.",
  sync: "Mailbox and calendar sync are available on Orbit Pro and Orbit Lifetime.",
  extension: "The Orbit extension is available on Orbit Pro and Orbit Lifetime.",
  meetings: "Meeting transcription is available on Orbit Pro and Orbit Lifetime.",
};

const FEATURE_FLAG: Record<FeatureKey, keyof Entitlements> = {
  outreach: "canUseOutreach",
  hostedSending: "canUseHostedSending",
  hostedEnrichment: "canUseHostedEnrichment",
  recruiters: "canUseRecruiters",
  sync: "canUseSync",
  extension: "canUseExtension",
  api: "canUseApi",
  meetings: "canUseMeetings",
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
