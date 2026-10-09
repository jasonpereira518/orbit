// Types only at the top: the SDKs themselves load on the first client built. This module is
// reached by most server routes (the app layout, the app pulse, health), and evaluating three
// provider SDKs — @google/genai pulls google-auth-library, protobufjs and ws — was part of
// every cold start for routes that never make a model call.
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings, usageEvents, userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { decryptOrNull } from "@/lib/crypto";
import { isDemoAccount, isLocalhost } from "@/lib/demo-account";
import { resolvePlan, type BillingColumns } from "@/lib/entitlements";
import { classifyAiError } from "@/lib/errors";
import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { AI_OPERATIONS } from "@/lib/ai-operations";
import {
  creditPeriodFor,
  ensureAllowance,
  getCreditBalance,
  packsUsable,
  placeHold,
  type CreditBalance,
} from "@/lib/credits/ledger";
import { creditsToMicros } from "@/lib/credits/grants";
import {
  AI_PROVIDERS,
  resolveAiModel,
  resolveAiProvider,
  type AiProvider,
  type EmbeddingBackend,
} from "@/lib/ai-providers";
import { AI_ACCESS_COPY, FREE_LIMIT_MESSAGE, MANAGED_PROVIDER_FAILURE_MESSAGE } from "@/lib/ai-access-copy";
import { JEV_MODEL } from "@/lib/ai-models";
import { deepgramEnabled } from "@/lib/deepgram";
import { speechAllowance } from "@/lib/speech-quota";
import {
  systemOneRequest,
  type SystemOneRequest,
  type SystemOneResponse,
} from "@/lib/typesafe-api";
import {
  chooseCompletionKey,
  chooseEmbeddingKey,
  holdEstimateMicros,
  managedEligibility,
  managedModel,
  nothingUsable,
  BACKGROUND_FLOOR_SHARE,
  BACKGROUND_OPERATIONS,
  MANAGED_AI_ENABLED,
  MANAGED_PROVIDER_ORDER,
  UNPRICED_CALL_MICROS,
  type AiAccessDenial,
  type AiKeyPreference,
  type AiKeySource,
  type KeyFacts,
  type ManagedEligibility,
} from "@/lib/managed-ai-policy";

/**
 * THE AI GATE — the single place Orbit decides whose key pays for an AI call.
 *
 * Every provider call in the product goes through `src/lib/ai.ts`, and `ai.ts` cannot build
 * a provider client on its own: the three SDK constructors are imported HERE and nowhere
 * else, and the only way to get a client is to hand `geminiClient` / `openaiClient` /
 * `anthropicClient` a grant this module minted. The raw key lives in a module-private
 * `WeakMap` keyed by the grant object, so a grant cannot be forged with a cast or rebuilt
 * from its fields, and the key string never reaches the caller. `scripts/smoke-ai-access.ts`
 * fails the suite if any other file imports an AI SDK or reads an AI key from the
 * environment.
 *
 * The rule itself (who may use which key) is pure and lives in `managed-ai-policy.ts`. This
 * module adds the three things that need I/O:
 *
 *  1. Loading the account — keys and billing columns in ONE `user_settings` read, so the
 *     plan is re-resolved on every call. There is no cached "is Lifetime" anywhere: a refund,
 *     a revoked comp or an upgrade takes effect on the very next AI call, in every tab and in
 *     every background job.
 *  2. The managed allowance (`usage_events` for this account, `key_owner = 'orbit'`, this
 *     month), checked before any managed grant is minted.
 *
 * Refusals are `AiAccessError`s with a typed `reason` and copy from `ai-access-copy.ts`.
 * Nothing here ever substitutes Orbit's key for a user who is not entitled to it; there is
 * no "just this once" path, and no environment in which a non-eligible account reaches one.
 */

/* --------------------------------------------------------------------- errors ------- */

export class AiAccessError extends Error {
  readonly reason: AiAccessDenial;

  constructor(reason: AiAccessDenial, message: string = AI_ACCESS_COPY[reason]) {
    super(message);
    this.name = "AiAccessError";
    this.reason = reason;
  }
}

export function isAiAccessError(err: unknown): err is AiAccessError {
  // `name` as well as `instanceof`, for the same second-module-instance reason as
  // `UserFacingError` in errors.ts.
  return err instanceof AiAccessError || (err instanceof Error && err.name === "AiAccessError");
}

/* ------------------------------------------------------------------ managed keys ----- */

const MANAGED_ENV: Record<AiProvider, string> = {
  gemini: "ORBIT_MANAGED_GEMINI_API_KEY",
  openai: "ORBIT_MANAGED_OPENAI_API_KEY",
  anthropic: "ORBIT_MANAGED_ANTHROPIC_API_KEY",
  // Never read: MANAGED_PROVIDER_ORDER excludes openrouter, so managedKey() never looks this
  // name up. Present only to satisfy the Record — Orbit holds no OpenRouter key.
  openrouter: "ORBIT_MANAGED_OPENROUTER_API_KEY",
};

/**
 * The names local development always used. Honoured OFF Vercel only, and — the change —
 * only as a MANAGED key: before the gate, a developer's `GEMINI_API_KEY` paid for any
 * account at all when a tsx script ran against a shared database; now it pays only for the
 * accounts the policy says Orbit pays for.
 */
const LOCAL_ENV: Record<AiProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  // Never read as a MANAGED key, for the same reason as MANAGED_ENV.openrouter above — but
  // named to match anyway, in case something outside the gate ever reads it directly.
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * TypeSafe (Jev, the decision model) is BYOK only — Jason's call, Sep 21 2026 — so it has no
 * managed name at all. This one is read on a dev server alone, like `LOCAL_ENV`.
 */
const LOCAL_TYPESAFE_ENV = "TYPESAFE_API_KEY";

/**
 * `ORBIT_JEV=off` — the decision model's emergency stop. Every decision call site falls
 * back to the path it had before Jev, so switching it off loses speed and savings, never a
 * feature.
 */
export function jevSwitchedOff(): boolean {
  return process.env.ORBIT_JEV?.trim().toLowerCase() === "off";
}

/**
 * `ORBIT_MANAGED_AI=off` — the env emergency stop. Pro and Max fall back to "add your own
 * key". Wins over the admin console's runtime switch below.
 */
export function managedAiSwitchedOff(): boolean {
  if (!MANAGED_AI_ENABLED) return true;
  return process.env.ORBIT_MANAGED_AI?.trim().toLowerCase() === "off";
}

/**
 * The admin console's runtime switch (`site_settings.managed_ai_paused`), cached for 30s per
 * server instance so it costs one read per instance, not per call. Unset reads as PAUSED on
 * production — managed AI must not run before the legal text describing it ships — and as
 * running everywhere else. A read failure keeps the last answer, or pauses if there is none.
 */
const PAUSE_TTL_MS = 30_000;
let pauseCache: { paused: boolean; at: number } | null = null;

export function managedAiPausedDefault(): boolean {
  return process.env.VERCEL_ENV === "production";
}

export async function managedAiPaused(now = Date.now()): Promise<boolean> {
  if (pauseCache && now - pauseCache.at < PAUSE_TTL_MS) return pauseCache.paused;
  try {
    const db = await getDb();
    const [row] = await db
      .select({ paused: siteSettings.managedAiPaused })
      .from(siteSettings)
      .where(eq(siteSettings.id, 1))
      .limit(1);
    const paused = row?.paused ?? managedAiPausedDefault();
    pauseCache = { paused, at: now };
    return paused;
  } catch {
    return pauseCache?.paused ?? true;
  }
}

/** For the admin switch: forget the cached answer so this instance sees the change at once. */
export function forgetManagedAiPause() {
  pauseCache = null;
}

function managedKey(provider: AiProvider): string | null {
  if (managedAiSwitchedOff()) return null;
  const explicit = process.env[MANAGED_ENV[provider]]?.trim();
  if (explicit) return explicit;
  if (!process.env.VERCEL) return process.env[LOCAL_ENV[provider]]?.trim() || null;
  return null;
}

/** Which providers this deployment can pay for. Presence only. */
export function managedKeysConfigured(): Record<AiProvider, boolean> {
  return {
    gemini: Boolean(managedKey("gemini")),
    openai: Boolean(managedKey("openai")),
    anthropic: Boolean(managedKey("anthropic")),
    // Orbit holds no OpenRouter key — never a managed provider (managed-ai-policy.ts).
    openrouter: false,
  };
}

/** The env var an operator sets for a provider's managed key — for Settings and the runbook. */
export function managedEnvVar(provider: AiProvider): string {
  return MANAGED_ENV[provider];
}

/**
 * LOCALHOST ONLY — `next dev` runs AI on the keys in the developer's own `.env.local`, the
 * way local development always worked, unmetered. Two conditions, neither settable by a
 * deployment: the process is not a Vercel runtime, and `NODE_ENV` is development — which
 * `next build` and every deployment are not. `ORBIT_DEMO_MANAGED_AI=off` turns it off, which
 * is how the production BYOK and credit states are seen on a laptop.
 */
function localDevAiEnabled(): boolean {
  if (process.env.ORBIT_DEMO_MANAGED_AI?.trim().toLowerCase() === "off") return false;
  return !process.env.VERCEL && isLocalhost();
}

/**
 * Demo accounts on a dev server run on the developer's keys, unmetered. A DEPLOYED demo
 * account (the showcase, `DEMO_ACCOUNT_USER_ID`) is not exempt: it follows the plan it holds,
 * so it can never spend Orbit's money outside the credit ledger.
 */
function demoCountsAsManaged(userId: string): boolean {
  return localDevAiEnabled() && isDemoAccount(userId);
}

/* ------------------------------------------------------------------------ grants ----- */

/**
 * Permission to make ONE kind of call on ONE key. Everything a caller may know about it —
 * never the key itself. `keyOwner` is what `usage_events.key_owner` records.
 */
export type AiGrant<P extends AiProvider = AiProvider> = Readonly<{
  provider: P;
  model: string;
  source: AiKeySource;
  keyOwner: "user" | "orbit";
  operation: string;
}>;

const GRANT_KEYS = new WeakMap<object, string>();

function mint<P extends AiProvider>(
  provider: P,
  model: string,
  source: AiKeySource,
  key: string,
  operation: string,
): AiGrant<P> {
  const grant = Object.freeze({
    provider,
    model,
    source,
    keyOwner: source === "managed" ? ("orbit" as const) : ("user" as const),
    operation,
  });
  GRANT_KEYS.set(grant, key);
  return grant;
}

function keyFor(grant: AiGrant<AiProvider>, provider: AiProvider): string {
  const key = GRANT_KEYS.get(grant);
  if (!key || grant.provider !== provider) {
    // A programming error, not a user state: something tried to build a client without
    // going through the gate, or with a grant for a different provider.
    throw new Error(`No ${provider} grant — AI clients are only issued by src/lib/ai-access.ts`);
  }
  return key;
}

// The grant is checked before the SDK loads, so a forged or mismatched grant is refused
// without ever importing a provider.
export async function geminiClient(grant: AiGrant<AiProvider>): Promise<GoogleGenAI> {
  const apiKey = keyFor(grant, "gemini");
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey });
}

export async function openaiClient(grant: AiGrant<AiProvider>): Promise<OpenAI> {
  const apiKey = keyFor(grant, "openai");
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}

export async function anthropicClient(grant: AiGrant<AiProvider>): Promise<Anthropic> {
  const apiKey = keyFor(grant, "anthropic");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey });
}

/**
 * OpenRouter is the OpenAI SDK pointed somewhere else. `keyFor` keeps the invariant that a
 * grant minted for one provider cannot build another's client.
 */
export async function openrouterClient(grant: AiGrant<AiProvider>): Promise<OpenAI> {
  const apiKey = keyFor(grant, "openrouter");
  const { default: OpenAI } = await import("openai");
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": getAppBaseUrl(),
      "X-Title": "Orbit",
    },
  });
}

/** Providers that speak the OpenAI wire format, so `ai.ts` can share one code path. */
export function isOpenAiShaped(provider: AiProvider): boolean {
  return provider === "openai" || provider === "openrouter";
}

export function openAiShapedClient(grant: AiGrant<AiProvider>): Promise<OpenAI> {
  return grant.provider === "openrouter" ? openrouterClient(grant) : openaiClient(grant);
}

/**
 * OpenRouter puts a `cost` field (USD, not micros) on the `usage` object of every response,
 * with no extra request parameter needed — direct OpenAI's `usage` never carries it. The
 * OpenAI SDK's own `usage` type has no such field, so this narrow shape exists to read it
 * without an `as any`.
 */
export type OpenAiUsageWithCost = { usage?: { cost?: number } };

/**
 * USD × 1e6, or `null` when the response carried no `usage.cost` — always true for direct
 * OpenAI, never true for OpenRouter.
 */
export function reportedCostMicros(response: OpenAiUsageWithCost): number | null {
  const cost = response.usage?.cost;
  return typeof cost === "number" ? Math.round(cost * 1_000_000) : null;
}

/**
 * Orbit's payloads are private relationship notes, so every OpenRouter request constrains
 * the upstream pool to providers that do not retain or train on what is sent.
 *
 * A helper rather than a spread at each call site on purpose: a privacy guarantee that
 * depends on remembering to spread is one forgotten spread away from being off, and
 * `smoke-provider-exhaustive` asserts no OpenRouter `.create(` bypasses this.
 */
export function withOpenRouterRouting<T extends object>(provider: AiProvider, params: T): T {
  if (provider !== "openrouter") return params;
  return { ...params, provider: { data_collection: "deny" } } as T;
}

/**
 * Permission to ask TypeSafe's decision model one set of questions. Deliberately NOT an
 * `AiGrant`: TypeSafe is not an `AiProvider`, because an `AiProvider` is something a person
 * can pick for chat, and every completion path in `ai.ts` would fall through to its
 * Anthropic branch for a fourth value. Same WeakMap, so it cannot be forged either.
 */
export type DecisionGrant = Readonly<{
  provider: "typesafe";
  model: string;
  source: AiKeySource;
  keyOwner: "user" | "orbit";
  operation: string;
}>;

function mintDecision(model: string, source: AiKeySource, key: string, operation: string): DecisionGrant {
  const grant = Object.freeze({
    provider: "typesafe" as const,
    model,
    source,
    keyOwner: source === "managed" ? ("orbit" as const) : ("user" as const),
    operation,
  });
  GRANT_KEYS.set(grant, key);
  return grant;
}

/** The decision model's client. `ai-access.ts` is the only file allowed to hand it a key. */
export function typesafeClient(grant: DecisionGrant): {
  systemOne(body: SystemOneRequest, opts?: { signal?: AbortSignal }): Promise<SystemOneResponse>;
} {
  const key = GRANT_KEYS.get(grant);
  if (!key || grant.provider !== "typesafe") {
    throw new Error("No typesafe grant — AI clients are only issued by src/lib/ai-access.ts");
  }
  return { systemOne: (body, opts) => systemOneRequest(key, body, { signal: opts?.signal }) };
}

/**
 * Run a provider call made on `grant`, rewording failures that are ORBIT'S problem.
 *
 * A managed key that the provider refuses or throttles is an ops incident, and the default
 * copy ("Gemini didn't accept your API key — check it in Settings") would send a Lifetime
 * user to fix a key they never gave us. So a managed auth/rate-limit failure becomes
 * `MANAGED_PROVIDER_FAILURE_MESSAGE` and an error event the ops sweep pages on. Wrap the
 * `withUsage` call, not its callback, so `usage_events.error_kind` still records the
 * provider's real failure kind.
 */
export async function runOnGrant<T>(grant: AiGrant<AiProvider>, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (grant.source !== "managed") throw err;
    const kind = classifyAiError(err);
    if (kind !== "auth" && kind !== "rate_limit") throw err;
    if (shouldRecordThrottled(`ai.managed:${grant.provider}:${kind}`)) {
      await recordErrorEvent({
        source: ERROR_SOURCES.managedAi,
        kind,
        message: err,
        context: { provider: grant.provider, model: grant.model, operation: grant.operation },
      });
    }
    throw new AiAccessError("managed_unavailable", MANAGED_PROVIDER_FAILURE_MESSAGE);
  }
}

/* ------------------------------------------------------------------ account read ----- */

type AccountRow = typeof userSettings.$inferSelect;

async function loadAccount(userId: string): Promise<AccountRow | undefined> {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

/**
 * What one `usage_events` row costs the managed allowance, in micros. Unpriced successful
 * calls are charged their pessimistic stand-in (UNPRICED_CALL_MICROS); a failed call with
 * no reported tokens costs nothing. Shared by the cap and the ops sweep so the two can never
 * disagree about what "spent" means.
 */
export function managedCostSql() {
  return sql`coalesce(${usageEvents.estimatedCostMicros},
    CASE WHEN ${usageEvents.success} = 1 THEN
      CASE ${usageEvents.kind}
        WHEN 'transcription' THEN ${sql.raw(String(UNPRICED_CALL_MICROS.transcription))}
        WHEN 'embedding' THEN ${sql.raw(String(UNPRICED_CALL_MICROS.embedding))}
        ELSE ${sql.raw(String(UNPRICED_CALL_MICROS.other))}
      END
    ELSE 0 END)`;
}

/* -------------------------------------------------------------------- the gate ------- */

/**
 * One account's AI access: the settings read, plan and keys, resolved once per AI call — or
 * once per request, when a request that makes several calls opens it once and passes it
 * down (`/api/chat`; see `forUser`). Only the account READ is shared that way: credits are
 * held in `grant()`, so every `completion()` / `embedding()` on a shared access places its
 * own hold against the live balance.
 *
 * Built by `resolveAiAccess`. Decrypts only what exists and holds the plaintext privately;
 * callers only ever see grants.
 */
export class AiAccess {
  private constructor(
    readonly userId: string,
    /** The account row, for the few non-key fields AI calls read (`aiModel`, names). */
    readonly settings: AccountRow | undefined,
    readonly plan: Plan,
    readonly eligibility: ManagedEligibility,
    /** Which key runs first when the account could use either. */
    readonly preference: AiKeyPreference,
    private readonly personal: Partial<Record<AiProvider, string>>,
    private readonly managed: Partial<Record<AiProvider, string>>,
    /** The decision model's key: the account's own, or on `next dev` the developer's. */
    private readonly decisionKey: { key: string; source: AiKeySource } | null,
  ) {}

  static async open(userId: string, opts: AiAccessOptions = {}): Promise<AiAccess> {
    if (opts.row && opts.row.userId !== userId) {
      throw new Error("AiAccess.open was handed another account's settings row");
    }
    const row = opts.row !== undefined ? (opts.row ?? undefined) : await loadAccount(userId);
    const plan = resolvePlan(row).plan;

    const personal: Partial<Record<AiProvider, string>> = {};
    const decrypted = {
      gemini: decryptOrNull(row?.geminiApiKeyEncrypted),
      openai: decryptOrNull(row?.openaiApiKeyEncrypted),
      anthropic: decryptOrNull(row?.anthropicApiKeyEncrypted),
      openrouter: decryptOrNull(row?.openrouterApiKeyEncrypted),
    };
    for (const [provider, key] of Object.entries(decrypted)) {
      if (key) personal[provider as AiProvider] = key;
    }

    const eligibility = managedEligibility(plan, demoCountsAsManaged(userId));
    const managed: Partial<Record<AiProvider, string>> = {};
    // The admin pause stops Orbit-paid AI for Pro and Max; a dev server's own keys are not
    // Orbit's, so a localhost demo account is unaffected.
    const paused = eligibility === "plan" ? await managedAiPaused() : false;
    if (eligibility && !paused) {
      for (const provider of MANAGED_PROVIDER_ORDER) {
        const key = managedKey(provider);
        if (key) managed[provider] = key;
      }
    }

    // BYOK only. The one exception is the dev server's own `.env.local`, on the same terms
    // as every other provider there (a localhost demo account) — so it can never become an
    // Orbit-paid key.
    const ownDecisionKey = decryptOrNull(row?.typesafeApiKeyEncrypted);
    const devDecisionKey =
      eligibility === "demo" && localDevAiEnabled()
        ? process.env[LOCAL_TYPESAFE_ENV]?.trim() || null
        : null;
    const decisionKey = ownDecisionKey
      ? { key: ownDecisionKey, source: "personal" as const }
      : devDecisionKey
        ? { key: devDecisionKey, source: "managed" as const }
        : null;

    const preference = (row?.aiKeyPreference ?? null) as AiKeyPreference;
    return new AiAccess(userId, row, plan, eligibility, preference, personal, managed, decisionKey);
  }

  /**
   * This access, for a call made on behalf of `userId` — the idiom every `access?` parameter
   * uses: `access?.forUser(userId) ?? (await resolveAiAccess(userId))`. An access opened for
   * another account is a programming error, never something to bill: it throws.
   */
  forUser(userId: string): AiAccess {
    if (this.userId !== userId) throw new Error("AiAccess was opened for another account");
    return this;
  }

  get selectedProvider(): AiProvider {
    return resolveAiProvider(this.settings?.aiProvider);
  }

  get selectedModel(): string {
    return resolveAiModel(this.selectedProvider, this.settings?.aiModel);
  }

  facts(): KeyFacts {
    return {
      eligibility: this.eligibility,
      preference: this.preference,
      selectedProvider: this.selectedProvider,
      selectedModel: this.selectedModel,
      personal: {
        gemini: Boolean(this.personal.gemini),
        openai: Boolean(this.personal.openai),
        anthropic: Boolean(this.personal.anthropic),
        openrouter: Boolean(this.personal.openrouter),
      },
      managed: {
        gemini: Boolean(this.managed.gemini),
        openai: Boolean(this.managed.openai),
        anthropic: Boolean(this.managed.anthropic),
        // Orbit holds no OpenRouter key — never a managed provider (managed-ai-policy.ts).
        openrouter: false,
      },
    };
  }

  refusal(reason: AiAccessDenial, message?: string): AiAccessError {
    return new AiAccessError(reason, message);
  }

  private async grant<P extends AiProvider>(
    provider: P,
    source: AiKeySource,
    model: string,
    operation: string,
  ): Promise<AiGrant<P>> {
    const key = source === "personal" ? this.personal[provider] : this.managed[provider];
    // Unreachable when the policy and the maps agree; a refusal beats a crash if they don't.
    if (!key) throw this.refusal(nothingUsable(this.eligibility).reason);
    // Credits are Orbit's spend ceiling: hold this call's estimate against the live balance,
    // or refuse — the hard stop. On a dev server the "managed" key is the developer's own
    // (eligibility "demo"), so there is nothing to meter.
    if (source === "managed" && this.eligibility === "plan") await this.holdCredits(operation);
    return mint(provider, model, source, key, operation);
  }

  private async holdCredits(operation: string): Promise<void> {
    await ensureAllowance(this.userId, this.plan, creditPeriodFor(this.settings));
    const tier = (AI_OPERATIONS as Record<string, { tier?: string }>)[operation]?.tier;
    const monthly = PLAN_CONFIG[this.plan].monthlyCredits ?? 0;
    const hold = await placeHold({
      userId: this.userId,
      micros: holdEstimateMicros(tier),
      operation,
      packs: packsUsable(this.plan),
      floorMicros: BACKGROUND_OPERATIONS.has(operation)
        ? creditsToMicros(monthly * BACKGROUND_FLOOR_SHARE)
        : 0,
    });
    if (!hold) throw this.refusal("managed_limit", this.plan === "free" ? FREE_LIMIT_MESSAGE : undefined);
  }

  /** A grant for "the user's model": chat, capture, drafts, briefs, OCR. */
  async completion(operation: string): Promise<AiGrant> {
    const choice = chooseCompletionKey(this.facts());
    if (!choice.ok) throw this.refusal(choice.reason);
    return this.grant(choice.provider, choice.source, choice.model, operation);
  }

  /** A grant for search embeddings. `provider` is the embedding backend. */
  async embedding(operation: string): Promise<AiGrant<EmbeddingBackend>> {
    const choice = chooseEmbeddingKey(this.facts());
    if (!choice.ok) throw this.embeddingRefusal(choice.reason);
    return this.grant(choice.provider, choice.source, "", operation);
  }

  /** Which embedding backend this account would use, without minting (a cache scope). */
  embeddingBackend(): EmbeddingBackend | null {
    const choice = chooseEmbeddingKey(this.facts());
    return choice.ok ? choice.provider : null;
  }

  /** The same answer, but refusing rather than returning null. */
  requireEmbeddingBackend(): EmbeddingBackend {
    const choice = chooseEmbeddingKey(this.facts());
    if (!choice.ok) throw this.embeddingRefusal(choice.reason);
    return choice.provider;
  }

  private embeddingRefusal(reason: AiAccessDenial): AiAccessError {
    // Anthropic has no embeddings API at all, so "add a key" has to name which one.
    return this.refusal(
      reason,
      reason === "key_required" && this.selectedProvider === "anthropic"
        ? "Anthropic has no embeddings API. Add an OpenAI or Gemini API key in Settings for search embeddings."
        : undefined,
    );
  }

  /**
   * A grant for the decision model (TypeSafe's Jev), or null — no key, or `ORBIT_JEV=off`.
   * Null is the normal answer for most accounts, and every caller has the path it used
   * before Jev to fall back on; that is why this returns rather than refuses.
   */
  decision(operation: string): DecisionGrant | null {
    if (!this.decisionKey || jevSwitchedOff()) return null;
    return mintDecision(JEV_MODEL, this.decisionKey.source, this.decisionKey.key, operation);
  }

  /**
   * Speech to text. The user's own OpenAI key (Whisper), then their own Gemini
   * key; for an eligible account with neither, Orbit's Gemini before Orbit's OpenAI —
   * Gemini's audio is priced per token, where Whisper's usage is invisible to the allowance.
   * Null when nothing is available.
   */
  async transcription(operation: string): Promise<AiGrant | null> {
    if (this.personal.openai) return this.grant("openai", "personal", "whisper-1", operation);
    if (this.personal.gemini) {
      return this.grant("gemini", "personal", resolveAiModel("gemini", this.settings?.aiModel), operation);
    }
    if (!this.eligibility) return null;
    if (this.managed.gemini) {
      return this.grant("gemini", "managed", managedModel("gemini", this.settings?.aiModel), operation);
    }
    if (this.managed.openai) return this.grant("openai", "managed", "whisper-1", operation);
    return null;
  }

  /**
   * Whether any speech-to-text engine is available — the same chain as `transcription()`,
   * presence only. Anthropic has no speech-to-text, so an Anthropic-only
   * BYOK account can summarize but not transcribe.
   */
  canTranscribe(): boolean {
    if (this.personal.openai || this.personal.gemini) return true;
    return Boolean(this.eligibility && (this.managed.openai || this.managed.gemini));
  }
}

export type AiAccessOptions = {
  /**
   * The account's whole `user_settings` row, when the caller already holds it — the one
   * `requireAuthenticatedUser()` returns is the same full-row read. Skips the gate's own
   * read; `null` means "no row". Only pass a row read in the same request: the plan is
   * resolved from it, so that read is always what the grants are built from.
   */
  row?: AccountRow | null;
};

/** The one entry point. Every AI call in `ai.ts` starts here. */
export function resolveAiAccess(userId: string, opts?: AiAccessOptions): Promise<AiAccess> {
  return AiAccess.open(userId, opts);
}

/* ------------------------------------------------------------------ status (UI) ------ */

export type AiAccessStatus = {
  /** Whether "the user's model" would run right now. What every "add your key" notice asks. */
  ready: boolean;
  reason: AiAccessDenial | null;
  /** Whose key completions would run on, when ready. */
  source: AiKeySource | null;
  /** The provider and model completions would run on (the managed default, on Orbit's key). */
  provider: AiProvider;
  model: string;
  selectedProvider: AiProvider;
  plan: Plan;
  eligibility: ManagedEligibility;
  /** The selected provider has a (decryptable) personal key. */
  hasPersonalKey: boolean;
  /** This deployment holds at least one managed key. */
  managedConfigured: boolean;
  /** Voice and meeting capture have an engine — Deepgram's quota or `AiAccess.canTranscribe()`. */
  canTranscribe: boolean;
  /** Which key runs first when the account has both (`null` = the saved key). */
  preference: AiKeyPreference;
  /** Orbit-paid AI is paused by the admin switch or the env kill switch. */
  managedPaused: boolean;
  /** The credit balance — Pro and Max only. */
  credits: (CreditBalance & { monthlyCredits: number }) | null;
};

/**
 * What the UI should say about AI for this account. Never throws for an AI reason.
 *
 * Runs the same policy as the gate, plus the allowance for eligible accounts, so a notice
 * can never promise something `completion()` would then refuse — the failure mode of the
 * old `hasApiKey`, which knew nothing about plans.
 */
export async function getAiAccessStatus(userId: string): Promise<AiAccessStatus> {
  const access = await resolveAiAccess(userId);
  const facts = access.facts();
  const choice = chooseCompletionKey(facts);
  const now = new Date();

  // Deepgram is per-account quota, not a key someone pasted, so it is resolved here rather
  // than inside `AiAccess.canTranscribe()` — that method stays the key-presence answer other
  // callers rely on.
  const monthlyCredits = PLAN_CONFIG[access.plan].monthlyCredits;
  const [balance, speech, paused] = await Promise.all([
    monthlyCredits && access.eligibility === "plan" ? getCreditBalance(userId, access.plan, access.settings, now) : null,
    deepgramEnabled() ? speechAllowance(userId, "shortform") : null,
    access.eligibility === "plan" ? managedAiPaused() : Promise.resolve(false),
  ]);

  let reason: AiAccessDenial | null = null;
  if (!choice.ok) {
    reason = choice.reason;
  } else if (choice.source === "managed" && access.eligibility === "plan" && balance && balance.spendable <= 0) {
    reason = "managed_limit";
  }

  const deepgram = speech ? !speech.exhausted : false;

  return {
    ready: reason === null,
    reason,
    source: choice.ok ? choice.source : null,
    provider: choice.ok ? choice.provider : facts.selectedProvider,
    model: choice.ok ? choice.model : facts.selectedModel,
    selectedProvider: facts.selectedProvider,
    plan: access.plan,
    eligibility: access.eligibility,
    hasPersonalKey: facts.personal[facts.selectedProvider],
    managedConfigured: Object.values(managedKeysConfigured()).some(Boolean),
    canTranscribe: deepgram || access.canTranscribe(),
    preference: access.preference,
    managedPaused: managedAiSwitchedOff() || paused,
    credits: balance && monthlyCredits ? { ...balance, monthlyCredits } : null,
  };
}

type AiSettingsRow = {
  aiProvider?: string | null;
  aiModel?: string | null;
  aiKeyPreference?: string | null;
  geminiApiKeyEncrypted?: string | null;
  openaiApiKeyEncrypted?: string | null;
  anthropicApiKeyEncrypted?: string | null;
  openrouterApiKeyEncrypted?: string | null;
} & BillingColumns;

/**
 * The settings-level denial: presence only, no credits and no admin pause (like the alert it
 * feeds). Null = AI would run. No decryption, no credit query, no Stripe, and the same policy
 * function as the gate, so the "add your API key" alert and the gate cannot disagree about
 * who needs a key.
 */
export function aiDenialFromSettings(userId: string, row: AiSettingsRow | null): AiAccessDenial | null {
  const selectedProvider = resolveAiProvider(row?.aiProvider);
  const { plan } = resolvePlan(row);
  const facts = {
    eligibility: managedEligibility(plan, demoCountsAsManaged(userId)),
    selectedProvider,
    selectedModel: resolveAiModel(selectedProvider, row?.aiModel),
    personal: {
      gemini: Boolean(row?.geminiApiKeyEncrypted),
      openai: Boolean(row?.openaiApiKeyEncrypted),
      anthropic: Boolean(row?.anthropicApiKeyEncrypted),
      openrouter: Boolean(row?.openrouterApiKeyEncrypted),
    },
    managed: managedKeysConfigured(),
  };
  const choice = chooseCompletionKey(facts);
  return choice.ok ? null : choice.reason;
}

/** The presence-only yes/no, for the notifications panel's 120-second poll. */
export function aiReadyFromSettings(userId: string, row: AiSettingsRow | null): boolean {
  return aiDenialFromSettings(userId, row) === null;
}

/** For Settings copy: the label of each provider Orbit can pay for. */
export function managedProviderLabels(): string[] {
  const configured = managedKeysConfigured();
  return AI_PROVIDERS.filter((p) => configured[p.id]).map((p) => p.label);
}
