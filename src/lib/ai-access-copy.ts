import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * What a person reads when the AI gate says no. Client-safe (no imports beyond a type), so
 * `errors.ts` can list these in `OWN_WORDS` and the notices can render the same words.
 *
 * One constraint shapes the wording: all three refusals keep the words "API key". Seven call
 * sites test `isMissingAiApiKeyError` (`/api key/i`) to flip their UI into the notice state,
 * and every refusal should flip it — `aiDenialFromMessage` then tells the notice WHICH one,
 * by exact match, so out-of-credits shows packs and Max rather than "add a key".
 *
 * `key_required` is the long-standing `MISSING_AI_API_KEY_MESSAGE`, reproduced here so a
 * gate refusal and the pre-gate code paths read identically.
 */
export const AI_ACCESS_COPY: Record<AiAccessDenial, string> = {
  key_required: "Add your AI API key in Settings to use this",
  managed_limit:
    "You’ve used your AI credits — add a $5 pack or move to Max in Settings, or use your own API key",
  managed_unavailable:
    "Orbit’s AI isn’t available right now — add your own API key in Settings to keep going",
};

/** Orbit's own key was refused or throttled by the provider. The user can do nothing about it. */
export const MANAGED_PROVIDER_FAILURE_MESSAGE =
  "Orbit’s AI couldn’t answer just now — try again in a moment, or add your own API key in Settings";

/** At or below this many credits, a Free account sees "N AI credits left this month". */
export const FREE_LOW_CREDITS = 3;

/**
 * A Free account at zero. Keeps "API key" so `isMissingAiApiKeyError` flips every notice, and
 * `aiDenialFromMessage` maps it to `managed_limit` by exact match.
 */
export const FREE_LIMIT_MESSAGE = "You’ve used this month’s AI credits — add your own API key in Settings for no limit";

/** Every string above, for `OWN_WORDS`. */
export const AI_ACCESS_MESSAGES: readonly string[] = [
  ...Object.values(AI_ACCESS_COPY),
  MANAGED_PROVIDER_FAILURE_MESSAGE,
  FREE_LIMIT_MESSAGE,
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
  if (message === FREE_LIMIT_MESSAGE) return "managed_limit";
  return /api key/i.test(message) ? "key_required" : null;
}

/**
 * The notices' wording, per refusal. `verb` completes "…to {verb}". `offer` is the way out
 * besides a key: `upgrade` ("Pro and Max include AI", Free accounts only) or `credits`
 * ("Buy a pack ($5)", plus "Upgrade to Max" on Pro). Nothing is ever charged automatically.
 */
export const AI_NOTICE_COPY: Record<
  AiAccessDenial,
  { title: (verb: string) => string; body: string; offer: "upgrade" | "credits" | null; linkToKeys: boolean }
> = {
  key_required: {
    title: (verb) => `Add an AI API key to ${verb}`,
    body: "On the Free Plan, AI runs on your own Gemini, OpenAI, or Anthropic key.",
    offer: "upgrade",
    linkToKeys: true,
  },
  managed_limit: {
    title: () => "You’ve used your AI credits",
    body: "AI is paused until your allowance resets — nothing is charged automatically. To keep going now, add a pack of 250 credits.",
    offer: "credits",
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
  managed_limit: "Your AI credits are used — add a pack or your own API key in Settings for summaries",
  managed_unavailable: "Orbit’s AI is unavailable right now — add your own API key in Settings for summaries",
};

/** "October 1" — fixed locale and UTC, so server and client render the same string. */
export function formatAllowanceReset(resetsAt: string): string {
  return new Date(resetsAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Share of this cycle's allowance used, 0-100. */
export function allowancePercentUsed(allowance: { granted: number; remaining: number }): number {
  if (allowance.granted <= 0) return 100;
  const used = allowance.granted - Math.max(0, allowance.remaining);
  return Math.min(100, Math.max(0, Math.round((used / allowance.granted) * 100)));
}
