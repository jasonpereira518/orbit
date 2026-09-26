# Integrations P3 — the AI page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turning AI on becomes one button — connect OpenRouter — with a guided free-Gemini paste beside it and the existing paste-your-own-key controls demoted to More options.

**Architecture:** OpenRouter becomes a fourth `AiProvider` rather than a second transport dimension, so it lands in the shape the codebase already has: one new key column, one new arm in each `Record<AiProvider, …>`, and the OpenAI SDK pointed at a different `baseURL`. The connect flow is OAuth PKCE with no client registration. The embedding order is changed so OpenRouter never displaces an existing personal key.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Drizzle + Postgres/PGlite, the OpenAI Node SDK, `tsx` smoke scripts, the TypeScript compiler API for source-level guards.

**Spec:** `docs/superpowers/specs/2026-09-23-integrations-dialog-p3-ai-design.md`

**Branch:** `claude/integrations-p3-ai`, base commit `ae506174`. PR #299 already tracks it (base `claude/settings-popup-redesign-0ed30d`).

## Global Constraints

- **Copy:** curly apostrophes (`’`) in every user-facing string — never a straight `'`. Toasts carry no trailing period, never say "failed", never surface `err.message` — use `friendlyError`. `scripts/smoke-toast-copy.ts` scans repo-wide.
- **Section ids are operator hide-list surface keys.** Never rename one; labels only.
- **No Tailwind class names inside comments** beyond what a file already contains — this repo's Tailwind scans comments.
- **`ai-access.ts` is the only path to a key.** `scripts/smoke-ai-access.ts` fails the suite if any other file imports an AI SDK, builds a client, or reads an AI key from the environment.
- **Managed AI stays off.** OpenRouter is never a managed provider: Orbit holds no OpenRouter key.
- `npx tsc --noEmit` exits 0. `npx eslint src scripts` — 0 errors, no new warnings (baseline is 0 errors / 46 warnings, none in files this phase touches).
- `npx tsx scripts/run-smoke.ts --ci` passes. Never set `SMOKE_ALLOW_REMOTE` — it points the smokes at the shared Neon database.
- Never `git stash` (bare) — the stash stack is shared across ~60 worktrees. Never `cd` out of the worktree.
- Do not start or restart a dev server except where a task says to.
- `AGENTS.md`: this repo's Next.js is not the one you remember. Read `node_modules/next/dist/docs/` before reaching for a Next API.

---

### Task 1: The provider in the types, the column, and the preset table

**Files:**
- Modify: `src/lib/ai-providers.ts`
- Modify: `src/lib/ai-models.ts`
- Modify: `src/lib/managed-ai-policy.ts`
- Modify: `src/lib/ai-access.ts` (the `decrypted` map ~line 454, `facts()` ~line 497)
- Modify: `src/db/schema.ts` (`userSettings` ~line 100, `usageEvents.provider` ~line 2467)
- Modify: `src/db/index.ts` (CREATE TABLE ~line 49, `alters` ~line 2973, changelog ~line 1750, `SCHEMA_VERSION` ~line 1762)
- Modify: `src/actions/settings.ts` (`embeddingBackendFor` ~line 182, `saveAiSettings` `nextKeyState` ~line 240, `clearApiKey` ~line 305)
- Test: `scripts/smoke-ai-providers.ts` (create), registered in `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AiProvider` includes `"openrouter"`; `EmbeddingBackend` includes `"openrouter"`; `PROVIDER_MODELS.openrouter`, `DEFAULT_MODELS.openrouter`, `FAST_MODELS.openrouter`, `VISION_MODELS.openrouter`, `EMBEDDING_MODELS.openrouter`; `userSettings.openrouterApiKeyEncrypted`.

- [ ] **Step 1: Resolve the schema version before anything else**

```bash
git fetch --all --prune -q
for r in $(git for-each-ref --format='%(refname)' refs/heads refs/remotes); do
  git show "$r:src/db/index.ts" 2>/dev/null | grep -hoE 'SCHEMA_VERSION = [0-9]+'
done | grep -oE '[0-9]+' | sort -n | uniq | tail -5
```

Take the next integer above the highest number printed. Memory of this repo: 86 is this branch, and 87–96 have been claimed by other branches at various points. Do not reuse a number. Write the number you chose into the Task 1 commit message so later tasks can see it.

- [ ] **Step 2: Write the failing smoke**

Create `scripts/smoke-ai-providers.ts`:

```ts
/**
 * Pins the provider registry. The trap this exists for: OpenRouter slugs are NOT Orbit's
 * model ids with a vendor prefix — Anthropic uses dots where Orbit uses dashes
 * (`anthropic/claude-haiku-4.5` against Orbit's `claude-haiku-4-5`), so the preset list is
 * literal and a mapping function would be a bug factory.
 */
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  resolveAiProvider,
  type AiProvider,
} from "../src/lib/ai-providers";
import { EMBEDDING_MODELS, FAST_MODELS, VISION_MODELS } from "../src/lib/ai-models";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const PROVIDERS: AiProvider[] = ["gemini", "openai", "anthropic", "openrouter"];

check("openrouter resolves", resolveAiProvider("openrouter") === "openrouter");
check("unknown still falls back to gemini", resolveAiProvider("nope") === "gemini");
check("AI_PROVIDERS lists every provider", PROVIDERS.every((p) => AI_PROVIDERS.some((e) => e.id === p)));

for (const p of PROVIDERS) {
  check(`${p} default is in its preset list`, PROVIDER_MODELS[p].some((m) => m.value === DEFAULT_MODELS[p]));
  check(`${p} fast model is in its preset list`, PROVIDER_MODELS[p].some((m) => m.value === FAST_MODELS[p]));
}

// Every OpenRouter preset is a `vendor/model` slug. A bare id here means someone assumed
// the ids were interchangeable with the direct providers'.
check(
  "every openrouter preset is a vendor/model slug",
  PROVIDER_MODELS.openrouter.every((m) => /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/.test(m.value))
);
check("openrouter vision model is a slug", VISION_MODELS.openrouter.includes("/"));
check("openrouter embedding model is a slug", EMBEDDING_MODELS.openrouter.includes("/"));
check(
  "openrouter default matches the gemini default family",
  DEFAULT_MODELS.openrouter === "google/gemini-3.8-flash"
);
check(
  "openrouter embeds with the 1536-dim OpenAI model, so nothing is truncated",
  EMBEDDING_MODELS.openrouter === "openai/text-embedding-3-small"
);

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Register it and run it to verify it fails**

Add `smoke-ai-providers` to the manifest in `scripts/run-smoke.ts` in the `pure` group, beside `smoke-ai-key-check`. An unregistered smoke fails `run-smoke --check`.

Run: `npx tsx scripts/smoke-ai-providers.ts`
Expected: FAIL to compile — `Property 'openrouter' does not exist`.

- [ ] **Step 4: Widen the unions and add the preset table**

In `src/lib/ai-providers.ts`:

```ts
export type AiProvider = "gemini" | "openai" | "anthropic" | "openrouter";
export type EmbeddingBackend = "gemini" | "openai" | "openrouter";
```

Add to `AI_PROVIDERS`:

```ts
  {
    id: "openrouter",
    label: "OpenRouter",
    keyPlaceholder: "sk-or-v1-...",
    envVar: "OPENROUTER_API_KEY",
  },
```

Add to `PROVIDER_MODELS`. **These slugs were verified against `GET https://openrouter.ai/api/v1/models` on 2026-09-23; every one advertises `response_format`, `structured_outputs`, `tools` and `tool_choice`.** Do not invent additions:

```ts
  openrouter: [
    { value: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { value: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest)" },
    { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
    { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ],
```

Add to `DEFAULT_MODELS`: `openrouter: "google/gemini-3.8-flash"`.

Extend `resolveAiProvider` to accept `"openrouter"`, and `modelBelongsToProvider`:

```ts
  if (provider === "openrouter") return model.includes("/");
```

In `src/lib/ai-models.ts`: `FAST_MODELS.openrouter = "google/gemini-3.1-flash-lite"`, `VISION_MODELS.openrouter = "google/gemini-3.8-flash"`, `EMBEDDING_MODELS.openrouter = "openai/text-embedding-3-small"`.

- [ ] **Step 5: Add the arms tsc now demands, keeping OpenRouter out of the managed path**

`npx tsc --noEmit` will now list every `Record<AiProvider, …>` missing an arm. Work the list. Two rules:

- `MANAGED_PROVIDER_ORDER` in `src/lib/managed-ai-policy.ts` stays `["gemini", "openai", "anthropic"]`. Orbit holds no OpenRouter key, so it is never a managed provider. Add a comment saying exactly that.
- `MANAGED_MODELS.openrouter = []` and `MANAGED_DEFAULT_MODELS.openrouter = "google/gemini-3.8-flash"` exist only to satisfy the record; they are unreachable because `MANAGED_PROVIDER_ORDER` excludes the provider.

In `src/lib/ai-access.ts`, add `openrouter: decryptOrNull(row?.openrouterApiKeyEncrypted)` to the `decrypted` map (~line 454), `openrouter: Boolean(this.personal.openrouter)` to `facts().personal`, and `openrouter: false` to `facts().managed` with a comment naming the reason.

- [ ] **Step 6: Add the column**

`src/db/schema.ts`, in `userSettings` beside the other key columns:

```ts
  openrouterApiKeyEncrypted: text("openrouter_api_key_encrypted"),
```

and widen `usageEvents.provider`'s `$type` to include `"openrouter"` (type-level only, no migration).

`src/db/index.ts`, all three places:

1. In the CREATE TABLE string, after `anthropic_api_key_encrypted text,`: `openrouter_api_key_encrypted text,`
2. In the `alters` array: `` `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_api_key_encrypted text`, ``
3. A changelog comment in the same voice as the v84 entry, naming the number from Step 1 and what the column is for.

Then set `SCHEMA_VERSION` to the number from Step 1, replacing the comment above it with your own rescan note and date.

- [ ] **Step 7: Thread the column through settings**

`src/actions/settings.ts`: add `openrouterApiKeyEncrypted` to `embeddingBackendFor`'s `settings` parameter type and to its `personal` object; add the `openrouter` arm to `saveAiSettings`'s `nextKeyState`; add the `openrouter` arm to `clearApiKey`'s `patch` chain. Follow the shape of the three that exist — do not restructure them.

- [ ] **Step 8: Run the checks**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-ai-providers.ts
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/run-smoke.ts --check
```

Expected: tsc silent; the new smoke all ok; `smoke-schema-ddl` ok (it is the authority on whether a column is declared in every place it must be); `--check` reports the manifest covering one more script than before.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ai-providers.ts src/lib/ai-models.ts src/lib/managed-ai-policy.ts src/lib/ai-access.ts src/db/schema.ts src/db/index.ts src/actions/settings.ts scripts/smoke-ai-providers.ts scripts/run-smoke.ts
git commit -m "Make OpenRouter a provider Orbit knows about, at schema <N>"
```

---

### Task 2: The embedding order, and a guard for the comparisons tsc cannot see

**Files:**
- Modify: `src/lib/managed-ai-policy.ts` (`EMBEDDING_ORDER` ~line 278, `chooseEmbeddingKey` ~line 286)
- Test: `scripts/smoke-ai-access.ts` (the pure policy section)
- Test: `scripts/smoke-provider-exhaustive.ts` (create), registered in `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `AiProvider`, `EmbeddingBackend` from Task 1.
- Produces: `chooseEmbeddingKey` never returns `"openrouter"` when a personal Gemini or OpenAI key exists.

- [ ] **Step 1: Write the failing checks**

Add to `scripts/smoke-ai-access.ts`'s pure policy section (find the existing `chooseEmbeddingKey` checks and put these beside them, in the same `check(...)` style the file already uses):

```ts
const noManaged = { gemini: false, openai: false, anthropic: false, openrouter: false };

check(
  "a personal gemini key still embeds when openrouter is selected",
  chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: true, openai: false, anthropic: false, openrouter: true },
    managed: noManaged,
  }).provider === "gemini"
);

check(
  "a personal openai key still embeds when openrouter is selected",
  chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: false, openai: true, anthropic: false, openrouter: true },
    managed: noManaged,
  }).provider === "openai"
);

check(
  "openrouter embeds only when there is nothing else",
  chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: false, openai: false, anthropic: false, openrouter: true },
    managed: noManaged,
  }).provider === "openrouter"
);

check(
  "an openrouter-only account can embed at all",
  chooseEmbeddingKey({
    eligibility: null,
    selectedProvider: "openrouter",
    selectedModel: "",
    personal: { gemini: false, openai: false, anthropic: false, openrouter: true },
    managed: noManaged,
  }).ok
);
```

Run: `npx tsx scripts/smoke-ai-access.ts`
Expected: the first two FAIL — the selected provider is currently placed first, so `openrouter` wins.

- [ ] **Step 2: Change the order**

In `src/lib/managed-ai-policy.ts`, replace `EMBEDDING_ORDER` and the ordering line in `chooseEmbeddingKey`:

```ts
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
```

and in `chooseEmbeddingKey`:

```ts
  const selected = facts.selectedProvider;
  // Anthropic has no embeddings API at all, and OpenRouter must not displace an existing
  // key (see EMBEDDING_ORDER) — so neither is promoted to the front.
  const order: EmbeddingBackend[] =
    selected === "anthropic" || selected === "openrouter"
      ? [...EMBEDDING_ORDER]
      : [selected, ...EMBEDDING_ORDER.filter((p) => p !== selected)];
```

- [ ] **Step 3: Run the checks to verify they pass**

Run: `npx tsx scripts/smoke-ai-access.ts`
Expected: all ok, including the four new checks and every pre-existing one.

- [ ] **Step 4: Write the exhaustiveness guard**

Create `scripts/smoke-provider-exhaustive.ts`. It parses `src/lib` with the TypeScript compiler API — **not a regex**; this repo has a documented case of a regex guard silently passing over commented-out code, and `scripts/smoke-connect-gates.ts` plus `scripts/smoke-settings-layout.ts` are the worked examples of compiler-API parsing here. Read `smoke-settings-layout.ts` first and follow its `parse` helper and its `main`-guard so the script stays import-safe.

The check: walk every `BinaryExpression` whose operator is `===` or `!==` and whose right side is a string literal equal to `"gemini"`, `"openai"` or `"anthropic"`. For each, record `file:line` and the enclosing function name. Fail on any that is not listed in an allowlist at the top of the file, where each entry carries a one-line reason it is exhaustive without an `openrouter` arm.

Seed the allowlist by running the script, reading each site, and writing the reason. A site that genuinely needs an OpenRouter arm gets the arm instead of an allowlist entry — that is the point of the guard.

- [ ] **Step 5: Register and run it**

Add `smoke-provider-exhaustive` to `scripts/run-smoke.ts` in the `pure` group.

Run: `npx tsx scripts/smoke-provider-exhaustive.ts`
Expected: all ok, with every site either fixed or allowlisted with a reason.

- [ ] **Step 6: Mutation-test the guard, then restore**

Temporarily delete one allowlist entry. Re-run: it must FAIL naming that `file:line`. Restore the entry, re-run to confirm ok, and confirm `git status --porcelain` is clean for that file before committing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/managed-ai-policy.ts scripts/smoke-ai-access.ts scripts/smoke-provider-exhaustive.ts scripts/run-smoke.ts
git commit -m "Keep an existing key embedding, and pin the provider checks tsc can’t see"
```

---

### Task 3: The client, deny routing, and the OpenAI-shaped call path

**Files:**
- Modify: `src/lib/ai-access.ts` (beside `openaiClient` ~line 245)
- Modify: `src/lib/ai.ts` (4 branches at ~571, ~708, ~878, ~2053; 6 `openaiClient(grant)` call sites)
- Modify: `src/lib/errors.ts` (`classifyAiError` ~line 452)
- Test: `scripts/smoke-ai-access.ts` (the fetch-stub section)

**Interfaces:**
- Consumes: `AiProvider` from Task 1.
- Produces: `openrouterClient(grant: AiGrant<AiProvider>): OpenAI`; `isOpenAiShaped(provider: AiProvider): boolean`; `openAiShapedClient(grant: AiGrant<AiProvider>): OpenAI`; `withOpenRouterRouting<T extends object>(provider: AiProvider, params: T): T`.

- [ ] **Step 1: Write the failing fetch-stub checks**

`scripts/smoke-ai-access.ts` already stubs `fetch` and asserts which key went on the wire, for completions, embeddings and transcription. Read that section, then add an OpenRouter case in the same shape, asserting on the captured request:

```ts
check("openrouter completions go to openrouter.ai", captured.url.startsWith("https://openrouter.ai/api/v1/"));
check("openrouter completions carry the user’s key", captured.headers.authorization === `Bearer ${USER_OPENROUTER_KEY}`);
check("openrouter completions identify Orbit", captured.headers["x-title"] === "Orbit");
check("openrouter completions carry a referer", Boolean(captured.headers["http-referer"]));
check(
  "openrouter completions refuse data collection",
  JSON.parse(captured.body).provider?.data_collection === "deny"
);
check(
  "openrouter embeddings refuse data collection",
  JSON.parse(capturedEmbed.body).provider?.data_collection === "deny"
);
check("openrouter embeddings use the 1536-dim model", JSON.parse(capturedEmbed.body).model === "openai/text-embedding-3-small");
```

Run: `npx tsx scripts/smoke-ai-access.ts`
Expected: FAIL — no OpenRouter path exists.

- [ ] **Step 2: Add the client and the routing helper**

In `src/lib/ai-access.ts`, beside the other three constructors:

```ts
/**
 * OpenRouter is the OpenAI SDK pointed somewhere else. `keyFor` keeps the invariant that a
 * grant minted for one provider cannot build another's client.
 */
export function openrouterClient(grant: AiGrant<AiProvider>): OpenAI {
  return new OpenAI({
    apiKey: keyFor(grant, "openrouter"),
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": appOrigin(),
      "X-Title": "Orbit",
    },
  });
}

/** Providers that speak the OpenAI wire format, so `ai.ts` can share one code path. */
export function isOpenAiShaped(provider: AiProvider): boolean {
  return provider === "openai" || provider === "openrouter";
}

export function openAiShapedClient(grant: AiGrant<AiProvider>): OpenAI {
  return grant.provider === "openrouter" ? openrouterClient(grant) : openaiClient(grant);
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
```

Use the repo's existing app-origin helper for `appOrigin()` — grep for how `HTTP-Referer`-shaped absolute URLs are built elsewhere (the OAuth callbacks build absolute URLs already) and reuse it rather than adding a rival.

- [ ] **Step 3: Route the four branches**

In `src/lib/ai.ts`, at each of the four `provider === "openai"` branches (~571, ~708, ~878, ~2053), change the condition to `isOpenAiShaped(provider)` (or `isOpenAiShaped(grant.provider)` at ~878), change `openaiClient(grant)` to `openAiShapedClient(grant)`, and wrap the params object passed to `.create(...)` in `withOpenRouterRouting(provider, { … })`.

There are 6 `openaiClient(grant)` call sites; convert every one that sits under a branch you just widened, and leave any that do not.

- [ ] **Step 4: Map the two errors**

In `src/lib/errors.ts`, `classifyAiError` already returns `"auth"` for `/401/` and `"quota"` via `isQuotaExhaustion`. Add a 402 rule **before** the generic ones, because OpenRouter answers 402 for an exhausted balance and the existing rules would classify it as `"other"`:

```ts
  if (/\b402\b|insufficient (credits|balance)|payment required/i.test(base)) return "quota";
```

Then give the user-facing copy an OpenRouter case wherever `"quota"` is turned into a message, saying the OpenRouter credit ran out and linking to `https://openrouter.ai/credits`. Read `src/lib/ai-access-copy.ts` and follow how the existing denial copy is written — curly apostrophes, no trailing period, never "failed".

- [ ] **Step 5: Run the checks**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-ai-access.ts
npx tsx scripts/smoke-provider-exhaustive.ts
npx tsx scripts/smoke-toast-copy.ts
```

Expected: all pass, including the seven new fetch-stub checks.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-access.ts src/lib/ai.ts src/lib/errors.ts src/lib/ai-access-copy.ts scripts/smoke-ai-access.ts
git commit -m "Send OpenRouter calls through the OpenAI path, and never let a provider keep the data"
```

---

### Task 4: Real cost, recorded as real

**Files:**
- Modify: `src/lib/usage-events.ts` (`UsageRecord` ~line 63, `recordUsage` ~line 76)
- Modify: `src/db/schema.ts` (`usageEvents`, beside `estimatedCostMicros`)
- Modify: `src/db/index.ts` (CREATE TABLE + `alters` for `usage_events.cost_source`)
- Modify: `src/lib/ai.ts` (the OpenAI-shaped `recordUsage` call sites)
- Test: `scripts/smoke-usage-events.ts`

**Interfaces:**
- Consumes: `withOpenRouterRouting` and the OpenAI-shaped path from Task 3.
- Produces: `UsageRecord.reportedCostMicros?: number | null`; `usage_events.cost_source` is `'estimated' | 'reported'`.

- [ ] **Step 1: Write the failing checks**

Add to `scripts/smoke-usage-events.ts`, in the file's existing `check(...)` style:

```ts
check(
  "a reported cost wins over the estimate",
  rowFor({ model: "google/gemini-3.8-flash", inputTokens: 1000, outputTokens: 100, reportedCostMicros: 4242 })
    .estimatedCostMicros === 4242
);
check(
  "a reported cost is stamped as reported",
  rowFor({ model: "google/gemini-3.8-flash", reportedCostMicros: 4242 }).costSource === "reported"
);
check(
  "no reported cost still estimates, and says so",
  rowFor({ model: "gemini-3.8-flash", inputTokens: 1000, outputTokens: 100 }).costSource === "estimated"
);
check(
  "a reported cost of zero is honoured, not treated as missing",
  rowFor({ model: "google/gemini-3.8-flash", reportedCostMicros: 0 }).estimatedCostMicros === 0
);
```

If `rowFor` does not exist in that smoke, write it: a thin wrapper that builds a `UsageRecord` with sensible defaults and returns the values `recordUsage` would insert. Extract that value-building into an exported pure function in `usage-events.ts` (for example `usageRow(rec: UsageRecord)`) and have `recordUsage` call it, so the smoke tests the real mapping rather than a copy of it.

Run: `npx tsx scripts/smoke-usage-events.ts`
Expected: FAIL — `reportedCostMicros` is not a field.

- [ ] **Step 2: Add the column**

`src/db/schema.ts`, in `usageEvents`:

```ts
    /**
     * Whether `estimated_cost_micros` is Orbit's own estimate from `ai-pricing.ts` or a
     * figure the provider reported. OpenRouter returns `usage.cost` on every response;
     * `ai-pricing.ts` has no OpenRouter slugs at all and is known to run about 5× low for
     * the ones it does have, so blending the two in one column without a source would make
     * that error invisible.
     */
    costSource: text("cost_source").$type<"estimated" | "reported">().default("estimated").notNull(),
```

`src/db/index.ts`: add it to the `usage_events` CREATE TABLE and to `alters` as
`` `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_source text NOT NULL DEFAULT 'estimated'`, `` and extend the Task 1 changelog entry to name this column too — it rides the same `SCHEMA_VERSION`, since Task 1 has not shipped.

- [ ] **Step 3: Prefer the reported cost**

In `src/lib/usage-events.ts`, add to `UsageRecord`:

```ts
    /**
     * The provider's own figure for what this call cost, in USD × 1e6. Null or undefined
     * means it did not report one. Zero is a real answer and must not be treated as missing.
     */
    reportedCostMicros?: number | null;
```

and in the row builder:

```ts
  const reported = rec.reportedCostMicros ?? null;
  // …
  estimatedCostMicros: reported ?? estimateCostMicros({ /* unchanged arguments */ }),
  costSource: reported === null ? "estimated" : "reported",
```

- [ ] **Step 4: Pass OpenRouter's figure through**

At the OpenAI-shaped `recordUsage` call sites in `src/lib/ai.ts`, read the cost off the response and pass it. OpenRouter always includes it; direct OpenAI does not, so the optional chain resolves to `undefined` there and nothing changes:

```ts
      reportedCostMicros:
        typeof response.usage?.cost === "number"
          ? Math.round(response.usage.cost * 1_000_000)
          : null,
```

The OpenAI SDK's `usage` type has no `cost`, so this needs a narrow local type rather than a bare `as any` — declare it beside the helper in `ai-access.ts` and export it.

- [ ] **Step 5: Run the checks**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-usage-events.ts
npx tsx scripts/smoke-schema-ddl.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/usage-events.ts src/lib/ai.ts src/lib/ai-access.ts src/db/schema.ts src/db/index.ts scripts/smoke-usage-events.ts
git commit -m "Record what OpenRouter says a call cost, and say which figure it is"
```

---

### Task 5: The connect flow

**Files:**
- Create: `src/lib/openrouter-oauth.ts` (pure: verifier, challenge, cookie encode/decode)
- Create: `src/actions/openrouter.ts` (`"use server"`)
- Create: `src/app/api/openrouter/callback/route.ts`
- Modify: `src/actions/settings.ts` (extract the write `saveAiSettings` performs, so the callback shares it)
- Test: `scripts/smoke-openrouter-oauth.ts` (create), registered in `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `openrouterApiKeyEncrypted` (Task 1), `chooseEmbeddingKey` ordering (Task 2).
- Produces: `startOpenRouterConnect(input: { returnTo?: string }): Promise<{ url: string }>`; `disconnectOpenRouter(): Promise<void>`; `OPENROUTER_STATE_COOKIE`; `createVerifier(): string`; `challengeFor(verifier: string): string`; `encodeState(...)` / `decodeState(...)`.

- [ ] **Step 1: Write the failing PKCE checks**

Create `scripts/smoke-openrouter-oauth.ts`:

```ts
/**
 * Pins the PKCE derivation and the state cookie.
 *
 * The RFC 7636 appendix-B vector is here because a subtly wrong challenge fails only at the
 * exchange — in a browser, against a live service, with no local signal at all.
 */
import { challengeFor, createVerifier, decodeState, encodeState } from "../src/lib/openrouter-oauth";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// RFC 7636 appendix B.
check(
  "S256 matches the RFC test vector",
  challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ===
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
);
check("a verifier is URL-safe", /^[A-Za-z0-9\-._~]+$/.test(createVerifier()));
check("a verifier is long enough for RFC 7636", createVerifier().length >= 43);
check("two verifiers differ", createVerifier() !== createVerifier());

const state = encodeState({ userId: "user_123", verifier: "abc", returnTo: "/settings?integration=ai" });
const round = decodeState(state);
check("state round-trips the user", round?.userId === "user_123");
check("state round-trips the verifier", round?.verifier === "abc");
check("state round-trips the return path", round?.returnTo === "/settings?integration=ai");
check("a malformed state decodes to null rather than throwing", decodeState("nonsense") === null);
check("an off-site returnTo is refused", decodeState(encodeState({ userId: "u", verifier: "v", returnTo: "https://evil.example" }))?.returnTo !== "https://evil.example");

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
```

Register it in `scripts/run-smoke.ts` (`pure` group).

Run: `npx tsx scripts/smoke-openrouter-oauth.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Write the pure module**

Create `src/lib/openrouter-oauth.ts`. No DB, no `next/server`, no SDK — it must stay importable by a smoke. Use `node:crypto`. `encodeState` stores `userId`, the **encrypted** verifier (`encrypt` from `src/lib/crypto`) and `encodeURIComponent(safeReturnPath(returnTo))`, joined the way `src/actions/gmail.ts:155` joins its state. `decodeState` returns `null` on anything malformed rather than throwing, and runs the return path back through `safeReturnPath`.

**Use `safeReturnPath` from the existing module — do not write a rival.** Grep for it first; this repo has a recorded incident of a second, rival path guard being added from a stale worktree.

- [ ] **Step 3: Run the checks to verify they pass**

Run: `npx tsx scripts/smoke-openrouter-oauth.ts`
Expected: all ok.

- [ ] **Step 4: Extract the settings write the callback must share**

`saveAiSettings` does five things the callback also needs: resolve the model, compute `previousBackend`, write the row, compute `nextBackend`, and delete `contact_embeddings` when the backend changed.

Extract that into an exported function in `src/actions/settings.ts` — for example `applyAiKeyChange({ userId, provider, model, encryptedKey })` returning `{ embeddingReset: boolean }` — and have `saveAiSettings` call it. **The callback must go through this**, because it stores a key and selects a provider, which is exactly the write the embedding guard exists for. A callback that writes the row directly bypasses the only thing keeping vector state coherent.

Behaviour must not change for `saveAiSettings`: same order, same deletes, same return shape.

- [ ] **Step 5: Write the server action**

Create `src/actions/openrouter.ts` with `"use server"` at the top. **Every export in a `"use server"` file must be an async function** — a non-async export or an `export type { … }` kills every export in the file, and tsc cannot see it.

`startOpenRouterConnect({ returnTo })`: `requireUserId()`, build verifier + challenge, set the cookie (`httpOnly: true`, `sameSite: "lax"`, `secure` as the Gmail action sets it, `maxAge: 600` — matching OpenRouter's own 10-minute code expiry), and return

```
https://openrouter.ai/auth?callback_url=<absolute callback URL>&code_challenge=<challenge>&code_challenge_method=S256&key_label=Orbit
```

`disconnectOpenRouter()`: clear `openrouterApiKeyEncrypted` through `clearApiKey("openrouter")`, and revalidate `/settings`.

- [ ] **Step 6: Write the callback route**

Create `src/app/api/openrouter/callback/route.ts`. In order:

1. Require the Clerk session. No session → redirect to the AI page with `?openrouter=error&reason=signed_out`.
2. Read and delete the cookie. Missing or undecodable → `?openrouter=error&reason=expired`.
3. Require `decoded.userId === sessionUserId`. Mismatch → `?openrouter=error&reason=expired`.
4. No `code` in the query → `?openrouter=error&reason=access_denied` (this is the cancel path).
5. `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method: "S256" }`. Non-OK → `?openrouter=error&reason=exchange_failed`.
6. Verify the returned key with `checkAiKey("openrouter", key)` — the same check a pasted key gets. Failure → `?openrouter=error&reason=key_rejected`.
7. `applyAiKeyChange({ userId, provider: "openrouter", model: DEFAULT_MODELS.openrouter, encryptedKey: encrypt(key) })`.
8. Redirect to `decoded.returnTo` with `?openrouter=connected`.

Add a comment stating why no `state` parameter is needed: OpenRouter's authorize URL has none, and the defence is PKCE — an attacker's code was issued against their own challenge, so the exchange against this verifier fails.

`checkAiKey` will need an `openrouter` probe in `src/lib/ai-key-check.ts`; tsc's `Record<AiProvider, KeyProbe>` already demanded one in Task 1, so make that probe real here: `GET https://openrouter.ai/api/v1/key` with the bearer token, ok on 200.

- [ ] **Step 7: Check the route is reachable**

`/api/openrouter/callback` needs a Clerk session, so it must **not** be in `PUBLIC_ROUTES` — but confirm the middleware does not block it for a signed-in user. Compare against how `src/app/api/gmail/callback/route.ts` is treated and match it.

- [ ] **Step 8: Run the checks**

```bash
npx tsc --noEmit
npx eslint src/lib/openrouter-oauth.ts src/actions/openrouter.ts src/app/api/openrouter/callback/route.ts src/actions/settings.ts
npx tsx scripts/smoke-openrouter-oauth.ts
npx tsx scripts/run-smoke.ts --ci
```

Expected: all pass, and the suite total is 3 higher than the Task 1 baseline.

- [ ] **Step 9: Commit**

```bash
git add src/lib/openrouter-oauth.ts src/actions/openrouter.ts src/app/api/openrouter/callback/route.ts src/actions/settings.ts src/lib/ai-key-check.ts scripts/smoke-openrouter-oauth.ts scripts/run-smoke.ts
git commit -m "Connect OpenRouter with one round trip, and let PKCE do the guarding"
```

---

### Task 6: `TurnOnAi` — the not-on state

**Files:**
- Create: `src/components/settings/turn-on-ai.tsx`
- Modify: `src/components/settings/ai-settings.tsx`
- Test: `scripts/smoke-toast-copy.ts` (runs repo-wide; no new script)

**Interfaces:**
- Consumes: `startOpenRouterConnect` (Task 5), `saveAiSettings` (existing).
- Produces: `<TurnOnAi initialSettings={…} onOpenMoreOptions={() => void} />`, standalone so onboarding can adopt it later.

- [ ] **Step 1: Build the component**

Create `src/components/settings/turn-on-ai.tsx` as a `"use client"` component with three blocks:

1. A heading "Turn on AI" and one paragraph: what AI does in Orbit, that it runs on the person's own AI account, and that it usually costs cents a month.
2. Primary button **Connect OpenRouter**, with the line "Sign in or create an account, add a little credit, and you're back here. Works with Gemini, GPT and Claude." Pressing it calls `startOpenRouterConnect({ returnTo })` inside a `useTransition` and assigns `window.location.href`; a rejection toasts `friendlyError(err, …)`.
3. A collapsed **Or use a free Google Gemini key** with three numbered steps — open `https://aistudio.google.com/apikey` (external link, `target="_blank" rel="noreferrer"`) and sign in; press "Create API key" and copy it; paste here and **Save**. Save calls the existing `saveAiSettings({ provider: "gemini", apiKey })`, which already verifies the key and already returns `{ ok: false, error }` rather than throwing. One quiet line: on Google's free tier, Google may use what is sent to improve its models.
4. A collapsed **I have an OpenAI or Anthropic key** whose only job is to call `onOpenMoreOptions()`.

Use the disclosure shape already in `src/components/settings/integrations-overview.tsx` (a `<button aria-expanded aria-controls>` plus a `hidden` panel that stays mounted) rather than inventing another — a panel that unmounts leaves `aria-controls` pointing at nothing.

- [ ] **Step 2: Render it when AI is off**

In `ai-settings.tsx`, branch at the top: when `!settings.ai.ready` (use whatever the existing `ai` facts call the "would AI run at all" flag — read the object `getSettings` returns and use its existing field rather than deriving a new one), render `<TurnOnAi …>`; otherwise render the existing controls.

Keep the existing controls exactly as they are in this task. Task 7 restructures them.

- [ ] **Step 3: Check the copy**

Run: `npx tsx scripts/smoke-toast-copy.ts`
Expected: ok. Then grep your own diff for straight apostrophes in JSX text and string literals and fix any you introduced.

- [ ] **Step 4: Run the checks**

```bash
npx tsc --noEmit
npx eslint src/components/settings/turn-on-ai.tsx src/components/settings/ai-settings.tsx
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-settings-layout.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/turn-on-ai.tsx src/components/settings/ai-settings.tsx
git commit -m "Give an account with no AI one button and a free option"
```

---

### Task 7: The on state, More options, and the mixed-backend line

**Files:**
- Modify: `src/components/settings/ai-settings.tsx`
- Modify: `src/components/settings/integrations-dialog.tsx` (the `case "ai"` panel ~line 648)
- Modify: `src/actions/settings.ts` (`getSettings` — add the OpenRouter connection state and the embedding backend)

**Interfaces:**
- Consumes: `TurnOnAi` (Task 6), `disconnectOpenRouter` (Task 5).
- Produces: the AI page owns `?openrouter=` and nothing else reads it.

- [ ] **Step 1: Publish what the page needs**

`getSettings`'s `providers` array needs, for `openrouter`, a `connected` flag distinct from `hasPersonalKey` — Disconnect and Remove key are different actions with different copy. Add the account's resolved embedding backend to the `ai` facts too (`chooseEmbeddingKey(...).provider`), so the page can name it without re-deriving the rule.

- [ ] **Step 2: Restructure the on state**

In `ai-settings.tsx`'s on-branch:

- "AI is on", then which account — "Using your OpenRouter account" or "Using your Gemini key".
- Two figures: **This month** (from the existing usage read) and, for OpenRouter when reported, **Credit left**. Read OpenRouter's key endpoint for the credit figure; **hide the figure entirely when it is not reported — never show a zero.**
- A **Model** row with **Change**, using `PROVIDER_MODELS[provider]`.
- **Disconnect** for OpenRouter (calls `disconnectOpenRouter`), **Remove key** for a pasted key (the existing `clearApiKey`).
- A collapsed **More options** holding, unchanged: the provider picker, the model select including "Custom model ID…", the per-provider saved keys with Clear, and `<AiUsageCard />`.

**Move the existing conditional prose into More options intact.** `onLocalDevKeys`, `onLifetime`, `managedRuns` and the allowance meter at `ai-settings.tsx:100-160` are invisible in demo, so a rewrite can delete them and nothing will fail. Move the JSX; do not re-derive the conditions.

- [ ] **Step 3: Say when completions and embeddings are on different providers**

When `provider === "openrouter"` and the resolved embedding backend is not `openrouter`, render one quiet line in the on state naming it, for example: "Search still embeds with your Gemini key."

And on the Clear button for that key, warn before clearing: clearing it moves the embedding backend, which already deletes every contact embedding and rebuilds the index. `clearApiKey` already returns `embeddingReset` and `ai-settings.tsx` already surfaces it after the fact — this makes it a warning before, not a report after.

- [ ] **Step 4: Own the OAuth return, once**

The AI page reads `?openrouter=connected|error&reason=…` with `readOAuthReturn` from `src/lib/oauth-return.ts`, toasts it, and strips it with `history.replaceState` — **in one component only**. Read the "Why one owner" block at the top of `src/components/settings/use-provider-connection.ts` before writing this: two components stripping the same param race, and a Next router restore drops the loser's queued server action without settling it. Strip first, then `router.refresh()` — never the other way round.

- [ ] **Step 5: Move `AiUsageCard` into the page**

In `integrations-dialog.tsx`'s `case "ai"`, drop `<AiUsageCard />` as a sibling — it now lives inside More options. `<DecisionModelSettings />` stays a sibling; it is Jev, not the AI provider.

- [ ] **Step 6: Run the checks**

```bash
npx tsc --noEmit
npx eslint src/components/settings src/actions/settings.ts
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-settings-layout.ts
npx tsx scripts/smoke-tap-targets.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/ai-settings.tsx src/components/settings/integrations-dialog.tsx src/actions/settings.ts
git commit -m "Say which account AI runs on, what it costs, and what still embeds where"
```

---

### Task 8: The eval harness

**Files:**
- Modify: `scripts/eval-ai.ts`

**Interfaces:**
- Consumes: the OpenRouter call path (Task 3).
- Produces: `--provider openrouter` with `ORBIT_EVAL_OPENROUTER_KEY`.

- [ ] **Step 1: Add the provider**

`scripts/eval-ai.ts` stores `ORBIT_EVAL_{GEMINI,OPENAI,ANTHROPIC}_KEY` as the synthetic user's **own** keys, so every model is reachable through the BYOK path. Add `ORBIT_EVAL_OPENROUTER_KEY` the same way, and extend `--keys-from` to read `OPENROUTER_API_KEY` from the named file. The `--provider` flag already goes through `resolveAiProvider`, which Task 1 widened, and `--model` already defaults to `DEFAULT_MODELS[provider]`.

- [ ] **Step 2: Update the header comment**

The file's doc block lists the keys and the `--provider` values. Update both, and add the comparison this gate rests on:

```
 *   ORBIT_EVAL_OPENROUTER_KEY=… npx tsx scripts/eval-ai.ts --provider openrouter \
 *     --model google/gemini-3.5-flash --task capture --runs 2 \
 *     --compare docs/ai-evals/2026-09-19-gemini-baseline/capture.json
 *
 * `--compare` reads one baseline EvalReport file and gates only the tasks that file has.
 * `docs/ai-evals/2026-09-19-gemini-baseline/` holds one such file per task — repeat with
 * matching `--task`/`--compare` pairs to gate the rest.
 *
 * That baseline ran at gemini-3.5-flash, not the current DEFAULT_MODELS.openrouter
 * (google/gemini-3.8-flash, 3.5's successor — no 3.8 baseline exists yet). `--model
 * google/gemini-3.5-flash` pins the run to the baseline's model, so a divergence is the
 * proxy's to explain, not a different model's.
```

- [ ] **Step 3: Verify it wires up without spending anything**

Run: `npx tsx scripts/eval-ai.ts --provider openrouter --task capture --limit 1 --runs 1`
Expected: it refuses for a missing `ORBIT_EVAL_OPENROUTER_KEY` with a clear message, rather than crashing or silently running on another provider's key. That is the whole check at this stage — **do not run a real eval here; Jason runs it.**

- [ ] **Step 4: Commit**

```bash
git add scripts/eval-ai.ts
git commit -m "Let the eval run over the OpenRouter route"
```

---

### Task 9: Verify, then hand over

**Files:** none — verification only.

- [ ] **Step 1: Static checks**

```bash
npx tsc --noEmit
npx eslint src scripts
npx tsx scripts/run-smoke.ts --check
npx tsx scripts/run-smoke.ts --ci
```

Expected: tsc silent; eslint 0 errors and no warning in a file this phase touched; `--check` ok; the suite green. This suite has a known load flake — if `smoke-admin-render` or `smoke-instrumentation` times out, re-run that script alone before reporting it.

- [ ] **Step 2: Re-resolve the schema version**

Re-run Task 1 Step 1's scan. Other branches bump `SCHEMA_VERSION` constantly, and a stale number passes locally and fails on Vercel, which builds the PR merged with its base. If the number moved, bump and re-run `smoke-schema-ddl`.

- [ ] **Step 3: In-app, with a real OpenRouter account**

Unlike P2, this is fully reachable locally — the PKCE flow needs no client registration. Start the demo preview, and **front the Browser pane and confirm `__reactFiber` is on a button before trusting any probe**: a hidden pane never hydrates and every check passes vacuously.

Walk: AI page with no key shows `TurnOnAi` → Connect OpenRouter → consent → returns to the AI page → "AI is on", "Using your OpenRouter account", This month, Credit left → Model → Change → More options holds the old controls and the usage card → Disconnect returns to `TurnOnAi`. Then cancel the consent screen and confirm the cancel toast. Then, on an account that also has a Gemini key, confirm the "Search still embeds with your Gemini key" line, and that clearing that key warns first.

- [ ] **Step 4: Write the handover**

Write a report at `.superpowers/sdd/<this plan's slug>/task-9-report.md` containing: what passed, what could not be checked, and the exact eval command for Jason:

```bash
ORBIT_EVAL_OPENROUTER_KEY=… npx tsx scripts/eval-ai.ts --provider openrouter \
  --model google/gemini-3.5-flash --task capture --runs 2 \
  --compare docs/ai-evals/2026-09-19-gemini-baseline/capture.json
```

repeated per task with the matching file from `docs/ai-evals/2026-09-19-gemini-baseline/`
(`--compare` reads a single baseline file and gates only the task(s) it holds). `--model
google/gemini-3.5-flash` pins the run to the model that baseline actually used —
`DEFAULT_MODELS.openrouter` is `google/gemini-3.8-flash`, 3.5's successor, and no 3.8
baseline exists yet — so the comparison is same-model, different-route, with the pass
condition: no threshold in `scripts/eval-fixtures/ai-eval-thresholds.json` broken (the script
exits 1 if one is). Name the three areas a proxied route most often breaks — structured JSON
output, vision on scanned notes, chat tool calls.

- [ ] **Step 5: Push and update PR #299**

```bash
git push
```

PR #299 already exists for this branch. Update its body to describe the implementation rather than only the design, keep the do-not-merge note until the eval has passed, and **ask Jason before changing its base or marking it ready.**

---

## Self-review

**Spec coverage.** §1 types/storage/presets → Task 1. §1's 26 comparisons → Task 2. §2 embeddings → Task 2 (+ the `applyAiKeyChange` requirement in Task 5 Step 4). §3 connect flow → Task 5. §4 the page → Tasks 6 and 7 (the three "must not lose" items are Task 7 Steps 2, 3 and 5). §5 client/deny/cost/errors → Tasks 3 and 4. §6 verification → the test step in each task, plus Task 9.

**Type consistency.** `openAiShapedClient` / `isOpenAiShaped` / `withOpenRouterRouting` are defined in Task 3 and used only in Tasks 3 and 4. `applyAiKeyChange` is defined in Task 5 Step 4 and used in Task 5 Step 6. `startOpenRouterConnect` / `disconnectOpenRouter` are defined in Task 5 and used in Tasks 6 and 7. `reportedCostMicros` is defined in Task 4 and used only there.

**Known gaps, deliberate.** The `memory_chunks` half-migration (spec §2) is out of scope and fixed nowhere here. The "Credit left" endpoint shape is verified in Task 7 Step 2 rather than pinned now, because it was not confirmed during design; the rule that covers being wrong is "hide when not reported".
