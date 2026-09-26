// Types only at the top: the SDKs themselves load on the first client built. This module is
// reached by most server routes (the app layout, the app pulse, health), and evaluating three
// provider SDKs — @google/genai pulls google-auth-library, protobufjs and ws — was part of
// every cold start for routes that never make a model call.
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiBatchJobs, usageEvents, userSettings } from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
import { isDemoAccount, isLocalhost } from "@/lib/demo-account";
import { resolvePlan } from "@/lib/entitlements";
import { classifyAiError } from "@/lib/errors";
import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";
import type { SessionRetriever } from "@/lib/lifetime-checkout";
import type { Plan } from "@/lib/plan-limits";
import {
  AI_PROVIDERS,
  resolveAiModel,
  resolveAiProvider,
  type AiProvider,
  type EmbeddingBackend,
} from "@/lib/ai-providers";
import { AI_ACCESS_COPY, MANAGED_PROVIDER_FAILURE_MESSAGE } from "@/lib/ai-access-copy";
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
  aiReadyFromFacts,
  managedCallAllowed,
  managedEligibility,
  managedModel,
  managedWindow,
  nothingUsable,
  MANAGED_AI_BUDGET,
  MANAGED_AI_ENABLED,
  MANAGED_PROVIDER_ORDER,
  UNPRICED_CALL_MICROS,
  type AiAccessDenial,
  type AiKeySource,
  type KeyFacts,
  type ManagedAllowance,
  type ManagedEligibility,
  type ManagedUsage,
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
 *  3. A just-paid Lifetime checkout the webhook has not confirmed yet — see
 *     `lifetime-checkout.ts`. Asked about only when the account would otherwise be refused.
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
 * `ORBIT_MANAGED_AI=off` — the emergency stop. Every Lifetime account falls back to BYOK.
 * Always on while `MANAGED_AI_ENABLED` is false: managed AI has not shipped.
 */
export function managedAiSwitchedOff(): boolean {
  if (!MANAGED_AI_ENABLED) return true;
  return process.env.ORBIT_MANAGED_AI?.trim().toLowerCase() === "off";
}

function managedKey(provider: AiProvider): string | null {
  // Managed AI off: the local-dev names are the only ones read, and only on a dev server.
  if (!MANAGED_AI_ENABLED) {
    return localDevAiEnabled() ? process.env[LOCAL_ENV[provider]]?.trim() || null : null;
  }
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
  };
}

/** The env var an operator sets for a provider's managed key — for Settings and the runbook. */
export function managedEnvVar(provider: AiProvider): string {
  return MANAGED_ENV[provider];
}

/**
 * LOCALHOST ONLY — `next dev` runs AI on the keys in the developer's own `.env.local`, the
 * way local development always worked, so a fresh clone can capture a note without pasting a
 * key into Settings first. It is the only path left to a key the account did not save.
 *
 * Three conditions, all required, and none of them settable by a deployment: managed AI is
 * off (with it on, these names are Orbit's own managed keys and the plan rule applies), the
 * process is not a Vercel runtime, and `NODE_ENV` is development — which `next build` and
 * every deployment are not. `ORBIT_DEMO_MANAGED_AI=off` still turns it off, which is how the
 * production BYOK states are seen on a laptop.
 */
function localDevAiEnabled(): boolean {
  if (MANAGED_AI_ENABLED) return false;
  if (process.env.ORBIT_DEMO_MANAGED_AI?.trim().toLowerCase() === "off") return false;
  return !process.env.VERCEL && isLocalhost();
}

/**
 * Demo accounts count as Lifetime (see `managed-ai-policy.ts`).
 * `ORBIT_DEMO_MANAGED_AI=off` switches that off, so the BYOK states can be seen on `next dev`
 * — the same shape as `ORBIT_DEMO_DATA=off` for onboarding.
 *
 * With managed AI off this narrows to the localhost case: the showcase account
 * (`DEMO_ACCOUNT_USER_ID`) is a deployed account, and no deployment pays for AI.
 */
function demoCountsAsManaged(userId: string): boolean {
  if (process.env.ORBIT_DEMO_MANAGED_AI?.trim().toLowerCase() === "off") return false;
  if (!MANAGED_AI_ENABLED) return localDevAiEnabled() && isDemoAccount(userId);
  return isDemoAccount(userId);
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

function hasAnyPersonalKey(row: AccountRow | undefined): boolean {
  return Boolean(
    row?.geminiApiKeyEncrypted || row?.openaiApiKeyEncrypted || row?.anthropicApiKeyEncrypted,
  );
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

/**
 * This month's managed spend for one account — an index scan on `(user_id, created_at)`,
 * plus what batches still in flight are expected to cost.
 *
 * The reservation matters: a submitted batch has spent the money but written no usage rows
 * yet (they land when its results do, hours later). Without counting it, an account could
 * submit batch after batch and only discover the cap when the bill arrived.
 */
export async function managedUsageThisMonth(userId: string, now = new Date()): Promise<ManagedUsage> {
  const { start } = managedWindow(now);
  const db = await getDb();
  // Independent sums over two tables, so they go out together.
  const [[row], [reserved]] = await Promise.all([
    db
      .select({
        spent: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          eq(usageEvents.keyOwner, "orbit"),
          gte(usageEvents.createdAt, start),
          // Deepgram rows carry keyOwner "orbit" too — it's Orbit's own key, but it is a hosted
          // service metered by `speech_usage`, not an LLM call against the managed allowance.
          // Without this exclusion, `UNPRICED_CALL_MICROS.transcription` (managedCostSql's
          // fallback for a null-cost transcription row, which Deepgram rows always are — see
          // the note in ai.ts) would charge every voice note against the same monthly cap that
          // gates a Lifetime account's chat and capture calls, so recording a few voice notes
          // could throttle that account out of its own AI completions.
          ne(usageEvents.provider, "deepgram"),
        ),
      ),
    db
      .select({
        micros: sql<string>`coalesce(sum(${aiBatchJobs.estCostMicros}), 0)::bigint`,
        calls: sql<string>`coalesce(sum(${aiBatchJobs.requestCount}), 0)::bigint`,
      })
      .from(aiBatchJobs)
      .where(
        and(
          eq(aiBatchJobs.userId, userId),
          eq(aiBatchJobs.keyOwner, "orbit"),
          eq(aiBatchJobs.status, "submitted"),
          gte(aiBatchJobs.createdAt, start),
        ),
      ),
  ]);
  return {
    spentMicros: Number(row?.spent ?? 0) + Number(reserved?.micros ?? 0),
    calls: Number(row?.calls ?? 0) + Number(reserved?.calls ?? 0),
  };
}

export function allowanceFrom(usage: ManagedUsage, now = new Date()): ManagedAllowance {
  return {
    ...usage,
    limitMicros: MANAGED_AI_BUDGET.monthlyCostMicros,
    callLimit: MANAGED_AI_BUDGET.monthlyCalls,
    resetsAt: managedWindow(now).resetsAt.toISOString(),
  };
}

/* -------------------------------------------------------------------- the gate ------- */

/**
 * One account's AI access: the settings read, plan and keys, resolved once per AI call — or
 * once per request, when a request that makes several calls opens it once and passes it
 * down (`/api/chat`; see `forUser`). Only the account READ is shared that way: the managed
 * allowance is checked in `grant()`, so every `completion()` / `embedding()` on a shared
 * access still sums this month's usage afresh, including what earlier calls in the same
 * request spent.
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
    /** A paid Lifetime checkout Stripe says has not cleared yet. */
    readonly upgradePending: boolean,
    private readonly personal: Partial<Record<AiProvider, string>>,
    private readonly managed: Partial<Record<AiProvider, string>>,
    /** The decision model's key: the account's own, or on `next dev` the developer's. */
    private readonly decisionKey: { key: string; source: AiKeySource } | null,
  ) {}

  static async open(userId: string, opts: AiAccessOptions = {}): Promise<AiAccess> {
    if (opts.row && opts.row.userId !== userId) {
      throw new Error("AiAccess.open was handed another account's settings row");
    }
    let row = opts.row !== undefined ? (opts.row ?? undefined) : await loadAccount(userId);
    let plan = resolvePlan(row).plan;
    let upgradePending = false;

    // Only an account about to be refused is worth a Stripe round trip: not on Lifetime,
    // no key of its own, and a Lifetime checkout opened recently.
    if (
      MANAGED_AI_ENABLED &&
      plan !== "lifetime" &&
      row?.lifetimeCheckoutSessionId &&
      !hasAnyPersonalKey(row) &&
      !demoCountsAsManaged(userId)
    ) {
      // Imported here, not at the top: it pulls in the Stripe SDK, which every other AI
      // call has no use for.
      const { checkPendingLifetime } = await import("@/lib/lifetime-checkout");
      const pending = await checkPendingLifetime(userId, row, new Date(), opts.retrieveSession);
      if (pending === "granted") {
        row = await loadAccount(userId);
        plan = resolvePlan(row).plan;
      } else if (pending === "processing") {
        upgradePending = true;
      }
    }

    const personal: Partial<Record<AiProvider, string>> = {};
    const decrypted = {
      gemini: decryptOrNull(row?.geminiApiKeyEncrypted),
      openai: decryptOrNull(row?.openaiApiKeyEncrypted),
      anthropic: decryptOrNull(row?.anthropicApiKeyEncrypted),
    };
    for (const [provider, key] of Object.entries(decrypted)) {
      if (key) personal[provider as AiProvider] = key;
    }

    const eligibility = managedEligibility(plan, demoCountsAsManaged(userId));
    const managed: Partial<Record<AiProvider, string>> = {};
    if (eligibility) {
      for (const provider of MANAGED_PROVIDER_ORDER) {
        const key = managedKey(provider);
        if (key) managed[provider] = key;
      }
    }

    // BYOK only. The one exception is the dev server's own `.env.local`, on the same terms
    // as every other provider there (a localhost demo account, managed AI off) — so it can
    // never become an Orbit-paid key, even the day managed AI ships.
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

    return new AiAccess(userId, row, plan, eligibility, upgradePending, personal, managed, decisionKey);
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
      selectedProvider: this.selectedProvider,
      selectedModel: this.selectedModel,
      personal: {
        gemini: Boolean(this.personal.gemini),
        openai: Boolean(this.personal.openai),
        anthropic: Boolean(this.personal.anthropic),
      },
      managed: {
        gemini: Boolean(this.managed.gemini),
        openai: Boolean(this.managed.openai),
        anthropic: Boolean(this.managed.anthropic),
      },
    };
  }

  /**
   * The refusal for `reason`. A `key_required` for an account whose Lifetime payment is
   * still clearing is reported as that instead: a key is not what they are missing.
   */
  refusal(reason: AiAccessDenial, message?: string): AiAccessError {
    if (reason === "key_required" && this.upgradePending) {
      return new AiAccessError("upgrade_pending");
    }
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
    // The allowance is Orbit's spend ceiling. On a dev server the "managed" key is the
    // developer's own, so there is nothing to ration and no usage query to pay for.
    if (source === "managed" && MANAGED_AI_ENABLED) {
      const usage = await managedUsageThisMonth(this.userId);
      if (!managedCallAllowed(usage, operation)) throw this.refusal("managed_limit");
    }
    return mint(provider, model, source, key, operation);
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
   * How a pending Lifetime checkout is looked up. Production always asks Stripe; the smoke
   * test passes a stand-in so the "just paid" states can be exercised without it.
   */
  retrieveSession?: SessionRetriever;
  /**
   * The account's whole `user_settings` row, when the caller already holds it — the one
   * `requireAuthenticatedUser()` returns is the same full-row read. Skips the gate's own
   * read; `null` means "no row". Only pass a row read in the same request: the plan is
   * resolved from it. The re-read after a just-granted Lifetime checkout still happens, so
   * that write is always what the grants are built from.
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
  /** This month's managed allowance — eligible accounts only. */
  allowance: ManagedAllowance | null;
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
  // callers rely on. Read alongside the managed allowance, but only once `resolveAiAccess`
  // has settled: that can grant a just-paid Lifetime plan, and the speech limit is per plan.
  const [usage, speech] = await Promise.all([
    access.eligibility && MANAGED_AI_ENABLED ? managedUsageThisMonth(userId, now) : null,
    deepgramEnabled() ? speechAllowance(userId, "shortform") : null,
  ]);
  const allowance = usage ? allowanceFrom(usage, now) : null;

  let reason: AiAccessDenial | null = null;
  if (!choice.ok) {
    reason = choice.reason === "key_required" && access.upgradePending ? "upgrade_pending" : choice.reason;
  } else if (choice.source === "managed" && allowance && !managedCallAllowed(allowance, "status")) {
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
    allowance,
  };
}

/**
 * The presence-only answer, for the notifications panel's 120-second poll: no decryption,
 * no allowance query, no Stripe. Same policy function as the gate, so the "add your API
 * key" alert and the gate cannot disagree about who needs a key.
 */
export function aiReadyFromSettings(
  userId: string,
  row: {
    aiProvider?: string | null;
    aiModel?: string | null;
    geminiApiKeyEncrypted?: string | null;
    openaiApiKeyEncrypted?: string | null;
    anthropicApiKeyEncrypted?: string | null;
    compedPlan?: "orbit" | "lifetime" | null;
    lifetimePurchasedAt?: Date | null;
    subscriptionPlan?: "orbit" | null;
    subscriptionStatus?: "active" | "past_due" | "canceled" | null;
    subscriptionPeriodEnd?: Date | null;
  } | null,
): boolean {
  const selectedProvider = resolveAiProvider(row?.aiProvider);
  const { plan } = resolvePlan(row);
  const configured = managedKeysConfigured();
  return aiReadyFromFacts({
    eligibility: managedEligibility(plan, demoCountsAsManaged(userId)),
    selectedProvider,
    selectedModel: resolveAiModel(selectedProvider, row?.aiModel),
    personal: {
      gemini: Boolean(row?.geminiApiKeyEncrypted),
      openai: Boolean(row?.openaiApiKeyEncrypted),
      anthropic: Boolean(row?.anthropicApiKeyEncrypted),
    },
    managed: configured,
  });
}

/** For Settings copy: the label of each provider Orbit can pay for. */
export function managedProviderLabels(): string[] {
  const configured = managedKeysConfigured();
  return AI_PROVIDERS.filter((p) => configured[p.id]).map((p) => p.label);
}
