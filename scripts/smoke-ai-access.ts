/**
 * Pins the AI gate (`src/lib/ai-access.ts`): who may run AI on whose key, end to end.
 *
 *   1. The source guard — no file but the gate imports an AI SDK, builds a client, or reads an
 *      AI key from the environment. This is what makes the gate the ONLY path to a key.
 *   2. The pure policy — the plan × key matrix, managed model downgrades, the allowance.
 *   3. The real gate against a temp PGlite, with `fetch` stubbed so the real SDK calls run
 *      and the key that actually went on the wire is checked: Lifetime + own key, Lifetime +
 *      no key (managed), non-Lifetime + own key, non-Lifetime + no key (refused, and nothing
 *      sent) — for completions, embeddings and transcription.
 *   4. Transitions without a reload: buy Lifetime mid-session, keep your own key after
 *      buying, refund/revoke mid-session, the allowance running out, the kill switch, a
 *      managed key the provider refuses, and a paid checkout whose webhook has not landed.
 *
 * While `MANAGED_AI_ENABLED` is false (managed AI has not shipped), 3 and 4 are replaced by
 * `byokOnly()`: with every managed AND local-dev key set, no account of any plan — Lifetime,
 * comped, showcase-demo — gets anything but its own key on the wire, and the one exception
 * (`next dev` on the developer's `.env.local`) is proved to need NODE_ENV=development and
 * no VERCEL, so no deployment can reach it.
 *
 * Run: npx tsx scripts/smoke-ai-access.ts
 */
import "./smoke/_env";

// Production's key rules: the local-dev key names are ignored on Vercel, so the only managed
// key is the explicit one set here. Set BEFORE the gate is imported or first called.
process.env.VERCEL = "1";
for (const name of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
  delete process.env[name];
  delete process.env[`ORBIT_MANAGED_${name}`];
}
delete process.env.ORBIT_MANAGED_AI;
delete process.env.ORBIT_DEMO_MANAGED_AI;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DEMO_ACCOUNT_USER_ID;
process.env.ORBIT_MANAGED_GEMINI_API_KEY = "managed-gemini-key";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  billingEvents,
  creditGrants,
  creditHolds,
  errorEvents,
  rateLimitBuckets,
  siteSettings,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { priceFor } from "../src/lib/ai-pricing";
import type { AiOperationId } from "../src/lib/ai-operations";
import { DEFAULT_MODELS } from "../src/lib/ai-providers";
import {
  AiAccessError,
  aiReadyFromSettings,
  geminiClient,
  getAiAccessStatus,
  isAiAccessError,
  managedKeysConfigured,
  forgetManagedAiPause,
  resolveAiAccess,
  runOnGrant,
  typesafeClient,
  type AiGrant,
  type DecisionGrant,
} from "../src/lib/ai-access";
import {
  AI_ACCESS_COPY,
  FREE_LIMIT_MESSAGE,
  MANAGED_PROVIDER_FAILURE_MESSAGE,
  aiDenialFromMessage,
} from "../src/lib/ai-access-copy";
import { getCreditBalance } from "../src/lib/credits/ledger";
import {
  MANAGED_AI_ENABLED,
  MANAGED_DEFAULT_MODELS,
  MANAGED_MODELS,
  MANAGED_PROVIDER_ORDER,
  chooseCompletionKey,
  chooseEmbeddingKey,
  holdEstimateMicros,
  managedEligibility,
  type KeyFacts,
} from "../src/lib/managed-ai-policy";
import {
  completeJson,
  completeJsonOn,
  createEmbedding,
  resolveEmbeddingBackend,
  transcribeAudioWithAI,
  transcribeImagePages,
} from "../src/lib/ai";
import { __clearEmbeddingCacheForTests, defaultResolveScope, getQueryEmbedding } from "../src/lib/embedding-cache";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { friendlyError, isMissingAiApiKeyError } from "../src/lib/errors";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${String(detail)}`}`);
  }
}

/* ------------------------------------------------------------------ fetch stub ------- */

type Sent = { url: string; key: string | null; headers: Record<string, string>; body: string | null };
const sent: Sent[] = [];
let respondWith: "ok" | "key_refused" = "ok";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const key =
    headers.get("x-goog-api-key") ??
    headers.get("x-api-key") ??
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  sent.push({
    url,
    key,
    headers: Object.fromEntries(headers.entries()),
    body: typeof init?.body === "string" ? init.body : null,
  });
  if (respondWith === "key_refused") {
    return new Response(
      JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (/embedContent|batchEmbedContents/.test(url)) {
    return Response.json({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });
  }
  if (/generativelanguage/.test(url)) {
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: '{"ok":true,"text":"hello there"}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
    });
  }
  if (/^https:\/\/openrouter\.ai\/api\/v1\/embeddings/.test(url)) {
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  }
  if (/^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/.test(url)) {
    return Response.json({
      choices: [{ message: { role: "assistant", content: '{"ok":true,"text":"hello there"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

/* ---------------------------------------------------------------- source guard ------- */

/**
 * Paths are returned with forward slashes on every platform.
 *
 * `join` uses the OS separator, so on Windows this yielded `src\lib\ai-access.ts` while every
 * exemption below is written `src/lib/ai-access.ts`. Nothing matched, and the guard reported
 * the gate itself — plus its own source file — as offenders on a clean tree.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [path.replace(/\\/g, "/")] : [];
  });
}

const GATE = "src/lib/ai-access.ts";
/**
 * The one other file allowed to build a client: the launch plan's save-time key check
 * (phase 0, task 12). It probes the key the user just PASTED, before it is stored — never a
 * stored or managed key — so it has nothing to ask the gate. Listed ahead of time so its
 * merge does not fail this guard.
 */
const KEY_PROBE = "src/lib/ai-key-check.ts";
/**
 * TypeSafe's transport (the decision model). It takes a raw key, so it is guarded like an
 * SDK: only the gate and the key probe may import it, and it is the one file allowed to name
 * TypeSafe's host. Its own smoke tests it directly, with a stubbed fetch.
 */
const TYPESAFE_TRANSPORT = "src/lib/typesafe-api.ts";
const TYPESAFE_TRANSPORT_TEST = "scripts/smoke-jev-client.ts";
/**
 * Deepgram's own client (task 3 of the speech-to-text plan). It is not an LLM provider and
 * is deliberately outside the gate above, but it still reads exactly one key and names
 * exactly one host — so it gets the same narrow exemption as the gate and the transport.
 */
const DEEPGRAM_CLIENT = "src/lib/deepgram.ts";
/**
 * The live Deepgram socket wrapper (task 8). It runs in the BROWSER, holds only the
 * 30-second grant token `deepgram.ts` minted server-side, and never sees `DEEPGRAM_API_KEY`
 * — so it is exempted from the host check (it does legitimately open a socket to Deepgram)
 * but not from the env-key check (it has no business reading the raw key, and doesn't).
 */
const DEEPGRAM_LIVE_CLIENT = "src/lib/deepgram-live.ts";
/**
 * The CSP builder (task 8). It only NAMES `api.deepgram.com` inside a policy string so the
 * browser is allowed to reach it — it never dials the host itself — so it gets the same
 * host-check exemption as the two files above.
 */
const SECURITY_HEADERS = "src/lib/security-headers.ts";
/**
 * The eval harness, exempted from the ENV-KEY rule only (task 17). It is a developer tool
 * that never ships and is never imported by the app, and holding provider keys is its whole
 * job — it already carries Gemini/OpenAI/Anthropic/TypeSafe keys, which only escape this
 * regex because it reads them under `ORBIT_EVAL_*` names. Deepgram is the one that cannot be
 * hidden that way: it is not an `AiProvider`, so it cannot ride the encrypted-`userSettings`
 * BYOK path `setUpUser` uses for the other four, and `src/lib/deepgram.ts` reads it straight
 * off `process.env` — so `setDeepgramKey` has to write `process.env.DEEPGRAM_API_KEY` by that
 * literal name for a `--task transcribe` run to reach Deepgram at all.
 *
 * Narrow on purpose: this file is still held to the SDK-import, client-construction,
 * TypeSafe-transport and provider-host rules below, and every other file — including every
 * other script — is still held to the env-key rule.
 */
const EVAL_HARNESS = "scripts/eval-ai.ts";

function sourceGuard() {
  console.log("\nOnly the gate can reach a provider");
  const SDKS = ["@google/genai", "openai", "@anthropic-ai/sdk"];
  const valueImport = new RegExp(
    String.raw`^\s*import\s+(?!type\b)[^;]*?from\s+["'](${SDKS.map((s) => s.replace(/[/@.-]/g, (c) => `\\${c}`)).join("|")})["']`,
    "m",
  );
  const dynamicImport = new RegExp(String.raw`import\(\s*["'](${SDKS.map((s) => s.replace(/[/@.-]/g, (c) => `\\${c}`)).join("|")})["']\s*\)`);
  const construct = /new\s+(GoogleGenAI|OpenAI|Anthropic)\s*\(/;
  const transportImport = /^\s*import\s+(?!type\b)[^;]*?from\s+["'](?:@\/lib|\.\.?(?:\/[\w.-]+)*)\/typesafe-api["']|import\(\s*["'][^"']*typesafe-api["']\s*\)/m;
  const envKey = /process\.env(\.|\[\s*["'`])(ORBIT_MANAGED_[A-Z_]*|GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|TYPESAFE_API_KEY|OPENROUTER_API_KEY|DEEPGRAM_API_KEY)\b/;
  // OpenRouter's own bare host, unlike the other three, is also where a person's browser
  // legitimately links out — the credits page (errors.ts's quota copy, verified by curl to
  // be /settings/credits — /credits itself 308s there) and the authorize URL (Task 5).
  // Task 5 adds two more narrow exceptions, both raw HTTP because OpenRouter has no SDK:
  // `ai-key-check.ts`'s save-time probe (`GET /api/v1/key`, the same file and reasoning
  // that already exempts the other three probes' SDK constructors) and the OAuth
  // callback's code-for-key exchange (`POST /api/v1/auth/keys`), which mints the very key
  // the gate later hands out — it has nothing of its own to ask the gate either.
  // Excluding only these specific paths, rather than requiring "/api", keeps the bare-host
  // literal itself tripping the guard everywhere else — including a split host/path form
  // (`const H = "https://openrouter.ai"; fetch(\`${H}/api/v1/...\`)`) that a "must contain
  // /api" pattern would miss, since the literal alone carries no path.
  const providerHost = /generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|api\.typesafe\.ai|api\.deepgram\.com|openrouter\.ai(?!\/(settings\/credits|settings\/keys|auth|api\/v1\/key|api\/v1\/auth\/keys)\b)/;

  const offenders: string[] = [];
  for (const file of [...walk("src"), ...walk("scripts")]) {
    if (file === GATE || file === "scripts/smoke-ai-access.ts") continue;
    const src = readFileSync(file, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const probe = file === KEY_PROBE;
    if (!probe && (valueImport.test(code) || dynamicImport.test(code))) offenders.push(`${file}: imports an AI SDK`);
    if (!probe && construct.test(code)) offenders.push(`${file}: constructs an AI client`);
    if (!probe && file !== TYPESAFE_TRANSPORT_TEST && transportImport.test(code)) offenders.push(`${file}: imports TypeSafe's raw-key transport`);
    if (
      envKey.test(code) &&
      file !== "scripts/smoke-contact-brief.ts" &&
      file !== DEEPGRAM_CLIENT &&
      file !== EVAL_HARNESS
    )
      offenders.push(`${file}: reads an AI key from the environment`);
    if (
      providerHost.test(code) &&
      file !== TYPESAFE_TRANSPORT &&
      file !== DEEPGRAM_CLIENT &&
      file !== DEEPGRAM_LIVE_CLIENT &&
      file !== SECURITY_HEADERS
    )
      offenders.push(`${file}: talks to a provider host directly`);
  }
  check("no file outside the gate imports an SDK, builds a client, reads a key or calls a provider", offenders.length === 0, offenders.join("\n       "));

  const gate = readFileSync(GATE, "utf8");
  check("the gate itself holds all three SDK constructors", ["new GoogleGenAI(", "new OpenAI(", "new Anthropic("].every((c) => gate.includes(c)));
  check("…and the only hand-off of a TypeSafe key to its transport", /systemOneRequest\(key,/.test(gate));
  // The rules above are regexes over source text; prove each new one bites on a sample.
  check("the transport-import rule catches a stray import", transportImport.test(`import { systemOneRequest } from "@/lib/typesafe-api";`) && transportImport.test(`import { x } from "../src/lib/typesafe-api";`));
  check("…but not a type-only one", !transportImport.test(`import type { SystemOneRequest } from "@/lib/typesafe-api";`));
  check("the env rule catches TYPESAFE_API_KEY", envKey.test("process.env.TYPESAFE_API_KEY"));
  // The exemption above is by exact path, so the rule it exempts must still bite everywhere
  // else — otherwise a weakened regex and a working guard look identical on a clean tree.
  check("the env rule catches DEEPGRAM_API_KEY", envKey.test(`const k = process.env.DEEPGRAM_API_KEY;`) && envKey.test(`process.env["DEEPGRAM_API_KEY"]`));
  check("…and the eval harness is the only script exempted from it", EVAL_HARNESS === "scripts/eval-ai.ts" && envKey.test(readFileSync(EVAL_HARNESS, "utf8")));
  check("the host rule catches TypeSafe's host", providerHost.test("https://api.typesafe.ai/v1/systemone"));
  check("…and OpenRouter's API path", providerHost.test("https://openrouter.ai/api/v1/chat/completions"));
  check(
    "…and a split host/path form of the same call",
    providerHost.test('const H = "https://openrouter.ai"; fetch(`${H}/api/v1/chat/completions`)')
  );
  check("…but not a plain link to OpenRouter's credits page", !providerHost.test("https://openrouter.ai/settings/credits"));
  check("…nor the OAuth authorize URL (Task 5)", !providerHost.test("https://openrouter.ai/auth"));
  check("…nor the save-time key-check probe (Task 5)", !providerHost.test("https://openrouter.ai/api/v1/key"));
  check("…nor the OAuth code-for-key exchange (Task 5)", !providerHost.test("https://openrouter.ai/api/v1/auth/keys"));
  const ai = readFileSync("src/lib/ai.ts", "utf8");
  check("ai.ts imports the SDKs for types only", !valueImport.test(ai) && /import type OpenAI/.test(ai));
  check("every ai.ts provider path starts at resolveAiAccess", (ai.match(/resolveAiAccess\(/g) ?? []).length >= 6);
}

/* ------------------------------------------------------------------ pure policy ------ */

const facts = (over: Partial<KeyFacts>): KeyFacts => ({
  eligibility: null,
  selectedProvider: "gemini",
  selectedModel: "gemini-3.5-flash",
  personal: { gemini: false, openai: false, anthropic: false, openrouter: false },
  managed: { gemini: true, openai: false, anthropic: false, openrouter: false },
  ...over,
});

function purePolicy() {
  console.log("\nThe rule, as a matrix");
  const own = { gemini: true, openai: false, anthropic: false, openrouter: false };
  const pick = (f: KeyFacts) => {
    const c = chooseCompletionKey(f);
    return c.ok ? `${c.source}:${c.provider}:${c.model}` : `refused:${c.reason}`;
  };
  check("managed AI is on (pricing v2)", MANAGED_AI_ENABLED === true);
  check("Pro and Max are eligible for included AI", managedEligibility("orbit", false) === "plan" && managedEligibility("max", false) === "plan");
  check("Free is eligible for its small allowance; Lifetime never is",
    managedEligibility("free", false) === "plan" && managedEligibility("lifetime", false) === null);
  check("a (localhost) demo account is 'demo'", managedEligibility("free", true) === "demo");
  check("Pro + own key, no preference → their key, their model", pick(facts({ eligibility: "plan", personal: own })) === "personal:gemini:gemini-3.5-flash");
  check("Pro + own key + chose included → Orbit's key first",
    pick(facts({ eligibility: "plan", personal: own, preference: "included" })) === "managed:gemini:gemini-3.5-flash");
  check("Pro + own key + chose own → their key", pick(facts({ eligibility: "plan", personal: own, preference: "own" })) === "personal:gemini:gemini-3.5-flash");
  check("Pro + no key → Orbit's key", pick(facts({ eligibility: "plan" })) === "managed:gemini:gemini-3.5-flash");
  // `facts({})` has eligibility null: Lifetime's case now.
  check("no eligibility + own key → their key", pick(facts({ personal: own })) === "personal:gemini:gemini-3.5-flash");
  check("no eligibility + no key → refused, never Orbit's key", pick(facts({ managed: { gemini: true, openai: true, anthropic: true, openrouter: true } })) === "refused:key_required");
  check("an ineligible account's 'included' preference means nothing", pick(facts({ personal: own, preference: "included" })) === "personal:gemini:gemini-3.5-flash");
  check("Pro + no key + no managed key → managed_unavailable", pick(facts({ eligibility: "plan", managed: { gemini: false, openai: false, anthropic: false, openrouter: false } })) === "refused:managed_unavailable");
  check("a demo account with no key anywhere is told to add one — it was never promised Orbit's AI",
    pick(facts({ eligibility: "demo", managed: { gemini: false, openai: false, anthropic: false, openrouter: false } })) === "refused:key_required");

  console.log("\nManaged keys run managed models");
  // The allowlist protects Orbit's money; with managed AI off the only key behind that path
  // is the developer's own, so `next dev` runs the model Settings asks for.
  check("an expensive model on Orbit's key is downgraded",
    pick(facts({ eligibility: "plan", selectedModel: "gemini-2.5-pro" })) === `managed:gemini:${MANAGED_DEFAULT_MODELS.gemini}`);
  check("…the same model on their own key is theirs to choose",
    pick(facts({ eligibility: "plan", selectedModel: "gemini-2.5-pro", personal: own })) === "personal:gemini:gemini-2.5-pro");
  check("an Anthropic user on Pro with only a managed Gemini key runs on Gemini",
    pick(facts({ eligibility: "plan", selectedProvider: "anthropic", selectedModel: "claude-opus-4" })) === `managed:gemini:${MANAGED_DEFAULT_MODELS.gemini}`);
  check("every managed model is priced (an unpriced one would be metered at a stand-in, not its cost)",
    Object.values(MANAGED_MODELS).flat().every((m) => priceFor(m) !== null));

  console.log("\nEmbeddings");
  const emb = (f: KeyFacts) => {
    const c = chooseEmbeddingKey(f);
    return c.ok ? `${c.source}:${c.provider}` : `refused:${c.reason}`;
  };
  check("Anthropic-only with no eligibility → refused", emb(facts({ selectedProvider: "anthropic", personal: { gemini: false, openai: false, anthropic: true, openrouter: false } })) === "refused:key_required");
  check("Anthropic-only on Pro → Orbit's Gemini", emb(facts({ eligibility: "plan", selectedProvider: "anthropic", personal: { gemini: false, openai: false, anthropic: true, openrouter: false } })) === "managed:gemini");
  check("a personal OpenAI key beats a managed Gemini one", emb(facts({ eligibility: "plan", personal: { gemini: false, openai: true, anthropic: false, openrouter: false } })) === "personal:openai");
  check("…even when the account chose included AI (moving vectors means re-indexing)",
    emb(facts({ eligibility: "plan", preference: "included", personal: { gemini: false, openai: true, anthropic: false, openrouter: false } })) === "personal:openai");

  const noManaged = { gemini: false, openai: false, anthropic: false, openrouter: false };

  const pickedWithGemini = chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: true, openai: false, anthropic: false, openrouter: true },
    managed: noManaged,
  });
  check(
    "a personal gemini key still embeds when openrouter is selected",
    pickedWithGemini.ok && pickedWithGemini.provider === "gemini",
  );

  const pickedWithOpenai = chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: false, openai: true, anthropic: false, openrouter: true },
    managed: noManaged,
  });
  check(
    "a personal openai key still embeds when openrouter is selected",
    pickedWithOpenai.ok && pickedWithOpenai.provider === "openai",
  );

  const pickedOpenrouterOnly = chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: false, openai: false, anthropic: false, openrouter: true },
    managed: noManaged,
  });
  check(
    "openrouter embeds only when there is nothing else",
    pickedOpenrouterOnly.ok && pickedOpenrouterOnly.provider === "openrouter",
  );
  check(
    "an openrouter-only account can embed at all",
    pickedOpenrouterOnly.ok,
  );

  console.log("\nHold estimates");
  check("every tier holds something, and a capture holds more than an embedding",
    ["user", "fast", "vision", "embed", "transcribe", "decision", undefined].every((t) => holdEstimateMicros(t) > 0) &&
      holdEstimateMicros("vision") > holdEstimateMicros("embed"));

  console.log("\nThe words");
  for (const [reason, copy] of Object.entries(AI_ACCESS_COPY)) {
    check(`${reason}: house voice (no trailing period, curly apostrophes, no "failed")`,
      !copy.trimEnd().endsWith(".") && !/\w'\w/.test(copy) && !/\bfailed\b/i.test(copy), copy);
    check(`${reason}: friendlyError passes it through verbatim`, friendlyError(new Error(copy), "fallback") === copy);
    check(`${reason}: reads back as itself`, aiDenialFromMessage(copy) === reason);
    check(
      `${reason}: flips the UI into the notice state`,
      isMissingAiApiKeyError(copy),
    );
  }
  check("the managed-failure copy passes through and reads as managed_unavailable",
    friendlyError(new Error(MANAGED_PROVIDER_FAILURE_MESSAGE), "x") === MANAGED_PROVIDER_FAILURE_MESSAGE &&
      aiDenialFromMessage(MANAGED_PROVIDER_FAILURE_MESSAGE) === "managed_unavailable");
}

/* ------------------------------------------------------------------- real gate ------- */

const USER_KEY = "user-gemini-key";
const MANAGED = "managed-gemini-key";
const USER_OPENROUTER_KEY = "user-openrouter-key";
const U = {
  proOwn: "smoke-aia-pro-own",
  maxNone: "smoke-aia-max-none",
  lifetimeOwn: "smoke-aia-lifetime-own",
  lifetimeNone: "smoke-aia-lifetime-none",
  freeOwn: "smoke-aia-free-own",
  freeNone: "smoke-aia-free-none",
  proNone: "smoke-aia-pro-none",
  compNone: "smoke-aia-comp-none",
  demoNone: "smoke-aia-demo-none",
  localDev: "smoke-aia-local-dev",
  buyer: "smoke-aia-buyer",
  keeper: "smoke-aia-keeper",
  capped: "smoke-aia-capped",
  pending: "smoke-aia-pending",
  asyncPayer: "smoke-aia-async",
  shared: "smoke-aia-shared",
  other: "smoke-aia-other",
  openrouterOnly: "smoke-aia-openrouter-only",
};

async function account(userId: string, cols: Partial<typeof userSettings.$inferInsert>) {
  const db = await getDb();
  await db.delete(creditGrants).where(eq(creditGrants.userId, userId));
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
  await db.delete(billingEvents).where(eq(billingEvents.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.insert(userSettings).values({ userId, aiProvider: "gemini", aiModel: "gemini-3.5-flash", ...cols });
}

const PAST = new Date("2026-01-01T00:00:00Z");
const ownKey = () => ({ geminiApiKeyEncrypted: encrypt(USER_KEY) });

async function lastSent(fn: () => Promise<unknown>): Promise<{ result: unknown; err: unknown; req: Sent | null; count: number }> {
  const before = sent.length;
  let result: unknown = null;
  let err: unknown = null;
  try {
    result = await fn();
  } catch (e) {
    err = e;
  }
  return { result, err, req: sent.length > before ? sent[sent.length - 1] : null, count: sent.length - before };
}

const json = (userId: string, operation: AiOperationId = "capture.parse") =>
  completeJson(userId, { system: "Return JSON.", user: "hi", operation });

/** Usage rows (and the credit settlement behind them) land fire-and-forget; give them time. */
const settle = () => new Promise((r) => setTimeout(r, 400));

const PRO = { subscriptionPlan: "orbit" as const, subscriptionStatus: "active" as const };

/** Micros left on this account's allowance grants and on its packs. */
async function remaining(userId: string) {
  const db = await getDb();
  const rows = await db.select().from(creditGrants).where(eq(creditGrants.userId, userId));
  const sum = (kind: string) => rows.filter((g) => g.kind === kind).reduce((n, g) => n + g.microsRemaining, 0);
  return { allowance: sum("allowance"), pack: sum("pack"), grants: rows };
}

async function realGate() {
  await account(U.proOwn, { ...PRO, ...ownKey() });
  await account(U.proNone, { ...PRO, aiModel: "gemini-2.5-pro" });
  await account(U.maxNone, { compedPlan: "max" });
  await account(U.lifetimeOwn, { lifetimePurchasedAt: PAST, ...ownKey() });
  await account(U.lifetimeNone, { lifetimePurchasedAt: PAST });
  await account(U.freeOwn, ownKey());
  await account(U.freeNone, { aiModel: "gemini-2.5-pro" });
  await account(U.compNone, { compedPlan: "orbit" });
  await account(U.openrouterOnly, {
    aiProvider: "openrouter",
    aiModel: DEFAULT_MODELS.openrouter,
    openrouterApiKeyEncrypted: encrypt(USER_OPENROUTER_KEY),
  });

  console.log("\nThe matrix, through the real SDK calls (completions)");
  let r = await lastSent(() => json(U.proOwn));
  check("Pro + own key: their key went on the wire", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.proNone));
  check("Pro + no key: Orbit's managed key went on the wire", r.req?.key === MANAGED, r.req?.key ?? r.err);
  check(
    "…at the managed model, not the gemini-2.5-pro they picked",
    (r.req?.url ?? "").includes(`models/${MANAGED_DEFAULT_MODELS.gemini}:`),
    r.req?.url
  );
  r = await lastSent(() => json(U.maxNone));
  check("comped Max + no key: managed", r.req?.key === MANAGED, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.compNone));
  check("comped Pro + no key: managed (comps get the new Pro, credits included)", r.req?.key === MANAGED, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.freeOwn));
  check("Free + own key: their key went on the wire", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.freeNone));
  check("Free + no key: Orbit's managed key went on the wire", r.req?.key === MANAGED, r.req?.key ?? r.err);
  check("…at the managed model", (r.req?.url ?? "").includes(`models/${MANAGED_DEFAULT_MODELS.gemini}:`), r.req?.url);
  await settle();
  const freeBal = await getCreditBalance(U.freeNone, "free", null);
  check("…metered: the starter is granted and the allowance is charged first",
    freeBal.starterRemaining === 25 * 10_000 && (freeBal.allowance?.remaining ?? 0) < 10 * 10_000, freeBal);
  const freeOwnBefore = await getCreditBalance(U.freeOwn, "free", null);
  r = await lastSent(() => json(U.freeOwn));
  await settle();
  const freeOwnAfter = await getCreditBalance(U.freeOwn, "free", null);
  check("Free + own key spends nothing",
    r.req?.key === USER_KEY && freeOwnAfter.spendable === freeOwnBefore.spendable, [freeOwnBefore.spendable, freeOwnAfter.spendable]);
  r = await lastSent(() => json(U.lifetimeNone));
  check("Lifetime + no key: refused — Lifetime's AI is its own key only",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "key_required" && r.count === 0, r.err);
  r = await lastSent(() => json(U.lifetimeOwn));
  check("Lifetime + own key: their key", r.req?.key === USER_KEY, r.req?.key ?? r.err);

  await settle();
  const db = await getDb();
  const owners = async (userId: string) =>
    (await db.select({ o: usageEvents.keyOwner }).from(usageEvents).where(eq(usageEvents.userId, userId))).map((x) => x.o);
  check("usage records Orbit as the payer for the managed call", (await owners(U.proNone)).every((o) => o === "orbit") && (await owners(U.proNone)).length > 0);
  check("…and the user for their own key, even on Pro", (await owners(U.proOwn)).every((o) => o === "user"));
  const spent = await remaining(U.proNone);
  check("the managed call was charged to the allowance at its real cost",
    spent.allowance > 0 && spent.allowance < 200 * 10_000, spent.allowance);
  const own = await remaining(U.proOwn);
  check("a call on the account's own key spends no credits", own.grants.every((g) => g.microsRemaining === g.microsGranted), own.grants);
  const holds = await db.select().from(creditHolds).where(eq(creditHolds.userId, U.proNone));
  check("…and its hold was released on settlement", holds.length === 0, holds);

  console.log("\nEmbeddings and transcription use the same gate");
  r = await lastSent(() => createEmbedding(U.proNone, "a contact"));
  check("Pro + no key: embedding on the managed key", r.req?.key === MANAGED, r.req?.key ?? r.err);
  r = await lastSent(() => createEmbedding(U.freeNone, "a contact"));
  check("Free + no key: embedding on the managed key", r.req?.key === MANAGED, r.req?.key ?? r.err);
  const audio = { mimeType: "audio/webm", base64: Buffer.from("fake audio").toString("base64") };
  r = await lastSent(() => transcribeAudioWithAI(U.proNone, audio));
  check("Pro + no key: transcription on Orbit's Gemini", r.req?.key === MANAGED && (r.result as { engine?: string })?.engine === "gemini", r.req?.key ?? r.err);
  r = await lastSent(() => transcribeAudioWithAI(U.freeOwn, audio));
  check("own Gemini key: transcription on their key", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => transcribeAudioWithAI(U.freeNone, audio));
  check("Free + no key: transcription on the managed key", r.req?.key === MANAGED, r.req?.key ?? r.err);
  r = await lastSent(() => transcribeImagePages(U.freeNone, [{ mimeType: "image/jpeg", base64: "AAAA" }]));
  check("photo OCR with no key goes out on the managed key, not a key-missing page", r.req?.key === MANAGED, r.req?.key ?? r.err);
  const lifetimePages = await transcribeImagePages(U.lifetimeNone, [{ mimeType: "image/jpeg", base64: "AAAA" }]);
  check("Lifetime photo OCR with no key reports the key message per page, sends nothing",
    lifetimePages[0]?.ok === false && isMissingAiApiKeyError(lifetimePages[0]?.error), lifetimePages[0]?.error);

  console.log("\nOpenRouter shares the OpenAI-shaped path and never lets a provider keep the data");
  r = await lastSent(() => json(U.openrouterOnly));
  const captured = r.req;
  check("openrouter completions go to openrouter.ai", (captured?.url ?? "").startsWith("https://openrouter.ai/api/v1/"), captured?.url);
  check("openrouter completions carry the user’s key", captured?.headers.authorization === `Bearer ${USER_OPENROUTER_KEY}`, captured?.headers.authorization);
  check("openrouter completions identify Orbit", captured?.headers["x-title"] === "Orbit", captured?.headers["x-title"]);
  check("openrouter completions carry a referer", Boolean(captured?.headers["http-referer"]), captured?.headers["http-referer"]);
  check("openrouter completions refuse data collection", JSON.parse(captured?.body ?? "{}").provider?.data_collection === "deny", captured?.body);
  r = await lastSent(() => createEmbedding(U.openrouterOnly, "a contact"));
  const capturedEmbed = r.req;
  check("openrouter embeddings go to openrouter.ai", (capturedEmbed?.url ?? "").startsWith("https://openrouter.ai/api/v1/"), capturedEmbed?.url);
  check("openrouter embeddings refuse data collection", JSON.parse(capturedEmbed?.body ?? "{}").provider?.data_collection === "deny", capturedEmbed?.body);
  check("openrouter embeddings use the 1536-dim model", JSON.parse(capturedEmbed?.body ?? "{}").model === "openai/text-embedding-3-small", capturedEmbed?.body);

  console.log("\nWhat the UI is told");
  const status = async (u: string) => {
    const st = await getAiAccessStatus(u);
    return `${st.ready}:${st.reason}:${st.source}`;
  };
  check("Pro + own key → ready on their key", (await status(U.proOwn)) === "true:null:personal");
  check("Pro + no key → ready on Orbit's", (await status(U.proNone)) === "true:null:managed");
  check("…with its credits", (await getAiAccessStatus(U.proNone)).credits?.monthlyCredits === 200);
  check("Max carries 500", (await getAiAccessStatus(U.maxNone)).credits?.monthlyCredits === 500);
  check("Free + own key → ready", (await status(U.freeOwn)) === "true:null:personal");
  check("Free + no key → ready on Orbit's, with 10 monthly credits",
    (await status(U.freeNone)) === "true:null:managed" && (await getAiAccessStatus(U.freeNone)).credits?.monthlyCredits === 10);

  check("Lifetime + no key → add a key", (await status(U.lifetimeNone)) === "false:key_required:null");
  for (const u of [U.proOwn, U.proNone, U.freeOwn, U.freeNone, U.lifetimeNone]) {
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, u) });
    check(`the notification alert agrees with the gate (${u})`, aiReadyFromSettings(u, row ?? null) === (await getAiAccessStatus(u)).ready);
  }

  console.log("\nFree at zero");
  await db.update(creditGrants).set({ microsRemaining: 0 }).where(eq(creditGrants.userId, U.freeNone));
  r = await lastSent(() => json(U.freeNone, "chat.answer"));
  check("refused with the Free out-of-credits copy, nothing sent",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" &&
      (r.err as Error).message === FREE_LIMIT_MESSAGE && r.count === 0, r.err);
  check("…which the client reads back as managed_limit", aiDenialFromMessage(FREE_LIMIT_MESSAGE) === "managed_limit");
  check("…and the status agrees", (await status(U.freeNone)) === "false:managed_limit:managed");

  console.log("\nA grant cannot be forged");
  const forged = Object.freeze({ provider: "gemini", model: "x", source: "managed", keyOwner: "orbit", operation: "x" }) as AiGrant;
  let threw = false;
  try {
    await geminiClient(forged);
  } catch {
    threw = true;
  }
  check("a hand-built grant gets no client", threw);
  const real = await (await resolveAiAccess(U.proNone)).completion("x");
  threw = false;
  try {
    await (await import("../src/lib/ai-access")).openaiClient(real);
  } catch {
    threw = true;
  }
  check("a Gemini grant does not open an OpenAI client", threw);
}

async function transitions() {
  const db = await getDb();

  console.log("\nSubscribing mid-session, no reload");
  await account(U.buyer, {});
  let r = await lastSent(() => json(U.buyer));
  check("before: a Free account runs on Free's allowance", r.req?.key === MANAGED, r.req?.key ?? r.err);
  await db.update(userSettings).set(PRO).where(eq(userSettings.userId, U.buyer));
  r = await lastSent(() => json(U.buyer));
  check("the very next call runs on Orbit's key", r.req?.key === MANAGED, r.req?.key ?? r.err);

  console.log("\nA refund or lapse mid-session");
  await db.update(userSettings).set({ subscriptionStatus: "canceled", subscriptionPeriodEnd: PAST }).where(eq(userSettings.userId, U.buyer));
  r = await lastSent(() => json(U.buyer));
  check("the next call falls back to Free's allowance — still metered, not a crash", r.req?.key === MANAGED, r.req?.key ?? r.err);

  console.log("\nAn own key, and the choice of which runs");
  await account(U.keeper, { ...PRO, ...ownKey() });
  r = await lastSent(() => json(U.keeper));
  check("with no preference their saved key runs", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  await db.update(userSettings).set({ aiKeyPreference: "included" }).where(eq(userSettings.userId, U.keeper));
  r = await lastSent(() => json(U.keeper));
  check("choosing included AI puts Orbit's key first", r.req?.key === MANAGED, r.req?.key ?? r.err);
  await db.update(userSettings).set({ aiKeyPreference: "own" }).where(eq(userSettings.userId, U.keeper));
  r = await lastSent(() => json(U.keeper));
  check("choosing their own key puts it back first", r.req?.key === USER_KEY, r.req?.key ?? r.err);

  console.log("\nCredits running out: the hard stop");
  await account(U.capped, PRO);
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("a fresh Pro account runs on its allowance", r.req?.key === MANAGED, r.err);
  await settle();
  const allowanceKey = (await remaining(U.capped)).grants.find((g) => g.kind === "allowance")!.grantKey;
  const setAllowance = (micros: number) =>
    db.update(creditGrants).set({ microsRemaining: micros }).where(eq(creditGrants.grantKey, allowanceKey));
  // 40% left: below the background floor (half the allowance), above zero.
  await setAllowance(80 * 10_000);
  r = await lastSent(() => json(U.capped, "import.linkedin.timeline"));
  check("background work stops at half the allowance",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" && r.count === 0, r.err);
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("…while the person can still ask", r.req?.key === MANAGED, r.err);
  await settle();
  // One access opened BEFORE the balance runs out, as `/api/chat` opens one per question.
  const sharedCapped = await resolveAiAccess(U.capped);
  await setAllowance(0);
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("at zero: refused as managed_limit, nothing sent", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" && r.count === 0, r.err);
  r = await lastSent(() => completeJson(U.capped, { system: "Return JSON.", user: "hi", operation: "chat.answer", access: sharedCapped }));
  check("…and on an access opened before (one per request), still refused per call",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" && r.count === 0, r.err);
  check("…with words that say so", friendlyError(r.err, "x") === AI_ACCESS_COPY.managed_limit);
  check("…and the UI is told the same", (await getAiAccessStatus(U.capped)).reason === "managed_limit");

  console.log("\nOnly the call already in flight gets through");
  await setAllowance(1);
  const [a, b] = await Promise.all([
    lastSent(() => json(U.capped, "chat.answer")),
    (async () => {
      const inner = await resolveAiAccess(U.capped);
      return inner.completion("chat.answer").then(() => "granted", (e) => (isAiAccessError(e) ? e.reason : String(e)));
    })(),
  ]);
  const granted = [a.req?.key === MANAGED ? "granted" : "refused", b].filter((x) => x === "granted").length;
  check("two concurrent calls on 1 micro: exactly one is granted", granted === 1, [a.req?.key ?? a.err, b]);
  await settle();
  const after = await remaining(U.capped);
  check("the overshoot is Orbit's: no grant goes below zero", after.grants.every((g) => g.microsRemaining >= 0), after.grants);

  console.log("\nA pack is spent after the allowance");
  await setAllowance(0);
  await db.insert(creditGrants).values({
    userId: U.capped, kind: "pack", grantKey: `pack:smoke:${U.capped}`, microsGranted: 250 * 10_000, microsRemaining: 250 * 10_000,
    amountCents: 500, stripeRef: "pi_smoke_capped",
  });
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("with the allowance gone, the pack carries the call", r.req?.key === MANAGED, r.err);
  await settle();
  const packed = await remaining(U.capped);
  check("…and is charged to the pack", packed.pack > 0 && packed.pack < 250 * 10_000 && packed.allowance === 0, packed);
  await setAllowance(100 * 10_000);
  const beforePack = (await remaining(U.capped)).pack;
  r = await lastSent(() => json(U.capped, "chat.answer"));
  await settle();
  const afterPack = await remaining(U.capped);
  check("with allowance back, the allowance pays first and the pack is untouched",
    afterPack.pack === beforePack && afterPack.allowance < 100 * 10_000, afterPack);

  console.log("\nDowngrading freezes packs, resubscribing restores them");
  await db.update(userSettings).set({ subscriptionStatus: "canceled", subscriptionPeriodEnd: PAST }).where(eq(userSettings.userId, U.capped));
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("on Free the call runs on Free's own allowance", r.req?.key === MANAGED, r.err);
  await settle();
  const frozen = await remaining(U.capped);
  check("…and the pack is frozen, untouched",
    frozen.pack === afterPack.pack && frozen.grants.some((g) => g.kind === "pack" && g.status === "active"), frozen);
  await db.update(userSettings).set({ ...PRO, subscriptionPeriodEnd: null }).where(eq(userSettings.userId, U.capped));
  await setAllowance(0);
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("back on Pro, the same pack credits carry the call again", r.req?.key === MANAGED, r.err);

  console.log("\nThe kill switch and the admin pause");
  process.env.ORBIT_MANAGED_AI = "off";
  r = await lastSent(() => json(U.proNone));
  check("ORBIT_MANAGED_AI=off: Pro + no key → managed_unavailable, nothing sent",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_unavailable" && r.count === 0, r.err);
  r = await lastSent(() => json(U.proOwn));
  check("…own keys are untouched", r.req?.key === USER_KEY);
  delete process.env.ORBIT_MANAGED_AI;
  await db.insert(siteSettings).values({ id: 1, managedAiPaused: true }).onConflictDoUpdate({
    target: siteSettings.id,
    set: { managedAiPaused: true },
  });
  forgetManagedAiPause();
  r = await lastSent(() => json(U.proNone));
  check("the admin pause stops Orbit-paid AI too", isAiAccessError(r.err) && r.count === 0, r.err);
  check("…and the UI says it is paused", (await getAiAccessStatus(U.proNone)).managedPaused === true);
  await db.update(siteSettings).set({ managedAiPaused: false }).where(eq(siteSettings.id, 1));
  forgetManagedAiPause();
  r = await lastSent(() => json(U.proNone));
  check("unpausing brings it straight back", r.req?.key === MANAGED, r.err);

  console.log("\nOrbit's key refused by the provider");
  respondWith = "key_refused";
  r = await lastSent(() => json(U.proNone));
  check("a Pro user is not told to fix a key they never gave",
    r.err instanceof Error && r.err.message === MANAGED_PROVIDER_FAILURE_MESSAGE, r.err);
  const rows = await db.select().from(errorEvents).where(eq(errorEvents.source, "ai.managed"));
  check("…and ops gets an error event for it", rows.some((e) => (e.context as { provider?: string })?.provider === "gemini"));
  r = await lastSent(() => json(U.freeOwn));
  check("their own refused key still says check your key", r.err instanceof Error && /didn’t accept your API key/.test(r.err.message), r.err);
  respondWith = "ok";
  const grant = await (await resolveAiAccess(U.freeOwn)).completion("x");
  const passthrough = new Error("401 unauthorized");
  const back = await runOnGrant(grant, Promise.reject(passthrough)).catch((e) => e);
  check("runOnGrant leaves personal-key failures alone", back === passthrough);
}

/** `NODE_ENV` is readonly in the Node types; the gate reads it at call time either way. */
function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/**
 * Free, including a DEPLOYED showcase account on Free, is metered on Orbit's managed key
 * like any plan. Lifetime stays bring-your-own-key whatever keys the environment holds.
 * `next dev` still runs on the developer's own `.env.local`, unmetered.
 */
async function localDevAndByok() {
  const db = await getDb();
  const DEV_KEY = "dev-laptop-gemini-key";
  const DEV_TYPESAFE_KEY = "dev-laptop-typesafe-key";
  const saved = {
    VERCEL: process.env.VERCEL,
    DEMO: process.env.DEMO_ACCOUNT_USER_ID,
    NODE_ENV: process.env.NODE_ENV,
  };
  delete process.env.VERCEL;
  for (const p of ["GEMINI", "OPENAI", "ANTHROPIC"]) {
    process.env[`ORBIT_MANAGED_${p}_API_KEY`] = MANAGED;
    process.env[`${p}_API_KEY`] = DEV_KEY;
  }
  process.env.TYPESAFE_API_KEY = DEV_TYPESAFE_KEY;
  process.env.DEMO_ACCOUNT_USER_ID = U.demoNone;

  try {
    await account(U.lifetimeOwn, { lifetimePurchasedAt: PAST, ...ownKey() });
    await account(U.lifetimeNone, { lifetimePurchasedAt: PAST });
    await account(U.compNone, { compedPlan: "lifetime" });
    await account(U.demoNone, {});
    await account(U.localDev, {});
    await account(U.freeNone, {});
    await account(U.freeOwn, ownKey());
    await account(U.openrouterOnly, {
      aiProvider: "openrouter",
      aiModel: DEFAULT_MODELS.openrouter,
      openrouterApiKeyEncrypted: encrypt(USER_OPENROUTER_KEY),
    });

    console.log("\nLifetime and a comped Lifetime stay bring-your-own-key");
    const sentBefore = sent.length;
    const keyless = [U.lifetimeNone, U.compNone];
    const audio = { mimeType: "audio/webm", base64: Buffer.from("fake audio").toString("base64") };
    for (const u of keyless) {
      let r = await lastSent(() => json(u));
      check(`${u}: completion refused as key_required, nothing sent`,
        isAiAccessError(r.err) && (r.err as AiAccessError).reason === "key_required" && r.count === 0, r.req?.key ?? r.err);
      r = await lastSent(() => createEmbedding(u, "a contact"));
      check(`${u}: embedding refused, nothing sent`, isAiAccessError(r.err) && r.count === 0, r.req?.key ?? r.err);
      r = await lastSent(() => transcribeAudioWithAI(u, audio));
      check(`${u}: transcription refused, nothing sent`, isAiAccessError(r.err) && r.count === 0, r.req?.key ?? r.err);
      const s = await getAiAccessStatus(u);
      check(`${u}: the UI is told to add a key`, !s.ready && s.reason === "key_required" && s.source === null && s.credits === null, JSON.stringify(s));
      const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, u) });
      check(`${u}: the notification alert agrees`, aiReadyFromSettings(u, row ?? null) === false);
      check(`${u}: no decision grant — TypeSafe is BYOK, and .env.local is not a deployment's`,
        (await resolveAiAccess(u)).decision("chat.rerank.decide") === null);
    }

    for (const u of [U.lifetimeOwn, U.freeOwn]) {
      const r = await lastSent(() => json(u));
      check(`${u}: their own key went on the wire`, r.req?.key === USER_KEY, r.req?.key ?? r.err);
    }
    await settle();
    const byokUsers = [...keyless, U.lifetimeOwn, U.freeOwn];
    const owners = await db.select({ o: usageEvents.keyOwner }).from(usageEvents).where(inArray(usageEvents.userId, byokUsers));
    check("no usage row names Orbit as the payer", owners.length > 0 && owners.every((x) => x.o === "user"), owners.map((x) => x.o).join(","));
    check("neither Orbit's nor the developer's key ever went on the wire",
      sent.slice(sentBefore).every((x) => x.key !== MANAGED && x.key !== DEV_KEY));

    for (const u of [U.freeNone, U.demoNone]) {
      const r = await lastSent(() => json(u));
      check(`${u}: a deployed Free account runs metered on Orbit's managed key`, r.req?.key === MANAGED, r.req?.key ?? r.err);
    }

    console.log("\nLocalhost still runs on the developer's .env.local");
    // A laptop's .env.local carries the bare names; explicit ORBIT_MANAGED_* names would
    // outrank them (a deliberately configured managed key), so this case clears them.
    for (const p of ["GEMINI", "OPENAI", "ANTHROPIC"]) delete process.env[`ORBIT_MANAGED_${p}_API_KEY`];
    setNodeEnv("development");
    check(
    "…and only then does a key count as configured",
    MANAGED_PROVIDER_ORDER.every((p) => managedKeysConfigured()[p]) &&
      // OpenRouter is never a managed provider — Orbit holds no key for it.
      !managedKeysConfigured().openrouter
  );
    let local = await lastSent(() => json(U.localDev));
    check("`next dev`: the key from .env.local went on the wire", local.req?.key === DEV_KEY, local.req?.key ?? local.err);
    // A stored `gemini-2.5-pro` now migrates on read (`LEGACY_MODEL_MAP`) to
    // `gemini-3.8-flash` — Google 404s the old id, so the wire request must carry the
    // remapped model, not the broken one Settings still has on file.
    await account(U.localDev, { aiModel: "gemini-2.5-pro" });
    local = await lastSent(() => json(U.localDev));
    check("…at the managed default, with no credits to meter it",
      new RegExp(`models/${MANAGED_DEFAULT_MODELS.gemini}:`).test(local.req?.url ?? ""), local.req?.url ?? local.err);
    const localStatus = await getAiAccessStatus(U.localDev);
    check("…and the UI says AI will run, with no credits to show",
      localStatus.ready && localStatus.source === "managed" && localStatus.credits === null, JSON.stringify(localStatus));
    await db.update(userSettings).set(ownKey()).where(eq(userSettings.userId, U.localDev));
    local = await lastSent(() => json(U.localDev));
    check("a saved key still wins over .env.local", local.req?.key === USER_KEY, local.req?.key ?? local.err);

    console.log("\nThe decision model: the account's own TypeSafe key, or .env.local on a dev server");
    let decision = (await resolveAiAccess(U.localDev)).decision("chat.rerank.decide");
    check("`next dev`: .env.local's TypeSafe key backs a decision grant",
      decision?.provider === "typesafe" && decision.source === "managed", JSON.stringify(decision));
    await db.update(userSettings).set({ typesafeApiKeyEncrypted: encrypt("user-typesafe-key") }).where(eq(userSettings.userId, U.localDev));
    decision = (await resolveAiAccess(U.localDev)).decision("chat.rerank.decide");
    check("…and a saved TypeSafe key wins over it, on the user's bill",
      decision?.source === "personal" && decision.keyOwner === "user", JSON.stringify(decision));
    process.env.ORBIT_JEV = "off";
    check("ORBIT_JEV=off: no decision grant, even with a key saved",
      (await resolveAiAccess(U.localDev)).decision("chat.rerank.decide") === null);
    delete process.env.ORBIT_JEV;
    await db.update(userSettings).set({ typesafeApiKeyEncrypted: null }).where(eq(userSettings.userId, U.localDev));

    process.env.ORBIT_DEMO_MANAGED_AI = "off";
    await account(U.localDev, {});
    local = await lastSent(() => json(U.localDev));
    const metered = await getAiAccessStatus(U.localDev);
    check("ORBIT_DEMO_MANAGED_AI=off: localhost sees what a deployment sees — a Free account, metered",
      local.req?.key === DEV_KEY && metered.eligibility === "plan" && metered.credits !== null, JSON.stringify(metered));
    delete process.env.ORBIT_DEMO_MANAGED_AI;

    process.env.VERCEL = "1";
    local = await lastSent(() => json(U.localDev));
    check("a Vercel runtime never reaches .env.local, whatever NODE_ENV says",
      isAiAccessError(local.err) && local.count === 0, local.req?.key ?? local.err);
    delete process.env.VERCEL;
    setNodeEnv("production");
    local = await lastSent(() => json(U.localDev));
    const prodStatus = await getAiAccessStatus(U.localDev);
    check("neither does a production build off Vercel: no demo exemption, the account is metered",
      prodStatus.eligibility === "plan" && prodStatus.credits !== null, JSON.stringify(prodStatus));
    setNodeEnv(undefined);

    console.log("\nA grant cannot be forged");
    const forged = Object.freeze({ provider: "gemini", model: "x", source: "managed", keyOwner: "orbit", operation: "x" }) as AiGrant;
    let threw = false;
    try {
      await geminiClient(forged);
    } catch {
      threw = true;
    }
    check("a hand-built grant gets no client", threw);
    const forgedDecision = Object.freeze({ provider: "typesafe", model: "x", source: "personal", keyOwner: "user", operation: "x" }) as DecisionGrant;
    threw = false;
    try {
      typesafeClient(forgedDecision);
    } catch {
      threw = true;
    }
    check("…nor does a hand-built decision grant", threw);
  } finally {
    for (const p of ["GEMINI", "OPENAI", "ANTHROPIC"]) {
      delete process.env[`${p}_API_KEY`];
      delete process.env[`ORBIT_MANAGED_${p}_API_KEY`];
    }
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ORBIT_JEV;
    process.env.ORBIT_MANAGED_GEMINI_API_KEY = MANAGED;
    if (saved.VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.VERCEL;
    if (saved.DEMO === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = saved.DEMO;
    setNodeEnv(saved.NODE_ENV);
  }
}

/** `user_settings` statements issued while `fn` runs (the query counter is process-wide). */
async function settingsReads(fn: () => Promise<unknown>): Promise<{ reads: number; err: unknown }> {
  startQueryCount();
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    stopQueryCount();
  }
  return { reads: capturedQueries().filter((q) => /"user_settings"/.test(q)).length, err };
}

/**
 * One request, one account read (`AiAccess.forUser`, `AiAccess.open({ row })`): a request that makes
 * several model calls — `/api/chat` makes up to nine — resolves the account once and passes
 * it down. What must NOT be shared is pinned too: each call still mints its own grant and
 * writes its own usage row, and an access for one account can never pay for another.
 * (The managed allowance on a shared access is pinned in `transitions()`.)
 */
async function sharedAccess() {
  const db = await getDb();
  await account(U.shared, ownKey());
  await account(U.other, ownKey());
  __clearEmbeddingCacheForTests();

  console.log("\nOne account read per request");
  // The old shape: scope and embedding each opened the account for themselves.
  const unshared = await settingsReads(() =>
    getQueryEmbedding(U.shared, "who knows rust", (u, t) => createEmbedding(u, t), (u) => defaultResolveScope(u)),
  );
  check("a query embedding with separately-opened halves reads user_settings twice (the old cost)", unshared.reads === 2, `${unshared.reads} ${String(unshared.err)}`);
  __clearEmbeddingCacheForTests();
  let r = await lastSent(() => getQueryEmbedding(U.shared, "who knows rust"));
  check("getQueryEmbedding still embeds on the account's own key", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  __clearEmbeddingCacheForTests();
  const shared = await settingsReads(() => getQueryEmbedding(U.shared, "who knows rust"));
  check("getQueryEmbedding: scope + embedding now share ONE user_settings read", shared.reads === 1, `${shared.reads} ${String(shared.err)}`);
  const hit = await settingsReads(() => getQueryEmbedding(U.shared, "who knows rust"));
  check("…and a cache hit costs that one read, as before", hit.reads === 1, String(hit.reads));

  const access = await resolveAiAccess(U.shared);
  __clearEmbeddingCacheForTests();
  const passed = await settingsReads(() =>
    getQueryEmbedding(U.shared, "who knows go", createEmbedding, defaultResolveScope, { access }),
  );
  check("with the request's access passed in: no user_settings read at all", passed.reads === 0, `${passed.reads} ${String(passed.err)}`);
  check("resolveEmbeddingBackend on a passed access agrees with a fresh open",
    (await resolveEmbeddingBackend(U.shared, access)).backend === (await resolveEmbeddingBackend(U.shared)).backend);

  const before = sent.length;
  const calls = await settingsReads(async () => {
    await completeJson(U.shared, { system: "Return JSON.", user: "hi", operation: "chat.understand", access });
    await completeJsonOn(access)(U.shared, { system: "Return JSON.", user: "hi", operation: "chat.title" });
    await createEmbedding(U.shared, "a contact", access);
  });
  check("three model calls on one access: zero user_settings reads", calls.reads === 0, `${calls.reads} ${String(calls.err)}`);
  check("…each still went out on the account's own key", sent.length - before === 3 && sent.slice(before).every((x) => x.key === USER_KEY), sent.slice(before).map((x) => x.key).join(","));
  await settle();
  const usage = await db.select({ op: usageEvents.operation, owner: usageEvents.keyOwner }).from(usageEvents).where(eq(usageEvents.userId, U.shared));
  check("…and each wrote its own usage row (accounting is per call, not per access)",
    ["chat.understand", "chat.title", "search.embed"].every((op) => usage.some((u) => u.op === op && u.owner === "user")),
    usage.map((u) => u.op).join(","));

  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, U.shared) });
  const fromRow = await settingsReads(() => resolveAiAccess(U.shared, { row: row ?? null }));
  check("AiAccess.open with the caller's row: no read of its own", fromRow.reads === 0, String(fromRow.reads));
  const viaRow = await resolveAiAccess(U.shared, { row: row ?? null });
  check("…and resolves exactly what its own read would",
    JSON.stringify(viaRow.facts()) === JSON.stringify(access.facts()) && viaRow.plan === access.plan && viaRow.eligibility === access.eligibility);
  const noRow = await resolveAiAccess(U.freeNone + "-missing", { row: null });
  const noRowGrant = await noRow.completion("chat.answer").catch(() => null);
  check("a null row is 'no row': a Free account with no key, on Orbit's metered key",
    noRowGrant?.source === "managed" && noRow.plan === "free");

  console.log("\nA shared access never crosses accounts");
  r = await lastSent(() => completeJson(U.other, { system: "Return JSON.", user: "hi", operation: "chat.answer", access }));
  check("another account's access is refused before anything is sent", r.err instanceof Error && r.count === 0, r.err);
  r = await lastSent(() => createEmbedding(U.other, "a contact", access));
  check("…for embeddings too", r.err instanceof Error && r.count === 0, r.err);
  let crossed = false;
  try {
    access.forUser(U.other);
  } catch {
    crossed = true;
  }
  check("AiAccess.forUser refuses a mismatched account", crossed);
  check("AiAccess.open refuses another account's row", await resolveAiAccess(U.other, { row: row ?? null }).then(() => false, () => true));
}

/**
 * `run-smoke` shares one PGlite directory across scripts, and the ops sweep and admin
 * readers scan every account — so the Lifetime accounts, managed usage and managed-failure
 * events this script creates would open alerts in `smoke-ops-sweep` if left behind.
 */
async function cleanup() {
  const db = await getDb();
  const users = Object.values(U);
  await db.delete(usageEvents).where(inArray(usageEvents.userId, users));
  await db.delete(creditGrants).where(like(creditGrants.userId, "smoke-aia-%"));
  await db.delete(creditHolds).where(like(creditHolds.userId, "smoke-aia-%"));
  await db.delete(billingEvents).where(inArray(billingEvents.userId, users));
  await db.delete(userSettings).where(inArray(userSettings.userId, users));
  await db.delete(errorEvents).where(eq(errorEvents.source, "ai.managed"));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "lifetime-confirm:smoke-aia-%"));
}

run(async () => {
  sourceGuard();
  purePolicy();
  await cleanup();
  try {
    await realGate();
    await transitions();
    await localDevAndByok();
    await sharedAccess();
  } finally {
    await cleanup();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nsmoke-ai-access: all checks passed");
});
