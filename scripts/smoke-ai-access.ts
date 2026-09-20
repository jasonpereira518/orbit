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
for (const name of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "WISPR_API_KEY"]) {
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
import type Stripe from "stripe";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { billingEvents, errorEvents, rateLimitBuckets, usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { priceFor } from "../src/lib/ai-pricing";
import type { AiOperationId } from "../src/lib/ai-operations";
import {
  AiAccessError,
  aiReadyFromSettings,
  geminiClient,
  getAiAccessStatus,
  isAiAccessError,
  managedKeysConfigured,
  resolveAiAccess,
  runOnGrant,
  type AiGrant,
} from "../src/lib/ai-access";
import {
  AI_ACCESS_COPY,
  MANAGED_PROVIDER_FAILURE_MESSAGE,
  aiDenialFromMessage,
} from "../src/lib/ai-access-copy";
import {
  MANAGED_AI_BUDGET,
  MANAGED_AI_ENABLED,
  MANAGED_DEFAULT_MODELS,
  MANAGED_MODELS,
  chooseCompletionKey,
  chooseEmbeddingKey,
  managedCallAllowed,
  managedEligibility,
  type KeyFacts,
} from "../src/lib/managed-ai-policy";
import { completeJson, createEmbedding, transcribeAudioWithAI, transcribeImagePages } from "../src/lib/ai";
import { friendlyError, isMissingAiApiKeyError } from "../src/lib/errors";
import { confirmLifetimeCheckout, judgeLifetimeSession } from "../src/lib/lifetime-checkout";
import { LIFETIME_METADATA_KEY, LIFETIME_METADATA_VALUE } from "../src/lib/stripe";
import { setLifetimePurchase } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${String(detail)}`}`);
  }
}

async function refusal(p: Promise<unknown>): Promise<AiAccessError | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isAiAccessError(err) ? err : null;
  }
}

/* ------------------------------------------------------------------ fetch stub ------- */

type Sent = { url: string; key: string | null };
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
  sent.push({ url, key });
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
  return realFetch(input, init);
}) as typeof fetch;

/* ---------------------------------------------------------------- source guard ------- */

/**
 * Paths are returned with forward slashes on every platform.
 *
 * `join` uses the OS separator, so on Windows this yielded `src\lib\ai-access.ts` while every
 * exemption below is written `src/lib/ai-access.ts`. Nothing matched, and the guard reported
 * the gate itself — plus `wispr.ts` and its own source file — as offenders on a clean tree.
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

function sourceGuard() {
  console.log("\nOnly the gate can reach a provider");
  const SDKS = ["@google/genai", "openai", "@anthropic-ai/sdk"];
  const valueImport = new RegExp(
    String.raw`^\s*import\s+(?!type\b)[^;]*?from\s+["'](${SDKS.map((s) => s.replace(/[/@.-]/g, (c) => `\\${c}`)).join("|")})["']`,
    "m",
  );
  const dynamicImport = new RegExp(String.raw`import\(\s*["'](${SDKS.map((s) => s.replace(/[/@.-]/g, (c) => `\\${c}`)).join("|")})["']\s*\)`);
  const construct = /new\s+(GoogleGenAI|OpenAI|Anthropic)\s*\(/;
  const envKey = /process\.env(\.|\[\s*["'`])(ORBIT_MANAGED_[A-Z_]*|GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|WISPR_API_KEY|GOOGLE_API_KEY)\b/;
  const wisprCall = /\btranscribeWithWispr\s*\(/;
  const providerHost = /generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/;

  const offenders: string[] = [];
  for (const file of [...walk("src"), ...walk("scripts")]) {
    if (file === GATE || file === "scripts/smoke-ai-access.ts") continue;
    const src = readFileSync(file, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const probe = file === KEY_PROBE;
    if (!probe && (valueImport.test(code) || dynamicImport.test(code))) offenders.push(`${file}: imports an AI SDK`);
    if (!probe && construct.test(code)) offenders.push(`${file}: constructs an AI client`);
    if (envKey.test(code) && file !== "scripts/smoke-contact-brief.ts") offenders.push(`${file}: reads an AI key from the environment`);
    if (wisprCall.test(code) && file !== "src/lib/wispr.ts") offenders.push(`${file}: calls Wispr directly`);
    if (providerHost.test(code)) offenders.push(`${file}: talks to a provider host directly`);
  }
  check("no file outside the gate imports an SDK, builds a client, reads a key or calls a provider", offenders.length === 0, offenders.join("\n       "));

  const gate = readFileSync(GATE, "utf8");
  check("the gate itself holds all three SDK constructors", ["new GoogleGenAI(", "new OpenAI(", "new Anthropic("].every((c) => gate.includes(c)));
  const ai = readFileSync("src/lib/ai.ts", "utf8");
  check("ai.ts imports the SDKs for types only", !valueImport.test(ai) && /import type OpenAI/.test(ai));
  check("every ai.ts provider path starts at resolveAiAccess", (ai.match(/resolveAiAccess\(/g) ?? []).length >= 6);
}

/* ------------------------------------------------------------------ pure policy ------ */

const facts = (over: Partial<KeyFacts>): KeyFacts => ({
  eligibility: null,
  selectedProvider: "gemini",
  selectedModel: "gemini-3.5-flash",
  personal: { gemini: false, openai: false, anthropic: false },
  managed: { gemini: true, openai: false, anthropic: false },
  ...over,
});

function purePolicy() {
  console.log("\nThe rule, as a matrix");
  const own = { gemini: true, openai: false, anthropic: false };
  const pick = (f: KeyFacts) => {
    const c = chooseCompletionKey(f);
    return c.ok ? `${c.source}:${c.provider}:${c.model}` : `refused:${c.reason}`;
  };
  check("Lifetime + own key → their key, their model", pick(facts({ eligibility: "lifetime", personal: own })) === "personal:gemini:gemini-3.5-flash");
  check("Lifetime + no key → Orbit's key", pick(facts({ eligibility: "lifetime" })) === "managed:gemini:gemini-3.5-flash");
  check("non-Lifetime + own key → their key", pick(facts({ personal: own })) === "personal:gemini:gemini-3.5-flash");
  check("non-Lifetime + no key → refused, never Orbit's key", pick(facts({})) === "refused:key_required");
  check("non-Lifetime + no key + managed keys configured → still refused", pick(facts({ managed: { gemini: true, openai: true, anthropic: true } })) === "refused:key_required");
  check("Lifetime + no key + no managed key → managed_unavailable", pick(facts({ eligibility: "lifetime", managed: { gemini: false, openai: false, anthropic: false } })) === "refused:managed_unavailable");
  check("Pro resolves to no managed eligibility", managedEligibility("orbit", false) === null && managedEligibility("free", false) === null);
  if (MANAGED_AI_ENABLED) {
    check("Lifetime and demo are eligible", managedEligibility("lifetime", false) === "lifetime" && managedEligibility("free", true) === "demo");
  } else {
    check("managed AI is off: no plan is eligible, not even Lifetime",
      managedEligibility("lifetime", false) === null && managedEligibility("free", false) === null);
    check("…and 'demo' is the localhost dev-key path only", managedEligibility("free", true) === "demo");
  }
  check("a demo account with no key anywhere is told to add one — it was never promised Orbit's AI",
    pick(facts({ eligibility: "demo", managed: { gemini: false, openai: false, anthropic: false } })) === "refused:key_required");

  console.log("\nManaged keys run managed models");
  // The allowlist protects Orbit's money; with managed AI off the only key behind that path
  // is the developer's own, so `next dev` runs the model Settings asks for.
  check(
    MANAGED_AI_ENABLED
      ? "an expensive model on Orbit's key is downgraded"
      : "managed AI off: the local dev key runs the model that was asked for",
    pick(facts({ eligibility: "lifetime", selectedModel: "gemini-2.5-pro" })) ===
      (MANAGED_AI_ENABLED ? `managed:gemini:${MANAGED_DEFAULT_MODELS.gemini}` : "managed:gemini:gemini-2.5-pro"));
  check("…the same model on their own key is theirs to choose",
    pick(facts({ eligibility: "lifetime", selectedModel: "gemini-2.5-pro", personal: own })) === "personal:gemini:gemini-2.5-pro");
  check("an Anthropic user on Lifetime with only a managed Gemini key runs on Gemini",
    pick(facts({ eligibility: "lifetime", selectedProvider: "anthropic", selectedModel: "claude-opus-4" })) === `managed:gemini:${MANAGED_DEFAULT_MODELS.gemini}`);
  check("every managed model is priced (an unpriced one would slip under the dollar cap)",
    Object.values(MANAGED_MODELS).flat().every((m) => priceFor(m) !== null));

  console.log("\nEmbeddings");
  const emb = (f: KeyFacts) => {
    const c = chooseEmbeddingKey(f);
    return c.ok ? `${c.source}:${c.provider}` : `refused:${c.reason}`;
  };
  check("Anthropic-only, not Lifetime → refused", emb(facts({ selectedProvider: "anthropic", personal: { gemini: false, openai: false, anthropic: true } })) === "refused:key_required");
  check("Anthropic-only on Lifetime → Orbit's Gemini", emb(facts({ eligibility: "lifetime", selectedProvider: "anthropic", personal: { gemini: false, openai: false, anthropic: true } })) === "managed:gemini");
  check("a personal OpenAI key beats a managed Gemini one", emb(facts({ eligibility: "lifetime", personal: { gemini: false, openai: true, anthropic: false } })) === "personal:openai");

  console.log("\nThe allowance");
  const cap = MANAGED_AI_BUDGET.monthlyCostMicros;
  check("under the cap → allowed", managedCallAllowed({ spentMicros: cap - 1, calls: 0 }, "chat.answer"));
  check("at the cap → refused", !managedCallAllowed({ spentMicros: cap, calls: 0 }, "chat.answer"));
  check("the call ceiling holds even with no cost", !managedCallAllowed({ spentMicros: 0, calls: MANAGED_AI_BUDGET.monthlyCalls }, "chat.answer"));
  check("bulk background work stops at its share", !managedCallAllowed({ spentMicros: cap * 0.6, calls: 0 }, "import.linkedin.timeline"));
  check("…while the person still has the rest", managedCallAllowed({ spentMicros: cap * 0.6, calls: 0 }, "chat.answer"));

  console.log("\nThe words");
  for (const [reason, copy] of Object.entries(AI_ACCESS_COPY)) {
    check(`${reason}: house voice (no trailing period, curly apostrophes, no "failed")`,
      !copy.trimEnd().endsWith(".") && !/\w'\w/.test(copy) && !/\bfailed\b/i.test(copy), copy);
    check(`${reason}: friendlyError passes it through verbatim`, friendlyError(new Error(copy), "fallback") === copy);
    check(`${reason}: reads back as itself`, aiDenialFromMessage(copy) === reason);
    check(
      `${reason}: ${reason === "upgrade_pending" ? "does NOT" : "does"} flip the UI into "add a key"`,
      isMissingAiApiKeyError(copy) === (reason !== "upgrade_pending"),
    );
  }
  check("the managed-failure copy passes through and reads as managed_unavailable",
    friendlyError(new Error(MANAGED_PROVIDER_FAILURE_MESSAGE), "x") === MANAGED_PROVIDER_FAILURE_MESSAGE &&
      aiDenialFromMessage(MANAGED_PROVIDER_FAILURE_MESSAGE) === "managed_unavailable");

  console.log("\nA returned checkout session");
  const NOW = new Date("2026-09-15T12:00:00Z");
  const session = (over: Record<string, unknown> = {}) => ({
    id: "cs_test_1",
    client_reference_id: "u1",
    metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
    status: "complete",
    payment_status: "paid",
    created: Math.floor(NOW.getTime() / 1000) - 60,
    payment_intent: { latest_charge: { refunded: false, disputed: false } },
    ...over,
  }) as Parameters<typeof judgeLifetimeSession>[0];
  const kind = (s: Parameters<typeof judgeLifetimeSession>[0], user = "u1") => {
    const v = judgeLifetimeSession(s, user, NOW);
    return v.kind === "refused" ? `refused:${v.reason}` : v.kind;
  };
  check("paid → paid", kind(session()) === "paid");
  check("async payment not settled → processing", kind(session({ payment_status: "unpaid" })) === "processing");
  check("still open → open", kind(session({ status: "open", payment_status: "unpaid" })) === "open");
  check("expired → expired", kind(session({ status: "expired" })) === "expired");
  check("someone else's session → refused", kind(session(), "u2") === "refused:not_yours");
  check("a Pro session → refused", kind(session({ metadata: { [LIFETIME_METADATA_KEY]: "orbit" } })) === "refused:not_lifetime");
  check("older than a day → refused", kind(session({ created: Math.floor(NOW.getTime() / 1000) - 2 * 86400 })) === "refused:too_old");
  check("refunded → refused (a replay must not undo a refund)", kind(session({ payment_intent: { latest_charge: { refunded: true } } })) === "refused:reversed");
  check("disputed → refused", kind(session({ payment_intent: { latest_charge: { disputed: true } } })) === "refused:reversed");
}

/* ------------------------------------------------------------------- real gate ------- */

const USER_KEY = "user-gemini-key";
const MANAGED = "managed-gemini-key";
const U = {
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
};

async function account(userId: string, cols: Partial<typeof userSettings.$inferInsert>) {
  const db = await getDb();
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

/** Usage rows are written fire-and-forget; give them a tick to land. */
const settle = () => new Promise((r) => setTimeout(r, 150));

async function realGate() {
  await account(U.lifetimeOwn, { lifetimePurchasedAt: PAST, ...ownKey() });
  await account(U.lifetimeNone, { lifetimePurchasedAt: PAST, aiModel: "gemini-2.5-pro" });
  await account(U.freeOwn, ownKey());
  await account(U.freeNone, {});
  await account(U.proNone, { subscriptionPlan: "orbit", subscriptionStatus: "active" });
  await account(U.compNone, { compedPlan: "lifetime" });

  console.log("\nThe matrix, through the real SDK calls (completions)");
  let r = await lastSent(() => json(U.lifetimeOwn));
  check("Lifetime + own key: their key went on the wire", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.lifetimeNone));
  check("Lifetime + no key: Orbit's managed key went on the wire", r.req?.key === MANAGED, r.req?.key ?? r.err);
  check(
    "…at the managed model, not the gemini-2.5-pro they picked",
    (r.req?.url ?? "").includes(`models/${MANAGED_DEFAULT_MODELS.gemini}:`),
    r.req?.url
  );
  r = await lastSent(() => json(U.freeOwn));
  check("non-Lifetime + own key: their key went on the wire", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => json(U.freeNone));
  check("non-Lifetime + no key: refused with a typed error", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "key_required", r.err);
  check("…and nothing was sent anywhere", r.count === 0);
  r = await lastSent(() => json(U.proNone));
  check("Pro + no key: refused too — the rule is Lifetime, not paid", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "key_required", r.err);
  r = await lastSent(() => json(U.compNone));
  check("comped Lifetime + no key: managed", r.req?.key === MANAGED, r.req?.key ?? r.err);

  await settle();
  const db = await getDb();
  const owners = async (userId: string) =>
    (await db.select({ o: usageEvents.keyOwner }).from(usageEvents).where(eq(usageEvents.userId, userId))).map((x) => x.o);
  check("usage records Orbit as the payer for the managed call", (await owners(U.lifetimeNone)).every((o) => o === "orbit") && (await owners(U.lifetimeNone)).length > 0);
  check("…and the user for their own key, even on Lifetime", (await owners(U.lifetimeOwn)).every((o) => o === "user"));

  console.log("\nEmbeddings and transcription use the same gate");
  r = await lastSent(() => createEmbedding(U.lifetimeNone, "a contact"));
  check("Lifetime + no key: embedding on the managed key", r.req?.key === MANAGED, r.req?.key ?? r.err);
  r = await lastSent(() => createEmbedding(U.freeNone, "a contact"));
  check("non-Lifetime + no key: embedding refused, nothing sent", isAiAccessError(r.err) && r.count === 0, r.err);
  const audio = { mimeType: "audio/webm", base64: Buffer.from("fake audio").toString("base64") };
  r = await lastSent(() => transcribeAudioWithAI(U.lifetimeNone, audio));
  check("Lifetime + no key: transcription on Orbit's Gemini", r.req?.key === MANAGED && (r.result as { engine?: string })?.engine === "gemini", r.req?.key ?? r.err);
  r = await lastSent(() => transcribeAudioWithAI(U.freeOwn, audio));
  check("own Gemini key: transcription on their key", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  r = await lastSent(() => transcribeAudioWithAI(U.freeNone, audio));
  check("no key: transcription refused, nothing sent", isAiAccessError(r.err) && r.count === 0, r.err);
  const pages = await transcribeImagePages(U.freeNone, [{ mimeType: "image/jpeg", base64: "AAAA" }]);
  check("photo OCR with no key reports the key message per page, sends nothing",
    pages[0]?.ok === false && isMissingAiApiKeyError(pages[0]?.error), pages[0]?.error);

  console.log("\nWhat the UI is told");
  const status = async (u: string) => {
    const s = await getAiAccessStatus(u);
    return `${s.ready}:${s.reason}:${s.source}`;
  };
  check("Lifetime + own key → ready on their key", (await status(U.lifetimeOwn)) === "true:null:personal");
  check("Lifetime + no key → ready on Orbit's", (await status(U.lifetimeNone)) === "true:null:managed");
  check("non-Lifetime + own key → ready", (await status(U.freeOwn)) === "true:null:personal");
  check("non-Lifetime + no key → add a key", (await status(U.freeNone)) === "false:key_required:null");
  for (const u of [U.lifetimeOwn, U.lifetimeNone, U.freeOwn, U.freeNone, U.proNone]) {
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, u) });
    check(`the notification alert agrees with the gate (${u})`, aiReadyFromSettings(u, row ?? null) === (await getAiAccessStatus(u)).ready);
  }

  console.log("\nA grant cannot be forged");
  const forged = Object.freeze({ provider: "gemini", model: "x", source: "managed", keyOwner: "orbit", operation: "x" }) as AiGrant;
  let threw = false;
  try {
    geminiClient(forged);
  } catch {
    threw = true;
  }
  check("a hand-built grant gets no client", threw);
  const real = await (await resolveAiAccess(U.lifetimeNone)).completion("x");
  threw = false;
  try {
    (await import("../src/lib/ai-access")).openaiClient(real);
  } catch {
    threw = true;
  }
  check("a Gemini grant does not open an OpenAI client", threw);
}

async function transitions() {
  const db = await getDb();

  console.log("\nBuying Lifetime mid-session, no reload");
  await account(U.buyer, {});
  let r = await lastSent(() => json(U.buyer));
  check("before: refused", isAiAccessError(r.err));
  await setLifetimePurchase(U.buyer, { stripeCustomerId: "cus_smoke" });
  r = await lastSent(() => json(U.buyer));
  check("the very next call runs on Orbit's key", r.req?.key === MANAGED, r.req?.key ?? r.err);

  console.log("\nA refund or revocation mid-session");
  // What the launch plan's `revokeLifetimePurchase` writes on a full refund or lost dispute.
  await db.update(userSettings).set({ lifetimePurchasedAt: null }).where(eq(userSettings.userId, U.buyer));
  r = await lastSent(() => json(U.buyer));
  check("the next call is refused — typed, not a crash", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "key_required", r.err);
  check("…and nothing is sent on Orbit's key", r.count === 0);

  console.log("\nAn own key survives buying Lifetime");
  await account(U.keeper, ownKey());
  await setLifetimePurchase(U.keeper, {});
  r = await lastSent(() => json(U.keeper));
  check("still their key after the upgrade", r.req?.key === USER_KEY, r.req?.key ?? r.err);
  await db.update(userSettings).set({ geminiApiKeyEncrypted: null }).where(eq(userSettings.userId, U.keeper));
  r = await lastSent(() => json(U.keeper));
  check("clearing it is the explicit switch to Orbit's", r.req?.key === MANAGED, r.req?.key ?? r.err);

  console.log("\nThe allowance running out");
  await account(U.capped, { lifetimePurchasedAt: PAST });
  await db.insert(usageEvents).values({
    userId: U.capped, operation: "chat.answer", provider: "gemini", model: "gemini-3.5-flash",
    kind: "completion", keyOwner: "orbit", estimatedCostMicros: MANAGED_AI_BUDGET.monthlyCostMicros * 0.6, success: 1,
  });
  r = await lastSent(() => json(U.capped, "import.linkedin.timeline"));
  check("background work stops at its share", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" && r.count === 0, r.err);
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("…while the person can still ask", r.req?.key === MANAGED, r.err);
  await db.insert(usageEvents).values({
    userId: U.capped, operation: "chat.answer", provider: "gemini", model: "gemini-3.5-flash",
    kind: "completion", keyOwner: "orbit", estimatedCostMicros: MANAGED_AI_BUDGET.monthlyCostMicros, success: 1,
  });
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("past the cap: refused as managed_limit, nothing sent", isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" && r.count === 0, r.err);
  check("…with words that say so", friendlyError(r.err, "x") === AI_ACCESS_COPY.managed_limit);
  check("…and the UI is told the same", (await getAiAccessStatus(U.capped)).reason === "managed_limit");
  await db.update(userSettings).set(ownKey()).where(eq(userSettings.userId, U.capped));
  r = await lastSent(() => json(U.capped, "chat.answer"));
  check("adding their own key gets them going again", r.req?.key === USER_KEY, r.err);

  console.log("\nThe kill switch");
  process.env.ORBIT_MANAGED_AI = "off";
  r = await lastSent(() => json(U.lifetimeNone));
  check("ORBIT_MANAGED_AI=off: Lifetime + no key → managed_unavailable, nothing sent",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_unavailable" && r.count === 0, r.err);
  r = await lastSent(() => json(U.lifetimeOwn));
  check("…own keys are untouched", r.req?.key === USER_KEY);
  delete process.env.ORBIT_MANAGED_AI;

  console.log("\nOrbit's key refused by the provider");
  respondWith = "key_refused";
  r = await lastSent(() => json(U.lifetimeNone));
  check("the Lifetime user is not told to fix a key they never gave",
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

  console.log("\nA paid checkout whose webhook has not landed");
  const fake = (over: Record<string, unknown>) => async (id: string) =>
    ({
      id,
      client_reference_id: U.pending,
      metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
      status: "complete",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 30,
      amount_total: 2500,
      currency: "usd",
      customer: "cus_pending",
      payment_intent: { id: "pi_1", latest_charge: { refunded: false, disputed: false } },
      ...over,
    }) as unknown as Stripe.Checkout.Session;

  await account(U.asyncPayer, { lifetimeCheckoutSessionId: "cs_test_async", lifetimeCheckoutStartedAt: new Date() });
  const asyncAccess = await resolveAiAccess(U.asyncPayer, {
    retrieveSession: async (id) => ({ ...(await fake({ payment_status: "unpaid" })(id)), client_reference_id: U.asyncPayer }),
  });
  const pendingErr = await refusal(asyncAccess.completion("chat.answer"));
  check("payment still clearing → upgrade_pending, not 'add a key'", pendingErr?.reason === "upgrade_pending", pendingErr);
  check("…and nothing was granted", (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, U.asyncPayer) }))?.lifetimePurchasedAt == null);

  await account(U.pending, { lifetimeCheckoutSessionId: "cs_test_paid", lifetimeCheckoutStartedAt: new Date() });
  const paidAccess = await resolveAiAccess(U.pending, { retrieveSession: fake({}) });
  check("paid but no webhook yet → the gate asks Stripe and grants on the spot", paidAccess.plan === "lifetime");
  const g = await paidAccess.completion("chat.answer");
  check("…and this very call runs on Orbit's key", g.source === "managed");
  const after = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, U.pending) });
  check("…the pending checkout is cleared", after?.lifetimeCheckoutSessionId === null);
  const verdict = await confirmLifetimeCheckout(U.pending, "cs_test_paid", new Date(), fake({}));
  check("confirming again (the webhook, or the success page) is harmless", verdict.kind === "paid");
  const booked = await db.select().from(billingEvents).where(and(eq(billingEvents.userId, U.pending), eq(billingEvents.kind, "lifetime")));
  check("…one Lifetime booking, keyed on the session — the webhook's key", booked.length === 1 && booked[0]?.eventId === "cs:cs_test_paid", booked.map((b) => b.eventId).join(","));
  const replay = await confirmLifetimeCheckout(U.freeNone, "cs_test_paid", new Date(), fake({}));
  check("someone else's session id grants nothing", replay.kind === "refused");
}

/** `NODE_ENV` is readonly in the Node types; the gate reads it at call time either way. */
function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/**
 * Managed AI is off: every plan is BYOK. Sets every key Orbit or a developer could hold —
 * the explicit managed names, the bare local-dev names with `VERCEL` unset so the local
 * fallback would be live, and a showcase demo account — and proves none reaches the wire.
 */
async function byokOnly() {
  const db = await getDb();
  const DEV_KEY = "dev-laptop-gemini-key";
  const saved = {
    VERCEL: process.env.VERCEL,
    DEMO: process.env.DEMO_ACCOUNT_USER_ID,
    NODE_ENV: process.env.NODE_ENV,
  };
  delete process.env.VERCEL;
  for (const p of ["GEMINI", "OPENAI", "ANTHROPIC", "WISPR"]) {
    process.env[`ORBIT_MANAGED_${p}_API_KEY`] = MANAGED;
    process.env[`${p}_API_KEY`] = DEV_KEY;
  }
  process.env.DEMO_ACCOUNT_USER_ID = U.demoNone;

  try {
    await account(U.lifetimeOwn, { lifetimePurchasedAt: PAST, ...ownKey() });
    await account(U.lifetimeNone, { lifetimePurchasedAt: PAST });
    await account(U.compNone, { compedPlan: "lifetime" });
    await account(U.demoNone, {});
    await account(U.localDev, {});
    await account(U.proNone, { subscriptionPlan: "orbit", subscriptionStatus: "active" });
    await account(U.freeNone, {});
    await account(U.freeOwn, ownKey());

    console.log("\nManaged AI is off: every plan is bring-your-own-key");
    check("no managed key counts as configured, whatever the environment holds",
      Object.values(managedKeysConfigured()).every((v) => !v));

    const keyless = [U.lifetimeNone, U.compNone, U.demoNone, U.proNone, U.freeNone];
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
      check(`${u}: the UI is told to add a key`, !s.ready && s.reason === "key_required" && s.source === null && s.allowance === null, JSON.stringify(s));
      const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, u) });
      check(`${u}: the notification alert agrees`, aiReadyFromSettings(u, row ?? null) === false);
    }

    for (const u of [U.lifetimeOwn, U.freeOwn]) {
      const r = await lastSent(() => json(u));
      check(`${u}: their own key went on the wire`, r.req?.key === USER_KEY, r.req?.key ?? r.err);
    }
    await settle();
    const owners = await db.select({ o: usageEvents.keyOwner }).from(usageEvents).where(inArray(usageEvents.userId, Object.values(U)));
    check("no usage row names Orbit as the payer", owners.length > 0 && owners.every((x) => x.o === "user"), owners.map((x) => x.o).join(","));
    check("neither Orbit's nor the developer's key ever went on the wire", sent.every((x) => x.key !== MANAGED && x.key !== DEV_KEY));

    console.log("\nA just-paid Lifetime checkout does not ask Stripe for AI");
    await account(U.pending, { lifetimeCheckoutSessionId: "cs_test_paid", lifetimeCheckoutStartedAt: new Date() });
    let asked = false;
    const access = await resolveAiAccess(U.pending, {
      retrieveSession: async () => {
        asked = true;
        throw new Error("the gate should not look up a checkout");
      },
    });
    const err = await refusal(access.completion("chat.answer"));
    check("refused as key_required, never upgrade_pending", err?.reason === "key_required", err);
    check("…without a Stripe round trip", !asked);

    console.log("\nLocalhost still runs on the developer's .env.local");
    setNodeEnv("development");
    check("…and only then does a key count as configured", Object.values(managedKeysConfigured()).every(Boolean));
    let local = await lastSent(() => json(U.localDev));
    check("`next dev`: the key from .env.local went on the wire", local.req?.key === DEV_KEY, local.req?.key ?? local.err);
    await account(U.localDev, { aiModel: "gemini-2.5-pro" });
    local = await lastSent(() => json(U.localDev));
    check("…at the model Settings asks for, with no allowance to ration it",
      /models\/gemini-2\.5-pro:/.test(local.req?.url ?? ""), local.req?.url ?? local.err);
    const localStatus = await getAiAccessStatus(U.localDev);
    check("…and the UI says AI will run, with no allowance to show",
      localStatus.ready && localStatus.source === "managed" && localStatus.allowance === null, JSON.stringify(localStatus));
    await db.update(userSettings).set(ownKey()).where(eq(userSettings.userId, U.localDev));
    local = await lastSent(() => json(U.localDev));
    check("a saved key still wins over .env.local", local.req?.key === USER_KEY, local.req?.key ?? local.err);

    process.env.ORBIT_DEMO_MANAGED_AI = "off";
    await account(U.localDev, {});
    local = await lastSent(() => json(U.localDev));
    check("ORBIT_DEMO_MANAGED_AI=off: localhost sees what a deployment sees",
      isAiAccessError(local.err) && (local.err as AiAccessError).reason === "key_required" && local.count === 0, local.err);
    delete process.env.ORBIT_DEMO_MANAGED_AI;

    process.env.VERCEL = "1";
    local = await lastSent(() => json(U.localDev));
    check("a Vercel runtime never reaches .env.local, whatever NODE_ENV says",
      isAiAccessError(local.err) && local.count === 0, local.req?.key ?? local.err);
    delete process.env.VERCEL;
    setNodeEnv("production");
    local = await lastSent(() => json(U.localDev));
    check("neither does a production build off Vercel",
      isAiAccessError(local.err) && local.count === 0, local.req?.key ?? local.err);
    setNodeEnv(undefined);

    console.log("\nA grant cannot be forged");
    const forged = Object.freeze({ provider: "gemini", model: "x", source: "managed", keyOwner: "orbit", operation: "x" }) as AiGrant;
    let threw = false;
    try {
      geminiClient(forged);
    } catch {
      threw = true;
    }
    check("a hand-built grant gets no client", threw);
  } finally {
    for (const p of ["GEMINI", "OPENAI", "ANTHROPIC", "WISPR"]) {
      delete process.env[`${p}_API_KEY`];
      delete process.env[`ORBIT_MANAGED_${p}_API_KEY`];
    }
    process.env.ORBIT_MANAGED_GEMINI_API_KEY = MANAGED;
    if (saved.VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.VERCEL;
    if (saved.DEMO === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = saved.DEMO;
    setNodeEnv(saved.NODE_ENV);
  }
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
    if (MANAGED_AI_ENABLED) {
      await realGate();
      await transitions();
    } else {
      await byokOnly();
    }
  } finally {
    await cleanup();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nsmoke-ai-access: all checks passed");
});
