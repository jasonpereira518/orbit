import { cache } from "react";
import { isDemoAccount } from "@/lib/demo-account";
import { recordGateHit } from "@/lib/gate-events";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  FEATURE_KEYS,
  FREE_CONTACT_LIMIT,
  PLAN_CONFIG,
  PLAN_LABELS,
  unlockPlanFor,
  type FeatureKey,
  type Plan,
  type PlanSource,
} from "@/lib/plans/plan-config";

// Re-exported so server code keeps importing plan identity from this module, while
// client components can reach `plans/plan-config` directly without pulling in the database.
export {
  FEATURE_KEYS,
  FREE_CONTACT_LIMIT,
  PLAN_LABELS,
  type FeatureKey,
  type Plan,
  type PlanSource,
};

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
   * Whether Orbit's own Apollo key may be used for contact enrichment. Capped per month by
   * `PLAN_CONFIG[plan].hostedEnrichmentsPerMonth` (Pro 10, Max and Lifetime 25). A user's own
   * Apollo key, saved in Settings, is preferred over Orbit's on every plan and is uncapped.
   */
  canUseHostedEnrichment: boolean;
  canUseRecruiters: boolean;
  canUseSync: boolean;
  canUseExtension: boolean;
  /**
   * The public REST API and outbound webhooks. Max and Lifetime only. (MCP is separate —
   * see `canUseMcp` — and free on every plan.)
   *
   * A key of its own rather than folding into `canUseSync`, for two reasons. The denial copy
   * for sync says "Calendar subscriptions and event sources are available on…", which is
   * simply wrong on an API 402. More importantly `gate_events` is the only place demand for a
   * gated feature is observable, and the pricing question depends entirely on it — conflating
   * "someone wanted to connect Zapier" with "someone wanted a calendar subscription" destroys
   * exactly the signal that table exists to collect.
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
  /** AI on Orbit's provider keys, metered in credits. Pro and Max only. */
  canUseHostedAi: boolean;
  /** Buying a $5 top-up pack of credits. Pro and Max only. */
  canBuyCreditPacks: boolean;
  /** A second Google or Microsoft account. Free keeps its first connection. */
  canUseExtraConnections: boolean;
};


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
  compedPlan?: "orbit" | "max" | "lifetime" | null;
  lifetimePurchasedAt?: Date | null;
  subscriptionPlan?: "orbit" | "max" | null;
  subscriptionStatus?: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd?: Date | null;
};

/**
 * A canceled subscription keeps working until the period the user already paid for runs
 * out. `past_due` is also honoured until then — dunning is Clerk's job, and yanking access
 * on a transient card failure is the wrong response for a tool holding personal data.
 */
function subscriptionIsLive(row: BillingColumns, now: Date) {
  if (row.subscriptionPlan !== "orbit" && row.subscriptionPlan !== "max") return false;
  if (row.subscriptionStatus === "active") return true;
  if (!row.subscriptionPeriodEnd) return false;
  return row.subscriptionPeriodEnd.getTime() > now.getTime();
}

/**
 * Precedence: comp > lifetime > subscription > free.
 *
 * Comp wins outright so a manually granted account is never downgraded by stale billing
 * state. Lifetime outranks subscription: an account holds one plan at a time, and an admin
 * granting Lifetime to a subscriber sets their subscription to end at the period end, so
 * the subscription row still live until then must never outrank the Lifetime granted over it.
 */
export function resolvePlan(
  row: BillingColumns | null | undefined,
  now = new Date()
): { plan: Plan; source: PlanSource } {
  if (!row) return { plan: "free", source: "free" };
  if (row.compedPlan === "lifetime") return { plan: "lifetime", source: "comp" };
  if (row.compedPlan === "max") return { plan: "max", source: "comp" };
  if (row.compedPlan === "orbit") return { plan: "orbit", source: "comp" };
  if (row.lifetimePurchasedAt) return { plan: "lifetime", source: "lifetime" };
  if (subscriptionIsLive(row, now)) {
    return { plan: row.subscriptionPlan === "max" ? "max" : "orbit", source: "subscription" };
  }
  return { plan: "free", source: "free" };
}

/** Every flag and limit comes from `PLAN_CONFIG`; this only reshapes it for the gates. */
export function entitlementsForPlan(plan: Plan, source: PlanSource): Entitlements {
  const config = PLAN_CONFIG[plan];
  const f = config.features;
  return {
    plan,
    source,
    contactLimit: config.contactLimit,
    canUseOutreach: f.outreach,
    canUseHostedSending: f.hostedSending,
    canUseHostedEnrichment: f.hostedEnrichment,
    canUseRecruiters: f.recruiters,
    canUseSync: f.sync,
    canUseExtension: f.extension,
    canUseApi: f.api,
    canUseMcp: true,
    canUseMeetings: f.meetings,
    canUseHostedAi: f.hostedAi,
    canBuyCreditPacks: f.creditPacks,
    canUseExtraConnections: f.extraConnections,
  };
}

/** Every flag on and no contact cap, under whatever plan the account actually holds. */
function unrestrictedEntitlements(plan: Plan, source: PlanSource): Entitlements {
  return { ...entitlementsForPlan("max", source), plan };
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
  async (userId: string): Promise<Entitlements> =>
    entitlementsFromSettings(userId, await ensureUserSettings(userId))
);

/**
 * `getEntitlements` for a caller that already holds the account's `user_settings` row.
 *
 * `cache()` only deduplicates inside a React render. In a route handler or a Server Action
 * it is a pass-through, so a path that has just read the row (an API key check, say) and
 * then calls `getEntitlements` reads it again. Resolving from the row in hand is the same
 * computation on the same data, one round trip cheaper.
 */
export function entitlementsFromSettings(userId: string, row: BillingColumns): Entitlements {
  const { plan, source } = resolvePlan(row);
  // Demo accounts get every feature whatever their plan. `plan` and `source` stay as
  // resolved, deliberately: the showcase runs the upgrade (Ctrl+Shift+U → celebration)
  // from a free account, and the pricing surfaces should still tell the truth about
  // what was bought. Only the gates are lifted.
  if (isDemoAccount(userId)) return unrestrictedEntitlements(plan, source);
  // One plan at a time: a Lifetime holder resolves to Lifetime and gets Lifetime's flags,
  // even while a subscription is still winding down to its period end.
  return entitlementsForPlan(plan, source);
}

/** "on Orbit Pro and Orbit Max" or "on Orbit Max" — never Lifetime, which is not sold. */
function availableOn(feature: FeatureKey) {
  return unlockPlanFor(feature) === "orbit" ? "Orbit Pro and Orbit Max" : "Orbit Max";
}

export const FEATURE_DENIAL: Record<FeatureKey, string> = {
  outreach: `Outreach is available on ${availableOn("outreach")}.`,
  hostedSending: `Sending email and SMS on Orbit's credits is available on ${availableOn("hostedSending")}.`,
  hostedEnrichment: `Contact enrichment on Orbit's Apollo key is available on ${availableOn("hostedEnrichment")}. On the Free Plan, add your own Apollo key in Settings.`,
  recruiters: `Recruiter tracking is available on ${availableOn("recruiters")}.`,
  api: `The Orbit API and webhooks are available on ${availableOn("api")}. Claude and ChatGPT connect on any plan, with no key.`,
  sync: `Calendar subscriptions and event sources are available on ${availableOn("sync")}.`,
  extension: `The Orbit extension is available on ${availableOn("extension")}.`,
  meetings: `Meeting transcription is available on ${availableOn("meetings")}.`,
  hostedAi: `AI on Orbit's keys is included on ${availableOn("hostedAi")}. On the Free Plan, add your own AI key in Settings.`,
  creditPacks: `Credit packs are available on ${availableOn("creditPacks")}.`,
  extraConnections: `The Free Plan includes one Google or Microsoft account. Connecting more is available on ${availableOn("extraConnections")}.`,
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
  hostedAi: "canUseHostedAi",
  creditPacks: "canBuyCreditPacks",
  extraConnections: "canUseExtraConnections",
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
