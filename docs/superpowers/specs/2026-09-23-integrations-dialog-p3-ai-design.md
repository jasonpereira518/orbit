# Integrations P3 — the AI page: one-click OpenRouter, guided Gemini paste

Phase P3 of `docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md`.
That spec's "AI page" and "OpenRouter integration" sections are the starting point; this
document supersedes them where the two differ, and says why.

**Branch:** `claude/integrations-p3-ai`, cut from `bd5cd300` on
`claude/settings-popup-redesign-0ed30d` (P1 + P2a + P2b, PR #257). P3 opens a second PR
targeting that branch, and rebases onto `main` once #257 merges.

## Why this phase exists

Turning AI on today means choosing a provider, opening a console you have never seen,
creating an API key, and pasting it. That is the single biggest drop-off in Orbit's setup,
and it is asked of someone who may not know what an API key is. P3 replaces the default
path with one button — sign in to OpenRouter, add a little credit, come back — and keeps
the paste path for people who have a key already, or who want the free Gemini tier.

Managed AI stays off. `ai-access.ts` remains the only path to a key.

## What changed since the parent spec was written

Four things were verified against OpenRouter's live API on 2026-09-23, and two of them
change the design.

1. **OpenRouter now has embeddings.** It did not when the parent spec was written. `POST
   /api/v1/embeddings` is OpenAI-compatible, and `GET /api/v1/embeddings/models` lists 33
   models including `openai/text-embedding-3-small` at native 1536 dimensions and
   `google/gemini-embedding-001`. The parent spec's open question — whether OpenRouter can
   embed at all — is closed.
2. **Slugs are not derivable.** Google's are Orbit's ids with a vendor prefix
   (`google/gemini-3.8-flash` is exactly Orbit's default, same $0.75/$3.75 pricing), but
   Anthropic's use dots where Orbit uses dashes: `anthropic/claude-haiku-4.5` against
   Orbit's `claude-haiku-4-5`. A mapping function would be a bug factory. The preset list
   is literal.
3. **Cost comes back inline, always.** Every response carries `usage.cost` and
   `cost_details.upstream_inference_cost`. No follow-up call, no request parameter — the
   `usage: { include: true }` parameter the docs once described is deprecated and has no
   effect.
4. **The PKCE flow needs no client registration.** No client id, no secret, no
   pre-registered redirect URI; `callback_url` is passed per request. Any origin can start
   the flow, which makes P3 fully exercisable in local demo mode — unlike P2, where demo
   could only ever render the unconfigured branch.

A fifth thing was found in Orbit's own code and is the reason section 2 below exists.
`src/lib/pgvector.ts` pads or truncates every vector to 1536 dimensions, and nothing records
which backend produced a row. Gemini's 3072-dimension vectors are sliced; OpenAI's are
native, and the two spaces are not comparable.

**Correction, 2026-09-25 — an earlier draft of this spec said a backend change silently
degrades search. For contacts that is not true, and the truth is more useful.**
`saveAiSettings` and `clearApiKey` already compute the embedding backend before and after a
write through `embeddingBackendFor` (which calls the very `chooseEmbeddingKey` this phase
changes), and on a change they **delete every `contact_embeddings` row** and return
`embeddingReset`, which `ai-settings.tsx` already surfaces. Contacts are handled.

Two things follow, and both sharpen decision 1 rather than weaken it:

- A backend change is not silent — it is a **full vector wipe and re-index**, paid for in
  the user's own API spend and in degraded search until the backfill catches up. That is a
  real cost to hand someone for pressing one button.
- `memory_chunks`, which holds the passage vectors the chat RAG path retrieves against, is
  **not** cleared on a backend change — its deletes are per-source re-chunking and full
  account purge only. So a backend change today leaves passages stranded in the old space,
  compared against query vectors from the new one. **This is a pre-existing bug, not one
  P3 introduces, and it is out of scope here** — it is recorded so it can be fixed on its
  own.

What P3 would otherwise change is that `chooseEmbeddingKey` puts the selected provider
first, which would make "Connect OpenRouter" a one-click way to trigger both of the above
for every existing Gemini user.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | An existing personal Gemini or OpenAI key keeps embedding. OpenRouter embeds only when there is none. | A connect never moves an account's vector space. A fresh one-click user still gets real semantic search. |
| 2 | Every OpenRouter request carries `provider: { data_collection: "deny" }`. | Orbit's payloads are private relationship notes. The pool is constrained to providers that do not retain or train on them. |
| 3 | The eval harness gains `--provider openrouter`; Jason runs it. The PR stays do-not-merge until it passes. | The gate stays real without spending his credit unattended. |
| 4 | P3 is a new branch stacked on P2b, as its own PR. | PR #257 is already 72 files; it should stay reviewable and mergeable on its own. |

## 1. Types, storage and the provider table

`AiProvider` and `EmbeddingBackend` each gain `"openrouter"`. The 19 `Record<AiProvider, …>`
sites then fail to compile until each has an arm; that is the checklist, and it is free.

**Storage.** A new `openrouter_api_key_encrypted` column on `user_settings`, beside the three
that exist. An `alters` change, so it needs a `SCHEMA_VERSION` bump. This branch is at 86, and
the numbers above it are variously claimed by other in-flight branches (Leads, onboarding and
Deepgram were all bumping while this was written), so the plan **scans every branch** and takes
the next free number. It does not guess, and it re-checks immediately before the PR — a stale
`SCHEMA_VERSION` passes locally and fails on Vercel, which builds the PR merged with its base.

**Presets are literal**, for the dash-versus-dot reason above. `PROVIDER_MODELS.openrouter`
holds slugs for the Gemini, GPT and Claude families, each verified present in
`GET /api/v1/models` and each advertising `response_format`, `structured_outputs`, `tools`
and `tool_choice`.

- `DEFAULT_MODELS.openrouter = "google/gemini-3.8-flash"` — the same model and price as the
  Gemini default, so connecting OpenRouter does not quietly change anyone's cost or quality.
- `FAST_MODELS.openrouter = "google/gemini-3.1-flash-lite"`, `VISION_MODELS.openrouter` the
  Flash model, mirroring the Gemini rows they parallel.
- `EMBEDDING_MODELS.openrouter = "openai/text-embedding-3-small"` — native 1536, so nothing
  is truncated the way Gemini's vectors are.

`modelBelongsToProvider` gets `openrouter → model.includes("/")`, which also admits a custom
slug typed into More options.

`AI_PROVIDERS` gains an OpenRouter entry so an existing key can still be pasted; the primary
path is Connect, and the page reflects that.

### The 26 comparisons tsc cannot see

`src/lib/*.ts` holds 26 hand-written `provider === "gemini" | "openai" | "anthropic"`
comparisons. Widening the union does not break any of them, and several are branches that
must now account for a fourth member.

A new smoke parses `src/lib` with the TypeScript compiler API, finds every equality
comparison against an `AiProvider` literal, and fails on any not in an allowlist that names
why it is exhaustive. Source-level parsing, not a regex — this repo has a documented case of
a regex guard passing over commented-out code, and P2b landed the compiler-API technique in
`scripts/smoke-settings-layout.ts` as the worked example.

## 2. Embeddings

`chooseEmbeddingKey` puts `openrouter` **last** in the personal-key order. Any personal
Gemini or OpenAI key wins; OpenRouter embeds only when there is nothing else.

It is a near relative of the Anthropic arm, not the same arm. Anthropic is excluded from the
embedding order entirely, because it has no embeddings API at all. OpenRouter does have one,
so it stays in the order — just never ahead of a key whose vectors are already in the
database.

Because `embeddingBackendFor` calls `chooseEmbeddingKey`, this single change also makes the
connect path safe automatically: `nextBackend` stays `gemini`, so no reset fires and no
vectors are wiped. Nothing in `settings.ts` needs a special case.

Consequence, which the UI must state rather than hide: a person with a Gemini key who
connects OpenRouter runs completions on OpenRouter and embeddings on Gemini. Clearing that
Gemini key later *does* move their vector space — and that path already wipes and rebuilds
the contact index, so the warning is concrete rather than hypothetical. See section 4.

**The OAuth callback must route its write through the same before/after comparison.** It
stores a key and selects a provider, which is exactly what `saveAiSettings` does; a callback
that writes the row directly would bypass the one guard that keeps vector state coherent.

**Explicitly out of scope:** recording which backend wrote each row and re-embedding on
change. That fixes the pre-existing hazard properly, and it needs a column, a backfill job
and real per-account API spend. It is its own project, and P3 is careful not to make it
worse.

## 3. The connect flow

OpenRouter's authorize URL has **no `state` parameter** — only `callback_url`,
`code_challenge`, `code_challenge_method`, `key_label`, `workspace_id` and
`required_workspace_id`. The CSRF defence is therefore PKCE itself.

`startOpenRouterConnect({ returnTo })`:

1. Generates a verifier and its S256 challenge.
2. Stores `userId:encrypt(verifier):encodeURIComponent(safeReturnPath(returnTo))` in an
   httpOnly `orbit_openrouter_oauth` cookie — `sameSite: "lax"`, `maxAge: 600`, matching
   OpenRouter's own 10-minute code expiry, and the same shape as `orbit_gmail_oauth_state`
   at `src/actions/gmail.ts:157`.
3. Returns `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256&key_label=Orbit`.

`GET /api/openrouter/callback` requires the Clerk session, requires the cookie, and requires
the cookie's `userId` to equal the session's. It exchanges at `POST /api/v1/auth/keys` with
`{ code, code_verifier, code_challenge_method: "S256" }`, verifies the returned key, stores
it encrypted through the same path a pasted key takes, selects `openrouter` and its default
model, deletes the cookie, and redirects to `returnTo` with
`?openrouter=connected|error&reason=…`. No `code` on the callback means cancelled.

**Why no state parameter is acceptable.** The attack to stop is someone feeding Orbit's
callback *their* authorization code, which would point the victim's account at the
attacker's OpenRouter key — meaning the attacker sees every prompt, which is to say the
victim's notes. That code was issued against the attacker's `code_challenge`, so the
exchange against Orbit's verifier fails. The verifier cookie is the load-bearing defence,
which is why it is encrypted rather than stored plainly.

`readOAuthReturn` (`src/lib/oauth-return.ts:18`) already reads exactly this param shape.

**One owner.** The AI page mounts several components. Exactly one of them reads and strips
`?openrouter=`; the others render from what it publishes. P2b's first half was spent undoing
a two-owner `history.replaceState` race, and the rule is written down in
`src/components/settings/use-provider-connection.ts`.

## 4. The AI page

`case "ai"` in the dialog today stacks three siblings — `AiSettings`,
`DecisionModelSettings`, `AiUsageCard`. It becomes one component with a state.

**Not on** → `TurnOnAi`, a standalone component so onboarding's `wizard-ai-key.tsx` can adopt
it in a later phase (switching onboarding over is out of scope):

- One paragraph: what AI does in Orbit, that it runs on the person's own AI account, that it
  usually costs cents a month.
- Primary: **Connect OpenRouter** — "Sign in or create an account, add a little credit, and
  you're back here. Works with Gemini, GPT and Claude."
- Collapsed: **Or use a free Google Gemini key** — three numbered steps to
  `https://aistudio.google.com/apikey`, verified on save by the existing `saveAiSettings`,
  with a one-line note that Google may use free-tier traffic to improve its models.
- Collapsed: **I have an OpenAI or Anthropic key** → More options.

**On**:

- "AI is on", and which account ("Using your OpenRouter account" / "Using your Gemini key").
- **This month** (cost) and, for OpenRouter when reported, **Credit left**.
- **Model** row with **Change**.
- **Disconnect** (OpenRouter) or **Remove key** (pasted) — different actions, different copy,
  so `settings.providers` needs "connected" as a state distinct from "has a pasted key".
- Collapsed **More options**: provider picker, model including "Custom model ID…", saved keys
  per provider with Clear, and `AiUsageCard`.

### Three things the redesign must not lose

1. **The existing conditional prose.** The description and status blocks in `ai-settings.tsx`
   carry distinct copy for a dev server running on `.env.local`, for Lifetime's included AI,
   for the case where the managed model differs from the chosen one, and for the allowance
   meter — roughly `onLocalDevKeys` / `onLifetime` / `managedRuns` and everything they feed.
   None of it is
   visible in demo, so a rewrite can delete it without anything failing. It moves into More
   options intact, and a smoke pins the branches over the pure predicates.
2. **`AiUsageCard` moves inside the page**, under More options, rather than remaining a
   sibling — otherwise the per-feature table and the new "This month" figure say overlapping
   things in two places. `DecisionModelSettings` stays a sibling; it is Jev, not the AI
   provider.
3. **The mixed-backend line.** When completions run on OpenRouter and embeddings on a Gemini
   key, the On state says so plainly — "Search still embeds with your Gemini key" — and
   clearing that key warns rather than silently clearing. Without this, decision 1 is
   invisible and a later Clear quietly changes the vector space.

## 5. Calls, cost and errors

**Client.** `openrouterClient(grant)` sits beside the other three in `ai-access.ts:245`: the
OpenAI SDK with `baseURL: "https://openrouter.ai/api/v1"`, `HTTP-Referer` (app origin) and
`X-Title: Orbit`. `keyFor(grant, "openrouter")` preserves the invariant that a grant minted
for one provider cannot build another's client. `ai.ts` routes `openrouter` down the OpenAI
code path.

**Deny routing.** `provider: { data_collection: "deny" }` is a body field on both
`/chat/completions` and `/embeddings`. The OpenAI SDK forwards unknown body keys, but typing
it needs one helper — `withOpenRouterRouting(params)` beside the client — rather than an
`as any` at every call site. A privacy guarantee that depends on remembering a spread is one
forgotten spread from being off, so the comparison guard also asserts no `.create(` on an
OpenRouter client bypasses the helper.

**Cost.** `recordUsage` computes `estimateCostMicros(...)` inline (`usage-events.ts:90`) from
`ai-pricing.ts`, which has no OpenRouter slugs — so left alone, every OpenRouter call would
record no cost at all. `UsageRecord` gains an optional `reportedCostMicros`, and
`recordUsage` prefers it. One field, and reusable for any future provider that reports real
spend.

A `cost_source` column (`'estimated' | 'reported'`) lands in the same schema bump. The
existing column is `estimated_cost_micros`; writing an actual cost into it makes the two
indistinguishable, which matters because `ai-pricing.ts` is known to run about 5× low. With
the source recorded, `AiUsageCard` and the admin view can say which they are showing, and
the estimate's error stops being invisible.

**Errors.** HTTP 402 → a `UserFacingError` saying the OpenRouter credit ran out, linking to
the credits page. 401 → the AI page shows "Reconnect OpenRouter" rather than a generic
failure. Both through `classifyAiError`, so they land as friendly copy rather than a
production digest.

**Credit left** reads OpenRouter's key-info endpoint. Its exact shape is a plan-time
verification; the figure is hidden when not reported rather than shown as zero.

## 6. Verification

**Smokes, no network and no spend:**

- `smoke-ai-access.ts` already stubs `fetch` and asserts which key went on the wire for
  completions, embeddings and transcription. An OpenRouter arm checks the whole contract at
  once: the request goes to `openrouter.ai`, carries the user's key, carries `HTTP-Referer`
  and `X-Title`, and carries `provider: { data_collection: "deny" }`. Decision 2 becomes a
  tested property rather than a code-review one.
- Its source guard — no file but the gate builds an AI client — must keep passing with
  `openrouterClient` added.
- `chooseEmbeddingKey`: a personal Gemini key beats OpenRouter; OpenRouter embeds only when
  nothing else exists.
- The provider table: every preset is a well-formed `vendor/model` slug, and every
  `DEFAULT_MODELS` / `FAST_MODELS` / `VISION_MODELS` entry appears in its preset list. This
  is what catches the dash-versus-dot trap.
- PKCE derivation against RFC 7636's published test vector. It is pure, and getting it
  subtly wrong fails only at the exchange, in a browser, against a live service.
- `recordUsage` prefers a reported cost over the estimate and stamps `cost_source`.
- The provider-comparison AST guard from section 1.

**The eval gate.** `--provider openrouter` with `ORBIT_EVAL_OPENROUTER_KEY`, defaulting to
`google/gemini-3.8-flash` — the same model as the existing `docs/ai-evals/2026-09-19-gemini-baseline`
run. Same model, different route, so `--compare` against that baseline attributes any
divergence to the proxy rather than to the model. Structured JSON, vision on scanned notes
and chat tool calls are where a proxied route tends to differ, and that comparison is where
it would show. The exact command and pass condition go in the plan; the PR stays
do-not-merge until Jason has run it.

**In-app, in demo.** Unlike P2, the whole connect round trip works locally: no client
registration, `callback_url` passed per request. Connect, cancel, reconnect, disconnect and
the deep link are all reachable against a real OpenRouter account from a local dev server.

**Manual, against a real account.** An account with zero credit (the 402 copy), Credit left
appearing and disappearing, and the mixed-backend line showing for an account that has both
a Gemini key and an OpenRouter connection.

## Out of scope

- Recording the embedding backend per row and re-embedding on change (section 2).
- Switching onboarding's `wizard-ai-key.tsx` over to `TurnOnAi`.
- P4 (reminders: one-click subscribe, encrypted feed token) and P5 (LinkedIn one-ZIP, the
  Advanced pages).
- Managed AI. It stays off.
