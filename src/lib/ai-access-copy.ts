import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * What a person reads when the AI gate says no. Client-safe (no imports beyond a type), so
 * `errors.ts` can list these in `OWN_WORDS` and the notices can render the same words.
 *
 * Two constraints shape the wording:
 *
 *  - `key_required`, `managed_limit` and `managed_unavailable` all end in the same remedy —
 *    add your own key — so they keep the words "API key". That is load-bearing: seven call
 *    sites test `isMissingAiApiKeyError` (`/api key/i`) to flip their UI into the "add a key"
 *    state, and those three states should flip it.
 *  - `upgrade_pending` must NOT say "API key". A key is not what that person is missing, and
 *    flipping their capture page into "add a key" moments after they paid would be the
 *    exact confusing error this state exists to prevent.
 *
 * `key_required` is the long-standing `MISSING_AI_API_KEY_MESSAGE`, reproduced here so a
 * gate refusal and the pre-gate code paths read identically.
 */
export const AI_ACCESS_COPY: Record<AiAccessDenial, string> = {
  key_required: "Add your AI API key in Settings to use this",
  managed_limit:
    "You’ve used this month’s included AI on Orbit Lifetime — add your own API key in Settings to keep going",
  managed_unavailable:
    "Orbit’s AI isn’t available right now — add your own API key in Settings to keep going",
  upgrade_pending:
    "Your Lifetime payment is still clearing — Orbit’s AI switches on the moment it does",
};

/** Orbit's own key was refused or throttled by the provider. The user can do nothing about it. */
export const MANAGED_PROVIDER_FAILURE_MESSAGE =
  "Orbit’s AI couldn’t answer just now — try again in a moment, or add your own API key in Settings";

/** Every string above, for `OWN_WORDS`. */
export const AI_ACCESS_MESSAGES: readonly string[] = [
  ...Object.values(AI_ACCESS_COPY),
  MANAGED_PROVIDER_FAILURE_MESSAGE,
];

/**
 * Which refusal a message a server action handed back is, so a client that only has the
 * error text can still render the right notice. Anything else mentioning an API key is the
 * plain "add a key" case — the same reading `isMissingAiApiKeyError` gives it.
 */
export function aiDenialFromMessage(message: string | null | undefined): AiAccessDenial | null {
  if (!message) return null;
  for (const [reason, copy] of Object.entries(AI_ACCESS_COPY)) {
    if (message === copy) return reason as AiAccessDenial;
  }
  if (message === MANAGED_PROVIDER_FAILURE_MESSAGE) return "managed_unavailable";
  return /api key/i.test(message) ? "key_required" : null;
}

/** The notices' wording, per refusal. `verb` completes "…to {verb}". */
export const AI_NOTICE_COPY: Record<
  AiAccessDenial,
  { title: (verb: string) => string; body: string; offerLifetime: boolean; linkToKeys: boolean }
> = {
  key_required: {
    title: (verb) => `Add an AI API key to ${verb}`,
    body: "Orbit runs AI on your own Gemini, OpenAI, or Anthropic key, at cost and never marked up.",
    offerLifetime: true,
    linkToKeys: true,
  },
  managed_limit: {
    title: () => "You’ve used this month’s included AI",
    body: "Orbit Lifetime’s AI allowance resets on the 1st. To keep going now, add your own Gemini, OpenAI, or Anthropic key — Orbit uses yours whenever one is saved.",
    offerLifetime: false,
    linkToKeys: true,
  },
  managed_unavailable: {
    title: () => "Orbit’s AI isn’t available right now",
    body: "Your Lifetime AI comes back on its own. To keep going now, add your own Gemini, OpenAI, or Anthropic key.",
    offerLifetime: false,
    linkToKeys: true,
  },
  upgrade_pending: {
    title: () => "Your Lifetime upgrade is almost done",
    body: "Your payment is still clearing. Orbit’s AI switches on the moment it does — there’s nothing to add.",
    offerLifetime: false,
    linkToKeys: false,
  },
};

/** The one-line version, for hints under a field. */
export const AI_HINT_COPY: Record<AiAccessDenial, string> = {
  key_required: "Add an AI API key in Settings for summaries and action items",
  managed_limit: "This month’s included AI is used — add your own API key in Settings for summaries",
  managed_unavailable: "Orbit’s AI is unavailable right now — add your own API key in Settings for summaries",
  upgrade_pending: "Summaries switch on the moment your Lifetime payment clears",
};

/** "October 1" — fixed locale and UTC, so server and client render the same string. */
export function formatAllowanceReset(resetsAt: string): string {
  return new Date(resetsAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Share of the month's allowance used, 0-100, by whichever of cost and calls is further along. */
export function allowancePercentUsed(allowance: {
  spentMicros: number;
  limitMicros: number;
  calls: number;
  callLimit: number;
}): number {
  const byCost = allowance.limitMicros > 0 ? allowance.spentMicros / allowance.limitMicros : 1;
  const byCalls = allowance.callLimit > 0 ? allowance.calls / allowance.callLimit : 1;
  return Math.min(100, Math.round(Math.max(byCost, byCalls) * 100));
}
