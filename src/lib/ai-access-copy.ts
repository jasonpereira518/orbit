import type { AiAccessDenial } from "@/lib/managed-ai-policy";
import { FREE_STARTER_CREDITS, PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_LABEL } from "@/lib/stripe-config";

/**
 * What a person reads when the AI gate says no. Client-safe (imports only the pure plan-config module), so
 * `errors.ts` can list these in `OWN_WORDS` and the notices can render the same words.
 *
 * One constraint shapes the wording: all three refusals keep the words "API key". Seven call
 * sites test `isMissingAiApiKeyError` (`/api key/i`) to flip their UI into the notice state,
 * and every refusal should flip it — `aiDenialFromMessage` then tells the notice WHICH one,
 * by exact match, so out-of-credits shows packs and Max rather than "add a key".
 *
 * Out of credits is worded per plan, because what a person can do differs: `creditPacks`
 * (plan-config) says who can buy a pack, and only Free and Pro have a plan to move up to.
 * Free: pack or Pro. Pro: pack or Max. Max: pack. Lifetime: no pack, no plan above it. Every
 * variant keeps the own-key way out.
 *
 * `key_required` is the long-standing `MISSING_AI_API_KEY_MESSAGE`, reproduced here so a
 * gate refusal and the pre-gate code paths read identically.
 */
export const AI_ACCESS_COPY: Record<AiAccessDenial, string> = {
  key_required: "Add your AI API key in Settings to use this",
  // The plan-neutral wording (no pack, no plan move), for a refusal raised without a plan.
  // The gate always words it per plan through `refusalCopyFor`.
  managed_limit: "You’ve used your AI credits — add your own API key in Settings to keep going, or wait for them to refill",
  managed_unavailable:
    "Orbit’s AI isn’t available right now — add your own API key in Settings to keep going",
};

/** Orbit's own key was refused or throttled by the provider. The user can do nothing about it. */
export const MANAGED_PROVIDER_FAILURE_MESSAGE =
  "Orbit’s AI couldn’t answer just now — try again in a moment, or add your own API key in Settings";

/** At or below this many credits, a Free account sees "N AI credits left this month". */
export const FREE_LOW_CREDITS = 3;

const PACK = `${CREDIT_PACK_PRICE_LABEL} pack`;

/**
 * Out of credits, worded for what each plan can do about it. Keeps "API key" so
 * `isMissingAiApiKeyError` flips every notice, and `aiDenialFromMessage` maps each of these to
 * `managed_limit` by exact match.
 */
export const MANAGED_LIMIT_MESSAGES: Record<Plan, string> = {
  free: `You’ve used this month’s AI credits — add a ${PACK} or move to Pro in Settings, or use your own API key`,
  orbit: `You’ve used your AI credits — add a ${PACK} or move to Max in Settings, or use your own API key`,
  max: `You’ve used your AI credits — add a ${PACK} in Settings, or use your own API key`,
  lifetime: AI_ACCESS_COPY.managed_limit,
};

/** A Free account at zero. */
export const FREE_LIMIT_MESSAGE = MANAGED_LIMIT_MESSAGES.free;

/**
 * Background work on Orbit's key stopped at the floor that keeps the last credits for things a
 * person asks for. Credits remain, so it must not say they are used; `aiDenialFromMessage`
 * reads it as `managed_unavailable` (comes back on its own, or add a key).
 */
export const BACKGROUND_RESERVE_MESSAGE =
  "Orbit saves your last AI credits for things you ask for — add your own API key in Settings to keep going";

/** Every string above, for `OWN_WORDS`. */
export const AI_ACCESS_MESSAGES: readonly string[] = [
  ...Object.values(AI_ACCESS_COPY),
  MANAGED_PROVIDER_FAILURE_MESSAGE,
  ...Object.values(MANAGED_LIMIT_MESSAGES),
  BACKGROUND_RESERVE_MESSAGE,
];

/**
 * Which refusal a message a server action handed back is, so a client that only has the
 * error text can still render the right notice. Anything else mentioning an API key is the
 * plain "add a key" case — the same reading `isMissingAiApiKeyError` gives it.
 */
export function aiDenialFromMessage(message: string | null | undefined): AiAccessDenial | null {
  if (!message) return null;
  // `withReference` (errors.ts) appends " (ref xxxx)" to a reported failure; match the bare words.
  message = message.replace(/ \(ref [^)]*\)$/, "");
  for (const [reason, copy] of Object.entries(AI_ACCESS_COPY)) {
    if (message === copy) return reason as AiAccessDenial;
  }
  if (message === MANAGED_PROVIDER_FAILURE_MESSAGE || message === BACKGROUND_RESERVE_MESSAGE) return "managed_unavailable";
  if (Object.values(MANAGED_LIMIT_MESSAGES).includes(message)) return "managed_limit";
  return /api key/i.test(message) ? "key_required" : null;
}

/**
 * The notices' wording, per refusal. `verb` completes "…to {verb}". `offer` is the way out
 * besides a key: `upgrade` ("Pro and Max include AI", Free accounts only) or `credits`
 * ("Buy a pack ($5)", plus "Upgrade to Max" on Pro and "Compare plans" on Free). `managed_limit`
 * below is the no-pack wording (Lifetime); `noticeCopyFor` words it for the plans that can
 * buy a pack. Nothing is ever charged automatically.
 */
export const AI_NOTICE_COPY: Record<
  AiAccessDenial,
  { title: (verb: string) => string; body: string; offer: "upgrade" | "credits" | null; linkToKeys: boolean }
> = {
  key_required: {
    title: (verb) => `Add an AI API key to ${verb}`,
    body: "AI runs on your own Gemini, OpenAI, or Anthropic key.",
    offer: "upgrade",
    linkToKeys: true,
  },
  managed_limit: {
    title: () => "You’ve used your AI credits",
    body: "AI is paused until your allowance resets — nothing is charged automatically. To keep going now, add your own Gemini, OpenAI, or Anthropic key.",
    offer: null,
    linkToKeys: true,
  },
  managed_unavailable: {
    title: () => "Orbit’s AI isn’t available right now",
    body: "Included AI comes back on its own. To keep going now, add your own Gemini, OpenAI, or Anthropic key.",
    offer: null,
    linkToKeys: true,
  },
};

/** The one-line version, for hints under a field. */
export const AI_HINT_COPY: Record<AiAccessDenial, string> = {
  key_required: "Add an AI API key in Settings for summaries and action items",
  managed_limit: "Your AI credits are used — add your own API key in Settings for summaries",
  managed_unavailable: "Orbit’s AI is unavailable right now — add your own API key in Settings for summaries",
};

/** The plan to offer instead, for the plans that have one above them (Lifetime and Max do not). */
const NEXT_PLAN: Partial<Record<Plan, string>> = { free: "Orbit Pro", orbit: "Orbit Max" };

/** The one-line refusal for this reason on this plan: out of credits is worded for what the plan can do. */
export function refusalCopyFor(reason: AiAccessDenial | null, plan: Plan): string {
  if (reason === "managed_limit") return MANAGED_LIMIT_MESSAGES[plan];
  return AI_ACCESS_COPY[reason ?? "key_required"];
}

/** The field hint for this reason on this plan, same rule. */
export function hintCopyFor(reason: AiAccessDenial | null, plan: Plan): string {
  if (reason === "managed_limit" && PLAN_CONFIG[plan].features.creditPacks) {
    return `${plan === "free" ? "This month’s" : "Your"} AI credits are used — add a pack or your own API key in Settings for summaries`;
  }
  return AI_HINT_COPY[reason ?? "key_required"];
}

/** "October 1" — fixed locale and UTC, so server and client render the same string. */
export function formatAllowanceReset(resetsAt: string): string {
  return new Date(resetsAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export type NoticeCopy = { title: (verb: string) => string; body: string; offer: "upgrade" | "credits" | null; linkToKeys: boolean };

/**
 * The notice's words for this refusal on this plan. Out of credits on a plan that can buy a
 * pack offers one (and the plan above, where there is one); Free at zero also gets the refill
 * date. A plan with no packs (Lifetime) falls through to `AI_NOTICE_COPY`: key only.
 */
export function noticeCopyFor(reason: AiAccessDenial | null, plan: Plan, resetsAt: string | null): NoticeCopy {
  if (reason === "managed_limit" && PLAN_CONFIG[plan].features.creditPacks) {
    const free = plan === "free";
    const next = NEXT_PLAN[plan];
    return {
      title: () => (free ? "You’ve used this month’s AI credits" : "You’ve used your AI credits"),
      body: `${free ? `They refill on ${resetsAt ? formatAllowanceReset(resetsAt) : "the 1st"}` : "AI is paused until your allowance resets"} — nothing is charged automatically. To keep going now, add a pack of ${CREDIT_PACK_CREDITS} credits${next ? ` or move to ${next}` : ""}.`,
      offer: "credits",
      linkToKeys: true,
    };
  }
  return AI_NOTICE_COPY[reason ?? "key_required"];
}

/**
 * A refusal as one line, for places with no room for a notice (a failed background job).
 * Free out of credits gets the notice's refill date; anything else is the message as is.
 */
export function refusalWithRefill(message: string, plan: Plan, resetsAt: string | null): string {
  const reason = aiDenialFromMessage(message);
  if (reason !== "managed_limit" || plan !== "free") return message;
  const copy = noticeCopyFor(reason, plan, resetsAt);
  return `${copy.title("")}. ${copy.body.replace(/\.$/, "")}, or use your own API key in Settings`;
}

/** Share of this cycle's allowance used, 0-100. */
export function allowancePercentUsed(allowance: { granted: number; remaining: number }): number {
  if (allowance.granted <= 0) return 100;
  const used = allowance.granted - Math.max(0, allowance.remaining);
  return Math.min(100, Math.max(0, Math.round((used / allowance.granted) * 100)));
}

/** Settings → AI provider, top line, Free only. */
export const FREE_AI_EXPLAINER = `Free includes ${PLAN_CONFIG.free.monthlyCredits} AI credits a month and ${FREE_STARTER_CREDITS} to start. Add your own key to use AI with no limit`;
