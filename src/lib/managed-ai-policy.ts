import type { AiProvider, EmbeddingBackend } from "@/lib/ai-providers";
import { BACKGROUND_AI_OPERATIONS } from "@/lib/ai-operations";
import type { Plan } from "@/lib/plan-limits";

/**
 * Who may run AI on whose key — the whole rule, as pure functions.
 *
 * THE RULE. Every AI call runs on the user's own key (BYOK) unless the account is on Orbit
 * Lifetime, in which case Orbit's own managed key is used for any provider the user has not
 * brought a key for. A Lifetime user who HAS a key keeps using it: buying Lifetime never
 * silently moves someone's traffic onto a different key, and removing their key is the one
 * explicit way to switch to Orbit's. Orbit Pro is a subscription for the rest of the
 * product and is BYOK like Free — the rule is Lifetime or nothing.
 *
 * Demo accounts (every account on `next dev`, and the showcase account) count as Lifetime
 * here, the same exemption `getEntitlements` already gives them. On a laptop the "managed"
 * key is the developer's own `.env.local` key, which is exactly what local dev always used.
 *
 * Pure on purpose: no `@/db`, no `process.env`, no SDKs, so the decision can be pinned by a
 * smoke test without a database and imported by client components that explain it. The
 * module that ENFORCES it is `src/lib/ai-access.ts`, the only file allowed to hold a key.
 */

export type AiKeySource = "personal" | "managed";

/**
 * Why AI cannot run for this account right now.
 *
 *  - `key_required`         not on Lifetime and no key of their own for what was asked
 *  - `managed_unavailable`  on Lifetime, no key of their own, and Orbit has no managed key
 *                           configured for any provider (or the kill switch is on)
 *  - `managed_limit`        on Lifetime, no key of their own, and this month's managed
 *                           allowance is spent
 *  - `upgrade_pending`      a Lifetime payment exists but has not cleared yet
 */
export type AiAccessDenial =
  | "key_required"
  | "managed_unavailable"
  | "managed_limit"
  | "upgrade_pending";

/** Why an account may use Orbit's managed keys at all. Null = it may not. */
export type ManagedEligibility = "lifetime" | "demo" | null;

export function managedEligibility(plan: Plan, isDemo: boolean): ManagedEligibility {
  if (plan === "lifetime") return "lifetime";
  if (isDemo) return "demo";
  return null;
}

/**
 * The order Orbit reaches for its own keys when the user's chosen provider has none
 * configured. Cheapest first: the managed path is paid for once, at checkout, forever.
 */
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
};

export const MANAGED_DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};

export function managedModel(provider: AiProvider, requested: string | null | undefined): string {
  if (requested && MANAGED_MODELS[provider].includes(requested)) return requested;
  return MANAGED_DEFAULT_MODELS[provider];
}

/**
 * THE CAP. A one-time payment funding open-ended inference is only safe with a ceiling, so
 * every managed call counts against a monthly allowance per account (calendar month, UTC).
 *
 * The NUMBERS are a pricing decision, not an engineering one. Jason chose $1.00 a month on
 * Sep 16 2026 (over $0.50 and $2.50), sized as roughly 140 chat answers or 200 note captures
 * on Gemini 3.5 Flash. That sizing used a price table that had 3.5 Flash at $0.30/$2.50;
 * Google charges $1.50/$9.00, and thinking tokens (billed as output) were not counted at
 * all. So the "$1" cap was really letting ~$4–5 of provider spend through.
 *
 * On Sep 19 2026 Jason chose to KEEP that call count rather than shrink it: the prices were
 * corrected and the cap raised to $5.00 as an interim figure, pending measurement.
 *
 * It is now MEASURED. The eval (docs/ai-evals/, Sep 19 2026) puts a chat answer — question
 * understanding, reranking, the embedding and the answer itself — at about $0.0025 on the
 * managed default, and a note capture at about $0.0086. The promise in the line above,
 * ~140 answers or ~200 captures, therefore costs about $0.35 or about $1.72, so $2.00
 * covers either with room and the cap comes back DOWN from the interim $5.00. At $2.00 of
 * maximal use a month the $25 intro price covers a year and the $75 standard price three;
 * typical use is far lower, and the runway alert below watches the aggregate. Change it
 * here, and only here.
 *
 *  - `monthlyCostMicros`  estimated provider spend, from `usage_events.estimated_cost_micros`
 *  - `monthlyCalls`       a runaway-loop guard that holds even where cost is unknown
 *  - `backgroundShare`    how much of the month bulk background work may use, so a 3,000-row
 *                         LinkedIn import cannot spend the allowance a person needs for chat
 */
export const MANAGED_AI_BUDGET = {
  monthlyCostMicros: 2_000_000,
  monthlyCalls: 2_000,
  backgroundShare: 0.5,
} as const;

export type ManagedBudget = {
  monthlyCostMicros: number;
  monthlyCalls: number;
  backgroundShare: number;
};

/**
 * What an UNPRICED managed call is charged against the allowance, by kind.
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
 * Operations that are bulk work running on the user's behalf rather than something they
 * are waiting on. They stop at `backgroundShare` of the allowance.
 */
export const BACKGROUND_OPERATIONS: ReadonlySet<string> = BACKGROUND_AI_OPERATIONS;

/**
 * When the ops sweep speaks up about managed spend (`src/lib/ops-alerts.ts`).
 *
 * The per-account cap bounds any ONE account; these watch the aggregate, which the cap
 * bounds only by `accounts × cap`. `runwayYears` is the unit-economics line: if the last 30
 * days' managed spend, annualised, would consume every Lifetime dollar ever booked in fewer
 * than this many years, the pricing is not covering the promise. `dailySpikeMicros` is five
 * accounts' whole monthly allowance in one day; it moves with the cap.
 */
export const MANAGED_AI_ALERTS = {
  dailySpikeMicros: 10_000_000,
  runwayYears: 4,
  /** Below this 30-day spend the runway figure is noise, not a trend. */
  runwayMinSpendMicros: 1_000_000,
} as const;

/** The current allowance window: this calendar month in UTC. */
export function managedWindow(now: Date): { start: Date; resetsAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}

export type ManagedUsage = { spentMicros: number; calls: number };

export type ManagedAllowance = ManagedUsage & {
  limitMicros: number;
  callLimit: number;
  /** ISO timestamp — the allowance crosses the server/client boundary as a string. */
  resetsAt: string;
};

/** Whether one more managed call fits. Background work gets only its share. */
export function managedCallAllowed(
  usage: ManagedUsage,
  operation: string,
  budget: ManagedBudget = MANAGED_AI_BUDGET,
): boolean {
  const share = BACKGROUND_OPERATIONS.has(operation) ? budget.backgroundShare : 1;
  return (
    usage.spentMicros < budget.monthlyCostMicros * share &&
    usage.calls < budget.monthlyCalls * share
  );
}

/* ------------------------------------------------------------------ key selection ------ */

/**
 * What an account has to work with, as presence only. The enforcement module fills this
 * from decrypted keys; the notifications panel fills it from `IS NOT NULL` — the decision is
 * the same function either way, which is what keeps the alert and the gate from disagreeing.
 */
export type KeyFacts = {
  eligibility: ManagedEligibility;
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
 * Denial for "nothing usable". Only a real Lifetime account was PROMISED Orbit's AI, so only
 * it hears "Orbit's AI isn't available"; a demo account with no local key is simply missing
 * one, like anybody else.
 */
export function nothingUsable(
  eligibility: ManagedEligibility,
): { ok: false; reason: "key_required" | "managed_unavailable" } {
  return { ok: false, reason: eligibility === "lifetime" ? "managed_unavailable" : "key_required" };
}

function denied(facts: KeyFacts) {
  return nothingUsable(facts.eligibility);
}

/**
 * Chat, capture parsing, drafts, briefs — anything that runs "the user's model".
 *
 * Their own key for their chosen provider wins, at their chosen model. Otherwise, only for
 * an eligible account, Orbit's key: the chosen provider if Orbit holds one, else the
 * cheapest provider Orbit does hold, at a managed model. A key they saved for some OTHER
 * provider is not used for completions — same as before this module existed; the provider
 * they picked is the one they are shown.
 */
export function chooseCompletionKey(facts: KeyFacts): KeyChoice {
  const selected = facts.selectedProvider;
  if (facts.personal[selected]) {
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

const EMBEDDING_ORDER: readonly EmbeddingBackend[] = ["openai", "gemini"];

/**
 * Search embeddings. Anthropic has none, so an Anthropic user embeds with OpenAI or Gemini.
 *
 * Any personal OpenAI/Gemini key beats any managed one — the chosen provider first — so the
 * embedding space only moves onto Orbit's key when the user has nothing of their own.
 */
export function chooseEmbeddingKey(facts: KeyFacts): KeyChoice<EmbeddingBackend> {
  const selected = facts.selectedProvider;
  const order: EmbeddingBackend[] =
    selected === "anthropic"
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
 * One named provider, for chains that walk several (transcription: Wispr, Whisper, Gemini).
 * Null when neither the user nor, for an eligible account, Orbit has a key for it.
 */
export function chooseProviderKey(
  facts: Pick<KeyFacts, "eligibility"> & {
    personal: Partial<Record<string, boolean>>;
    managed: Partial<Record<string, boolean>>;
  },
  provider: string,
): AiKeySource | null {
  if (facts.personal[provider]) return "personal";
  if (facts.eligibility && facts.managed[provider]) return "managed";
  return null;
}

/**
 * Whether AI would run at all, before any allowance is consulted — the question every
 * "add your key" notice asks. Presence only; never needs a decrypted key.
 */
export function aiReadyFromFacts(facts: KeyFacts): boolean {
  return chooseCompletionKey(facts).ok;
}
