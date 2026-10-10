import type { AiProvider, EmbeddingBackend } from "@/lib/ai-providers";
import { BACKGROUND_AI_OPERATIONS } from "@/lib/ai-operations";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";

/**
 * Who may run AI on whose key — the whole rule, as pure functions.
 *
 * THE RULE (pricing v2, Sprint B). Free gets a small monthly allowance plus a one-time starter
 * on Orbit's own provider keys; Orbit Pro and Orbit Max include more. All of it is metered in
 * credits (`src/lib/credits/`). Orbit Lifetime is every Max entitlement EXCEPT this one: its
 * AI runs on its own key only.
 *
 * A paid account may still save its own key. Which one runs by default is the account's
 * choice (`user_settings.ai_key_preference`): `included` puts Orbit's key first, `own` the
 * saved key; unset keeps the pre-v2 behaviour, where a saved key wins — nobody who added a
 * key has their traffic silently moved. Calls on the account's own key never use credits.
 *
 * Demo accounts on `next dev` count as eligible and run unmetered on the developer's own
 * `.env.local` keys. A DEPLOYED demo (the showcase account) is NOT exempt: it follows the
 * plan it actually holds, so it cannot spend Orbit's money without credits.
 *
 * Pure on purpose: no `@/db`, no `process.env`, no SDKs, so the decision can be pinned by a
 * smoke test without a database and imported by client components that explain it. The
 * module that ENFORCES it is `src/lib/ai-access.ts`, the only file allowed to hold a key.
 */

export type AiKeySource = "personal" | "managed";

/**
 * MANAGED AI IS ON (pricing v2). A code constant rather than an env var, so no deployment
 * flips the model by accident. Two switches still stop it without a deploy: the
 * `ORBIT_MANAGED_AI=off` env kill switch and the admin console's runtime pause
 * (`site_settings.managed_ai_paused`, which reads as PAUSED in production until set — the
 * legal text describing managed AI has to ship first).
 */
export const MANAGED_AI_ENABLED: boolean = true;

/**
 * Why AI cannot run for this account right now.
 *
 *  - `key_required`         Lifetime (or an account whose included AI is paused)
 *                           with no key of their own for what was asked
 *  - `managed_unavailable`  Free, Pro or Max, no key of their own, and Orbit holds no managed key
 *                           for any provider right now
 *  - `managed_limit`        Free, Pro or Max on Orbit's key, and the credits are spent: the hard
 *                           stop. Buy a pack, upgrade to Max, or use your own key.
 */
export type AiAccessDenial = "key_required" | "managed_unavailable" | "managed_limit";

/** Why an account may use Orbit's managed keys at all. Null = it may not. */
export type ManagedEligibility = "plan" | "demo" | null;

export function managedEligibility(plan: Plan, isDemo: boolean): ManagedEligibility {
  if (isDemo) return "demo";
  if (MANAGED_AI_ENABLED && PLAN_CONFIG[plan].features.hostedAi) return "plan";
  return null;
}

/** Which key runs by default when an eligible account has both. Null = the saved key wins. */
export type AiKeyPreference = "included" | "own" | null;

/**
 * The order Orbit reaches for its own keys when the user's chosen provider has none
 * configured. Cheapest first: the managed path is paid for once, at checkout, forever.
 */
// OpenRouter is deliberately absent: Orbit holds no OpenRouter key, so it is never a managed
// provider, and this order is exactly the set of providers Orbit will ever pay for.
export const MANAGED_PROVIDER_ORDER: readonly AiProvider[] = ["gemini", "openai", "anthropic"];

/**
 * Models the managed key will run. A Lifetime user can type any model id into Settings, and
 * on their own key that is their business; on Orbit's key, `claude-opus-4` would spend a
 * month's allowance in a handful of questions. Anything off this list runs on the provider's
 * managed default instead. Every entry must be priced in `ai-pricing.ts` — an unpriced model
 * would record no cost and slip under the dollar cap (`smoke-ai-access.ts` enforces this).
 */
export const MANAGED_MODELS: Record<AiProvider, readonly string[]> = {
  gemini: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
  openai: ["gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5"],
  // Unreachable: MANAGED_PROVIDER_ORDER excludes openrouter, so this arm exists only to
  // satisfy the Record — Orbit never selects it as a managed provider.
  openrouter: [],
};

export const MANAGED_DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  // Unreachable for the same reason as MANAGED_MODELS.openrouter above.
  openrouter: "google/gemini-3.8-flash",
};

export function managedModel(provider: AiProvider, requested: string | null | undefined): string {
  // The allowlist protects Orbit's money. With managed AI off the only key behind this path
  // is the developer's own, so `next dev` keeps running whatever model Settings asks for.
  if (!MANAGED_AI_ENABLED) return requested || MANAGED_DEFAULT_MODELS[provider];
  if (requested && MANAGED_MODELS[provider].includes(requested)) return requested;
  return MANAGED_DEFAULT_MODELS[provider];
}

/**
 * What an UNPRICED managed call is charged against the credits, by kind.
 *
 * Two providers report no usage: Whisper bills per second of audio and returns no usage
 * object, and Gemini's embed endpoint returns no metadata. `usage_events` stores null for
 * those — honest in the ledger — but a null that counts as zero would let meeting
 * transcription run free forever. These are deliberately pessimistic stand-ins: a Whisper
 * chunk is billed as a full minute ($0.006), an embedding as a long passage.
 */
export const UNPRICED_CALL_MICROS: Record<"transcription" | "embedding" | "other", number> = {
  transcription: 6_000,
  embedding: 50,
  other: 2_000,
};

/**
 * Operations that are bulk work running on the user's behalf rather than something they are
 * waiting on. On Orbit's key they may only spend while MORE than `BACKGROUND_FLOOR_SHARE` of
 * the plan's monthly allowance is still spendable — so a 3,000-row import can never spend the
 * credits a person needs for chat and capture.
 */
export const BACKGROUND_OPERATIONS: ReadonlySet<string> = BACKGROUND_AI_OPERATIONS;
export const BACKGROUND_FLOOR_SHARE = 0.5;

/**
 * What a managed call holds against the balance while it runs, by the operation's tier —
 * a little above the measured typical cost (docs/ai-evals: a chat answer ≈ $0.0025, a capture
 * ≈ $0.0086), so near zero the hard stop errs toward refusing rather than overshooting.
 * Settlement always charges the real cost.
 */
export function holdEstimateMicros(tier: string | undefined): number {
  switch (tier) {
    case "embed":
      return 1_000;
    case "fast":
    case "decision":
      return 5_000;
    case "transcribe":
      return 20_000;
    case "vision":
      return 30_000;
    default:
      return 20_000;
  }
}

/**
 * When the ops sweep speaks up about managed spend (`src/lib/ops-alerts.ts`).
 *
 * Credits bound any ONE account; these watch the aggregate. `maxCostShare` is the
 * unit-economics line: if the last 30 days of managed AI cost more than this share of the
 * last 30 days of subscription and pack revenue, the allowances are not covered by the
 * prices. `dailySpikeMicros` is fifty Pro allowances in one day.
 */
export const MANAGED_AI_ALERTS = {
  dailySpikeMicros: 10_000_000,
  maxCostShare: 0.5,
  /** Below this 30-day spend the margin figure is noise, not a trend. */
  runwayMinSpendMicros: 1_000_000,
} as const;

/** A calendar month in UTC — the window the ops sweep reports managed spend over. */
export function managedWindow(now: Date): { start: Date; resetsAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}

/* ------------------------------------------------------------------ key selection ------ */

/**
 * What an account has to work with, as presence only. The enforcement module fills this
 * from decrypted keys; the notifications panel fills it from `IS NOT NULL` — the decision is
 * the same function either way, which is what keeps the alert and the gate from disagreeing.
 */
export type KeyFacts = {
  eligibility: ManagedEligibility;
  /** The account's default when it could use either key. */
  preference?: AiKeyPreference;
  selectedProvider: AiProvider;
  /** The model already resolved for the selected provider (`resolveAiModel`). */
  selectedModel: string;
  personal: Record<AiProvider, boolean>;
  /** Which managed keys this deployment holds. All false when the kill switch is on. */
  managed: Record<AiProvider, boolean>;
};

export type KeyChoice<P extends string = AiProvider> =
  | { ok: true; provider: P; source: AiKeySource; model: string }
  | { ok: false; reason: Extract<AiAccessDenial, "key_required" | "managed_unavailable"> };

function anyManaged(facts: KeyFacts) {
  return MANAGED_PROVIDER_ORDER.some((p) => facts.managed[p]);
}

/**
 * Denial for "nothing usable". Only a Pro or Max account was PROMISED Orbit's AI, so only it
 * hears "Orbit's AI isn't available"; a demo account with no local key is simply missing
 * one, like anybody else.
 */
export function nothingUsable(
  eligibility: ManagedEligibility,
): { ok: false; reason: "key_required" | "managed_unavailable" } {
  return { ok: false, reason: eligibility === "plan" ? "managed_unavailable" : "key_required" };
}

function denied(facts: KeyFacts) {
  return nothingUsable(facts.eligibility);
}

/**
 * Chat, capture parsing, drafts, briefs — anything that runs "the user's model".
 *
 * Their own key for their chosen provider wins, at their chosen model — unless an eligible
 * account has chosen `included`, in which case Orbit's key comes first. Otherwise, only for
 * an eligible account, Orbit's key: the chosen provider if Orbit holds one, else the
 * cheapest provider Orbit does hold, at a managed model. A key they saved for some OTHER
 * provider is not used for completions; the provider they picked is the one they are shown.
 */
export function chooseCompletionKey(facts: KeyFacts): KeyChoice {
  const selected = facts.selectedProvider;
  const includedFirst = facts.preference === "included" && Boolean(facts.eligibility) && anyManaged(facts);
  if (facts.personal[selected] && !includedFirst) {
    return { ok: true, provider: selected, source: "personal", model: facts.selectedModel };
  }
  if (!facts.eligibility || !anyManaged(facts)) return denied(facts);
  const provider = facts.managed[selected]
    ? selected
    : MANAGED_PROVIDER_ORDER.find((p) => facts.managed[p])!;
  return {
    ok: true,
    provider,
    source: "managed",
    model: managedModel(provider, provider === selected ? facts.selectedModel : null),
  };
}

/**
 * Personal-key preference for embeddings, cheapest usable first.
 *
 * `openrouter` is LAST on purpose, and it is the one member that is not preferred when it
 * is the selected provider. Stored vectors carry no record of which backend wrote them, and
 * `saveAiSettings` reacts to a backend change by DELETING every `contact_embeddings` row so
 * the two spaces are never compared. That is correct, and it is also a full re-index paid
 * for in the person's own API spend — not something to hand someone for pressing Connect.
 * So an account that already has a Gemini or OpenAI key keeps embedding with it, and
 * OpenRouter embeds only for an account that has nothing else.
 */
const EMBEDDING_ORDER: readonly EmbeddingBackend[] = ["openai", "gemini", "openrouter"];

/**
 * Search embeddings. Anthropic has none, so an Anthropic user embeds with OpenAI or Gemini.
 *
 * Any personal OpenAI/Gemini key beats any managed one — the chosen provider first — so the
 * embedding space only moves onto Orbit's key when the user has nothing of their own. The
 * `included` preference deliberately does NOT apply here: stored vectors are tied to their
 * backend, and moving them means deleting and re-embedding the whole index.
 */
export function chooseEmbeddingKey(facts: KeyFacts): KeyChoice<EmbeddingBackend> {
  const selected = facts.selectedProvider;
  // Anthropic has no embeddings API at all, and OpenRouter must not displace an existing
  // key (see EMBEDDING_ORDER) — so neither is promoted to the front.
  const order: EmbeddingBackend[] =
    selected === "anthropic" || selected === "openrouter"
      ? [...EMBEDDING_ORDER]
      : [selected, ...EMBEDDING_ORDER.filter((p) => p !== selected)];

  const personal = order.find((p) => facts.personal[p]);
  if (personal) return { ok: true, provider: personal, source: "personal", model: "" };
  if (!facts.eligibility) return { ok: false, reason: "key_required" };
  // Gemini's managed key embeds too, and is the cheaper of the two.
  const managedOrder: EmbeddingBackend[] =
    selected === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];
  const managed = managedOrder.find((p) => facts.managed[p]);
  if (managed) return { ok: true, provider: managed, source: "managed", model: "" };
  return denied(facts);
}

/**
 * Whether AI would run at all, before any allowance is consulted — the question every
 * "add your key" notice asks. Presence only; never needs a decrypted key.
 */
export function aiReadyFromFacts(facts: KeyFacts): boolean {
  return chooseCompletionKey(facts).ok;
}
