# Orbit AI Audit: LLM, embedding and speech calls

**Date:** 2026-10-16
**Scope:** every LLM, embedding and transcription call in the Orbit codebase
**Status:** Phase 1 (audit only). No application code was changed. The companion plan is [`AI_PLAN.md`](AI_PLAN.md).

**How this was produced**
- `src/lib/ai.ts` and the routing, pricing, access and provider modules were read in full.
- Four parallel passes covered the rest: chat; capture/meetings/imports; background jobs, research and embeddings; and spend, reliability, observability and evals.
- Each finding has a **Confidence** tag:
  - **V (verified):** the auditor read the code path.
  - **T (traced):** a sub-pass traced it with `file:line` evidence, and it was not re-read end to end. Re-check before fixing.
  - **U (unverified):** depends on provider or SDK behaviour that could not be confirmed offline. `node_modules` is not installed here.

---

## 0. Executive summary

Orbit's AI layer is already well-engineered in ways most codebases are not:
- a single operation registry drives routing (`ai-operations.ts`)
- per-call usage and cost telemetry (`usage_events`)
- a credit ledger with pre-call holds for managed keys
- nonce-fenced untrusted data, plus an output guard
- verbatim-excerpt grounding for extracted promises and dates
- a gated, rule-scored eval harness (`scripts/eval-ai.ts`)

Most findings are therefore **gaps at the edges of a sound design**, not missing foundations. The most important ones, ranked:

| # | Finding | Area | Sev | Conf |
|---|---|---|---|---|
| 1 | **The model most managed traffic runs on has never been evaluated.** On Orbit's key every tier, including OCR and chat answers, resolves to `claude-haiku-5-5` (`managed-ai-policy.ts:117,126-149`). Every recorded eval is Gemini (`docs/ai-evals/`). | Quality / Evals | High | V |
| 2 | **Truncated output is silently "repaired" and treated as success.** No call reads `finish_reason`, `stop_reason` or `finishReason` (the one exception is Anthropic web search). `parseAiJson` → `repairTruncatedJson` (`ai.ts:448-517`) closes open brackets, so a cut-off capture, digest, commitments list or chat answer is stored as if complete, and `usage_events.success = true`. | Quality / Reliability | High | V |
| 3 | **Unattended Drive import can rewrite an existing contact's identity from a document.** `acceptUnattended` (`drive-import-processor.ts:219`) accepts any person whose name shares *one word* with the doc. A merge target can be picked by a model-extracted email that is never checked against the doc text. The merge then overwrites `fullName`, `email`, `linkedinUrl`, `company`, `title`, `howMet` and `aiSummary` (`note-batch-save.ts:291-322`). A shared doc with injected text, or a hallucinated email, rewrites a real contact with no review. | Safety | High | V |
| 4 | **The batch sweep can double-charge credits forever.** `pollAiBatch` records usage, which settles managed credits, every time it sees a finished batch (`ai-batch.ts:434-448`). If `applier.apply` throws, the job stays `submitted` (`ai-batch-apply.ts:177-189`). The next hourly sweep records the usage again, and nothing retires it. | Cost / Reliability | High | V |
| 5 | **Search vectors from two different embedding spaces get mixed after a backend switch.** A key change clears `contact_embeddings` but not `memory_chunks.embedding`, whose `embedded_hash` still matches (`ai-settings-write.ts:136-140`, `settings.ts:295-297`). Passage search then compares old-space vectors to new-space queries, and nothing errors. Backend moves caused by managed-eligibility changes clear neither table. | Quality | High | V |
| 6 | **No output schema is enforced by any provider.** Gemini runs `responseMimeType: json`, OpenAI `json_object`, and Anthropic nothing at all (`ai.ts:600,616,630`). The shape lives only in prompt prose. Several call sites skip zod entirely: `outreach.draft`, `outreach.apollo`, `events.why`, OCR, the excerpt retry. | Quality | Med-High | V |
| 7 | **Web-search spend is unbounded on the default provider and not metered.** `maxSearches` binds only on Anthropic (`max_uses`) and OpenRouter. Gemini `googleSearch: {}` and OpenAI `web_search` have no cap (`ai.ts:2784,2837`). Per-search and grounding fees never appear in `usage_events` or credits (`ai.ts:2740-2742`). Work history runs up to 20 background searches per user per day. | Cost | Med-High | V (cap) / U (fees) |
| 8 | **No prompt caching on the hottest path.** `chat.answer` (8–40k input tokens) sends no `cache_control`. The system prompt varies by which sections are present, and the history block is wrapped in a **random per-call nonce** (`ai.ts:1937,2003`), which defeats every provider's prefix cache across turns. Gather rounds resend roughly 4k tokens of system prompt and tool definitions each round. | Cost | Med | V |
| 9 | **Several timeouts race a timer without aborting the request**: `chat.understand` (2.5 s), `chat.title` (8 s), `chat.refine` (20 s), and gather tool execution. The provider keeps generating and billing for up to 45 s after the caller has moved on, and the Stop button does not cancel web searches started by gather. | Cost / Reliability | Med | V |
| 10 | **No retry, backoff or fallback for completions.** Only embeddings have `withRateLimitBackoff` (`ai.ts:128`). SDK clients are built with defaults only (`ai-access.ts:363-375`), so OpenAI and Anthropic retry twice invisibly while Gemini probably does not. A managed provider failing mid-request is not failed over within that request. | Reliability | Med | V / U |
| 11 | **BYOK accounts have no spend cap.** Credits meter only `keyOwner === "orbit"`. Several AI actions have no rate-limit bucket: outreach drafts, compose, recruiter drafts, talking points. | Cost | Med | T |
| 12 | **Thinking-level gaps.** `gemini-3.1-flash-lite`, the Gemini fast tier, is missing from `GEMINI_THINKING_LEVELS` (`ai-request-options.ts:35-42`), so "minimal" is never sent for any fast-tier Gemini call. `chat.answer`, `chat.gather`, `meeting.digest`, `contact.brief` and `radar.draft` set no level, so Gemini 3.x thinks at its default length, billed as output. | Cost | Med | V / U |
| 13 | **The Anthropic fast tier on BYOK is roughly 10× pricier than needed.** `FAST_MODELS.anthropic = "claude-haiku-4-5"` ($1/$5 per MTok, `ai-models.ts:22`), while `claude-haiku-5-5` is $0.10/$0.50 and is already the managed default. Anthropic presets also still default to Sonnet 4.5 ($3/$15) where Sonnet 5.5 is $2/$10. | Cost | Med | V |
| 14 | **The four draft prompts disagree.** `followup.draft`, `outreach.draft`, `recruiter.draft` and chat `draft_message` each define their own length, sign-off, tone, temperature and output guard. Followup's "40–90 words" also applies to SMS, which contradicts outreach's 160-character SMS rule. `events.why` is an unhardened copy of `radar.why`. | Quality | Med | T |
| 15 | **Most user-visible generative features have no quality eval**: drafts (4 kinds), contact briefs, research, work history, talking points, the why-lines, `chat.title` and `chat.refine`. No eval runs in CI. | Evals | Med | V |

Not found:
- **Cross-user context bleed.** Every query, cache key and batch is scoped by `userId`. The one cross-tenant surface, shared `recruiters` rows, is fenced and consent-gated.
- **Prompt or response bodies persisted in telemetry**, with one exception: a `console.warn` of raw model output (finding S6).

---

## 1. Architecture as it is today

```
call site ──► ai.ts entry point ──► resolveAiAccess(userId) ──► grant { provider, model, keyOwner }
              completeJson            │ BYOK key, or Orbit's managed key (credits hold placed here)
              completeMultimodalJson  ▼
              streamText (chat)     modelForOperation(op, grant)   ← tier from ai-operations.ts
              webSearchJson          user | fast | vision | embed | transcribe | decision
              createEmbedding[s]Batch
              transcribeAudioWithAI ──► Deepgram (Orbit key) → Whisper (BYOK) → Gemini audio
              ai-tools.ts tool driver (chat.gather)
              ai-batch.ts (provider Batch APIs, 50% price)
              decisions/ (Jev via TypeSafe; LLM fallback via completeJson)
                     │
                     ▼
              withUsage → usage_events (op, provider, model, tokens, cost, success, error_kind, duration_ms)
                        → settleManagedUsage → credit ledger (managed only)
```

**Model resolution**

| Tier | BYOK Gemini (default) | BYOK OpenAI | BYOK Anthropic | Orbit managed (Anthropic first, then OpenAI) |
|---|---|---|---|---|
| user | `gemini-3.8-flash` | `gpt-4.1-mini` | `claude-sonnet-4-5` | `claude-haiku-5-5` / `gpt-4o-mini` |
| fast | `gemini-3.1-flash-lite` | `gpt-4o-mini` | `claude-haiku-4-5` | `claude-haiku-5-5` / `gpt-4.1-nano` |
| vision | `gemini-3.8-flash` | `gpt-4o` | `claude-sonnet-4-5` | `claude-haiku-5-5` / `gpt-4o-mini` |
| embed | `gemini-embedding-001` | `text-embedding-3-small` | none (no search vectors) | per backend |
| decision | `jev-1.13.0` (TypeSafe key only); falls back to rules or a fast-tier LLM | | | |

- On BYOK, an account whose own model is cheaper than the tier's keeps its own model (`ai-models.ts:86-99`).
- A managed key never runs a model off `MANAGED_MODELS`.

**Shared transport defaults**

| Setting | Value | Where |
|---|---|---|
| Call deadline | 45 s (transcription 90 s, web search 120 s) | `ai.ts:96,890,2725` |
| Temperature | 0.2 for JSON calls, 0.3 for streaming | |
| `maxOutputTokens` | 4096 | |
| System prompt suffix | `JSON_SYSTEM_SUFFIX`, the untrusted-input rule plus "valid JSON only", appended to every JSON call | `ai-security.ts:346-351` |
| Anthropic effort | `low` on Haiku 5.x only | `ai-providers.ts:222` |
| Gemini thinking | from the registry, where the model is in the table | `ai-request-options.ts` |

---

## 2. Inventory: every model call

Legend:
- **Tier:** u = user, f = fast, v = vision, e = embed, d = decision.
- **Think:** the registry thinking level ("-" means the provider default).
- **Out:** `maxOutputTokens`.
- **Validation:** **Z** = zod schema, **M** = manual checks, **∅** = none beyond `JSON.parse`. Every JSON call also passes through `parseAiJson` (fence-strip, slice, truncation repair).

There are 64 registered operations. `chat.route` and `import.enrich.gate` have no call site, and `import.enrich` has no producer.

### 2.1 Chat (`POST /api/chat` → `prepareChatContext` → `maybeGather` → `chatWithNetworkStream`)

| Operation | Where (call / prompt) | Tier · think · out · temp | Inputs (caps) | Output → validation | Used for |
|---|---|---|---|---|---|
| `search.embed` (query) | `embedding-cache.ts:65` → `ai.ts:1762` | e | question ≤4k chars (`chat-question.ts:6`), cut at 8k; up to 2 per turn (raw + rewrite) | vector; in-memory LRU (500 entries, 1 h, per instance) | semantic arm of hybrid search |
| `chat.understand` | `chat-retrieval.ts:237`; prompt `UNDERSTAND_SYSTEM` `:196-223` (~5.4k chars) | f · minimal · 512 · 0 | date, aboutUser ≤600, goals ≤5, last 2 turns × 400, question | JSON → M (`sanitizeParsedQuery`); fallback "open" | filters, lanes, routing (research/attention/calendar) |
| `chat.rerank.decide` | `chat-retrieval.ts:342` (Jev, 15 per chunk) | d | 60 candidate cards | keyed answers; all or nothing | top-12 selection |
| `chat.rerank` | `chat-retrieval.ts:417-460`; prompt `:301-305` | f · minimal · 2048 · 0 | 60 cards × ~200–400 chars, **unfenced** | JSON → M; ids checked against `byId` | top-12 selection (Jev fallback) |
| `chat.roster` | `decisions/chat-route.ts:102` (Jev) | d | ≤2 matched orgs | keyed yes/no | keep or drop exhaustive rosters |
| `chat.gather` | `chat-gather.ts:503`; prompt `GATHER_SYSTEM` `:76-86` (~2.8k) + ~17 tool definitions (~8k chars) via `ai-tools.ts:107` | **u** · - · 1024 · 0.1 | digest ~1–2k chars + accumulated tool results (≤6k each, ≤20k total) | native tool calls; args zod-validated; ids user-scoped | evidence and passages for the answer; ≤3 rounds, ≤6 tool calls |
| ↳ tools → `research.*`, `search.embed` | `tools/definitions.ts` | see 2.3 | | | |
| `chat.answer` | `ai.ts:2442` → `streamText:2225`; prompt `buildChatPrompt:1911-2218` (~5–11k chars static) | **u** · - · 4096 · 0.3 | history 8 × 3k; question; goals; focus profile ≤12k; attached ≤9k; evidence ≤20k; 12 contacts ≤48k chars; rosters (≤2×50 + filter ≤200, **outside the 48k budget**); attention; calendar; reminders; writing preferences ≤1.5k. **Typically 8–15k tokens, worst case ~40k.** | streamed prose + marker + JSON tail → `JSON.parse`; recommendations and proposed actions allow-listed and zod-checked (`chat-proposed-actions.ts:177-250`); `[eN]` and directives checked after the stream; `guardChatAnswer` | the answer; human-confirmed actions |
| `chat.title` | `chat-title.ts:99`; prompt `:34-40` | f · minimal · 160 · 0.2 | question ≤1.5k | M (≤60 chars) | thread title |
| `chat.refine` | `chat-refine.ts:58`; prompt `:42-51` | f · minimal · 1200 · 0.4 | draft ≤5k, fenced | M (`gainedReach` rejects new URLs or emails) | rewrite a draft |
| (legacy) `askNetwork` | `actions/chat.ts:371` → `chatWithNetwork ai.ts:2533` | u · - · 4096 | as `chat.answer`, **without** the question-length check, deadline or directive stripping | `parseAiJson`; a parse failure loses the whole answer | still an exported server action |

### 2.2 Capture, meetings, transcription

| Operation | Where | Tier · think · out · temp | Inputs (caps) | Output → validation | Used for |
|---|---|---|---|---|---|
| `capture.transcribe.page` | `ai.ts:1144`; prompt `:1155-1162` | v · minimal · 8192 · 0.1 | 1 image per call, ≤12 pages, ~1.2 MB JPEG, 3 at a time | `{text}` → ∅ | capture corpus |
| `capture.transcribe.audio` | `ai.ts:902` | Deepgram nova-3 → Whisper → Gemini (u, 4096) | clips ≤6 min; **uploaded files ≤12 MB with no duration cap** | text; Gemini `{text}` → ∅ | capture corpus |
| `capture.parse` (single pass) | `ai.ts:1393`; prompt `:1403-1436` + `PERSON_FIELD_SHAPE` + `PERSON_FIELD_RULES` (~10.9k chars ≈ 2.7k tokens) | u · minimal · 12,288 · 0.2 | notes <2.5k chars, fenced; `hintsPreamble` (seed people, goals) **unfenced** | Z (`multiPersonNoteParseSchema`), then excerpt/promise grounding (`capture-parse.ts:371-405`) | review cards → contacts, interactions, reminders, opportunities |
| `capture.parse.identify` | `ai.ts:1483`; prompt `:1494-1519` | u · minimal · 4096 · 0.2 | notes ≤100k chars | Z | person list for details |
| `capture.parse.details` | `ai.ts:1606-1638` | u · minimal · 12,288 · 0.2 | full notes re-read per batch of 4, **sequential**; `sharedPrefix` cache only when >4 people | Z; matched by name, **else by array index** (`:1641-1646`) | per-person fields |
| `capture.parse.excerpt-retry` | `ai.ts:1705` | u · minimal · 2048 · 0.1 | full notes + names | ∅; errors swallowed | source excerpts |
| `capture.dates` | `date-commitment-extract.ts:542`; prompt `:457-520` (~4.2k chars, **includes today's date**) | f · minimal · **2048** · 0.1 | notes ≤60k chars | Z + verbatim phrase + deterministic date resolution | reminders |
| `capture.dates.gate` | `decisions/gates.ts:17` (Jev) | d | **first 12k chars only** | p ≤ 0.4 skips extraction | |
| `mentions.resolve` / `.llm` | `decisions/capture.ts:92`, **one call per mention**, 3 at a time | d / f · minimal | mention + candidate cards | keyed `cNN` answers checked | link mentions to contacts |
| `capture.merge_target`, `capture.checks` | `decisions/capture.ts:192,260` (Jev) | d | excerpt ≤600 / note ≤12k | keyed | review-card defaults |
| `meeting.transcribe` | `meeting-sessions.ts:499` | as audio | 90 s WAV chunks | text | recovery when the live socket fails |
| `meeting.digest` (+`.map`/`.reduce`) | `meeting-digest.ts:502-520`; prompt `:427-481` (~6.3k) | **u · - · 6000 · 0.2** | single call ≤30k chars, else 20k-char pieces, 3 at a time, + reduce; user notes ≤20k **repeated in every map piece**; reduce input (model output) **unfenced** | Z + `groundDigest` (drops unquoted excerpts) | digest, then `buildMeetingCorpus` → full capture parse (two-pass) + dates |
| `meeting.talking_points` | `meeting-talking-points.ts:224` | f · minimal · 2048 · 0.3 | facts; "With:" attendee list **unfenced** | M: each point must cite an existing fact key | prep card; 1-day cache |
| `resummarizeInteraction` (op `capture.parse*`) | `actions/contacts.ts:2016` | u | one interaction | runs the **entire** multi-person parse to keep 3 fields | interaction summary |

### 2.3 Research, background and drafts

| Operation | Where | Tier · think · out · temp | Inputs (caps) | Output → validation | Used for |
|---|---|---|---|---|---|
| `research.person` / `.company` / `.discover` | `web-research.ts:258,612,808`; prompts `:91-125`, `:493-511`, `:721-734` | f · minimal · 1.8–2k · 0.1, web search (2/3/4 requested) | subject fields, fenced; homepage ≤3k | M; non-confident answers emptied; **per-claim URLs only scheme-checked, not matched to returned sources** | /find, chat tools; 14-day cache; 30/day |
| `contact.work_history` | `work-history-research.ts:176,195`; prompts `:111-140`, `:163-168` | f · minimal · 1500/200 · web (2/1) | subject fields, fenced | M; requires `match === "confident"`; **sources ignored** | **auto-writes** `contact_profiles`, job changes, company/title/school; provenance stored as `contact.linkedinUrl` (`:453`) |
| `contact.brief` | `contact-brief.ts:358`; prompt `:103-121` (+ goal-fit ~650) | **u · - · 4096 (default) · 0.3** | 20 interactions × 400, transcript ≤12k, notes ≤800, lists ≤8 | Z; goal ids checked; input-hash skip | brief on the contact page; ~14 trigger sites; each regeneration re-embeds |
| `contact.brief.gate` | `contact-brief.ts:531` (Jev) | d | | **disabled** (`catalog.ts:412`) | |
| `followup.draft` | `follow-up-drafts.ts:154`; prompt `:242-257` | u · - · 4096 · 0.5 | 25 interactions × 600, transcript ≤12k | Z → regex salvage → `guardModelOutput` | reminders, contacts, compose; 7-day cache |
| `radar.draft` | `radar/drafts.ts:87` → same prompt | **u · -** · background | ≤5 per nightly run | as above | Today cards; **no sign-off in cron** (`follow-up-drafts.ts:219-227`) |
| `outreach.draft` | `outreach-drafts.ts:74`; prompt `:119-135` | u · - · 4096 · 0.55 | campaign intent/tone in **system** prompt; `previousBody`/`templateSeed` unfenced | **∅** (`JSON.parse(...) as GeneratedDraft`, `:148`); no output guard; a single failure **rejects the whole `Promise.all` batch** | campaign emails (sent only after quality checks and approval) |
| `outreach.apollo` | `apollo.ts:612` | **u** | audience text | ∅; **domains guessed** (`:592-608`) | Apollo prospect filters |
| `recruiter.draft` | `recruiter-drafts.ts:87`; prompt `:120-132` | u · - · 600 · 0.55 | ≤25 per batch, concurrency 4 | M; no output guard | recruiter replies |
| `recruiter.scan` | `recruiter-scan.ts:136`; prompt `:80-93`; Gmail batch `gmail-scan-processor.ts:645-676` | f · minimal · 700 · 0.2 | 5 messages × 4k chars per sender, ≤400 senders | Z; confidence ≥0.6; **batch path neither reads nor writes `ai_result_cache`** | **shared** canonical `recruiters` row (cleaned, consent-gated) |
| `recruiter.prefilter` / `.gate` | `decisions/recruiter.ts:181,259` (Jev) | d | 8 senders per chunk; the gate runs **per sender** | keyed; prefilter uncached | |
| `radar.rerank` | `radar/rerank.ts:72`; prompt `rerank-prompt.ts:38-50` | f · minimal · 1500 | 20 candidates, no names, fenced | Z; ids checked; ±15 clamp; numeric-claim check | nightly ordering; 7-day cache |
| `radar.why` / `.ask` | `radar/explain.ts:52`; prompt `why-prompt.ts:15-27` | f · minimal · 300 | reasons (fenced) | Z + guard | card note |
| `events.why` | `events/explain.ts:162`; prompt `:54-63` (near-copy of `radar.why`) | f · - · 300 · default | scraped attendee name/title/event, **unfenced** `JSON.stringify` | ∅ + cut to 200/300 chars; no guard | event attendee note |
| `relationship.digest` | `relationship-engine/extract.ts:197`; prompt `:132-158` | f · minimal · 2000 · 0.1 | 20k-char window × ≤3 chunks, fenced; inline 25 per run, then batch | Z per item + verbatim excerpts + deterministic dates | **auto-creates reminders** (≤3 per contact, ≤25 per run) |
| `import.linkedin.timeline` (+`.decide` Jev) | `linkedin-timeline-events.ts:200`; batch `linkedin-timeline-backfill.ts:526` | f · minimal · 4096 · 0.1 | 80 messages × 500, ≤14k, fenced | Z (type enum), index lookup | **auto-writes** `interactions`; 300/day cap |
| `duplicates.same_person` / `.llm` | `decisions/duplicates.ts`; `decisions/llm.ts:76-124` | d / f · minimal · 0 | 5 pairs per chunk | keyed; LLM path rank-only | review queue order; the LLM path runs **at page render** but is tagged `background` |
| `notes.detect` / `.llm` | `decisions/notes.ts:18` | d / f | name + 1.5k head, 3 per call | keyed | offer Drive docs → **auto-extract ≤5 per drive per pass on foreground op ids** |
| `calendar.kind` | `decisions/calendar.ts:72` (Jev) | d | description ≤500 | keyed, veto only | which events are meetings |
| `extension.parse` | `extension/parse-profile.ts:96` | f · minimal · 4096 · 0.1 | page text ≤8k | Z; email not checked against the page | extension panel; 7-day cache |
| `extension.starters` (+gate) | `conversation-starters.ts:689` | u · - · 4096 · 0.6 | profile + history ≤12k + page (`<<<PAGE` static fence) | Z; grounded `basis` required; **salvage path dead** (`basis:""` at `:640`, filtered at `:735`) | openers; 7-day cache |
| `search.embed` / `.batch` (index) | `ai.ts:1762,1811`; planner `embedding-batches.ts` | e | ≤8k chars each, ≤200 per batch / 250k tokens | count and length checks; bisect on failure | `contact_embeddings`, `memory_chunks` |

---

## 3. Findings

### 3.1 Quality

**Q1. Truncation is invisible** (High, V). See summary #2. Concrete exposures:

| Exposure | Why it truncates |
|---|---|
| `capture.dates` | 2048-token cap with up to 25 commitments; the tail is lost |
| Gemini audio transcription | 4096-token cap against a ~40-minute uploaded file |
| `chat.rerank` | 60 × 36-character UUIDs ≈ 1.5k of the 2048 cap |
| `chat.gather` | the 1024 cap, likely shared with default thinking. A round with no tool calls is read as "done" (`chat-tool-loop.ts:105`) |
| `chat.answer` | 4096 cap with default thinking. A cut-off answer is persisted as complete |

- The OCR comment at `ai.ts:1137-1142` already records this failure mode ("repairTruncatedJson quietly patched the broken JSON into plausible-looking text").
- Refusals are also invisible. Anthropic `stop_reason: "refusal"`, OpenAI `message.refusal` and Gemini `finishReason: SAFETY` become either "Empty AI response" or a normal answer. Haiku 5.5, the managed default, has **no server-side refusal fallback**.

**Q2. No provider-enforced schemas** (Med-High, V).
- Every structured call relies on prompt prose plus a lenient parser.
- All providers Orbit uses now offer schema-constrained output:
  - Gemini `responseSchema` / `responseJsonSchema`
  - OpenAI `response_format: {type:"json_schema", strict:true}`
  - Anthropic `output_config.format`, supported on Haiku 4.5/5.5, Sonnet 5/5.5 and Opus 5/5.5, but not on Sonnet 4.5, the current BYOK Anthropic default
- The zod schemas already exist for most operations and could be the single source.
- Call sites with **no** schema validation at all: `outreach.draft`, `outreach.apollo`, `events.why`, `capture.transcribe.page`, `capture.parse.excerpt-retry`, Gemini transcription.

**Q3. Mixed embedding spaces** (High, V). See summary #5. Two more points:
- `contact_embeddings` and `memory_chunks` record no model or backend column. A mix can only be avoided by side-effect deletes; it cannot be detected.
- Gemini embeddings:
  - No `taskType` is sent (`RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`), which Google recommends for retrieval quality.
  - No `outputDimensionality` is sent, so 3072 dimensions are returned and stored in the jsonb column, then sliced to 1536 for pgvector (`pgvector.ts:6`).
  - The slice is benign for cosine distance (the model is Matryoshka-trained), but it doubles stored jsonb for nothing.

**Q4. Capture misattribution risk** (Med, V). Detail batches fall back to **array position** when a returned name does not match the requested name (`ai.ts:1641-1646`). A model that reorders or drops one person shifts one person's fields onto another, and the review card shows the wrong facts under the right name.

**Q5. Drafts are inconsistent across features** (Med, T). See the table below. The fix is one shared style block (voice, banned openers, placeholders, sign-off rule, per-channel limits) plus `guardModelOutput` on every draft.

| | followup / radar | outreach | recruiter | chat `draft_message` |
|---|---|---|---|---|
| Length | 40–90 words on every channel (incl. SMS) | email <120 words; LinkedIn <280 chars; SMS <160 | <120 words | not specified |
| Sender bio | yes | yes | name only | no |
| Writing preferences placement | user message | user message | inside context | own section |
| Output guard | yes (radar twice) | **no** | **no** | yes |
| Temperature | 0.5 | 0.55 | 0.55 | 0.3 (whole answer) |

**Q6. Duplicated and overlapping prompts** (Med, V/T).
- The "participant vs mention" rules are copied verbatim into two capture prompts (`ai.ts:1422-1423` and `:1518-1519`).
- `events.why` ≈ `radar.why`.
- The research-intent rules in `UNDERSTAND_SYSTEM` overlap `GATHER_SYSTEM`.
- Action items are extracted **three times** for a meeting: the digest's `action_items`, the person `action_items`/`promises`, and `capture.dates`. The code then de-duplicates titles that "agree constantly" (`capture-parse.ts:579-582`).
- Two fencing conventions are in use: `fenceUntrusted` and the extension's static `<<<PAGE` fence.

**Q7. Unverified web claims** (Med, T).
- Research per-claim URLs (`talkingPoints.url`, `news.url`, `people[].url`) are only checked for an http(s) scheme. The code calls them "model's, unverified" (`web-research.ts:76`).
- Work history ignores `sources` entirely. Identity rests on the model saying "confident", and the stored provenance is the contact's LinkedIn URL rather than the page actually read.

**Q8. Unchecked contact details** (Med, T). `email`, `linkedin_url`, `phone`, `website` and `x_handle` from capture, and `email` from the extension, are never checked against the source text. The only protection is the prompt line "never infer contact details". This feeds S1.

**Q9. Smaller defects** (T unless noted).
- Starters salvage path is dead (V).
- Radar nightly drafts have no sign-off, because `currentUser()` is unavailable in cron. The system prompt therefore differs from click-time, so nightly and click-time drafts never share a cache entry.
- `radar.why` parse failure surfaces as "no facts".
- `capture.dates.gate` reads 12k chars while the extractor reads 60k, so dates late in a long note can be skipped.
- `resummarizeInteraction` runs the full 35-field multi-person parse to keep 3 fields.
- `chat.route`, `import.enrich.gate` and `import.enrich` are registered with no producer.
- A `meeting_context` case is duplicated in `chat-gather.ts` (lines 209 and 239).

**Q10. Terminology** (Low). Prompts alternate between "contact", "person", "connection", "participant" and "attendee", and between "the user" and "you". The chat prompt even mixes "your notes" and "the user's notes" in adjacent blocks (`ai.ts:2180-2181` vs `:2170`). This is harmless for extraction but visible in generated prose ("your" vs "the user's"). It needs a glossary in the shared style block.

### 3.2 Reliability

**R1. No completion retries** (Med, V).
- SDK defaults only (`ai-access.ts:363-375`).
- OpenAI and Anthropic retry 429/5xx twice, invisibly to telemetry; Gemini `@google/genai` likely does not retry (U).
- `withRateLimitBackoff` covers embeddings only and ignores `Retry-After`.
- Managed failover happens only on the *next* call (`ai-access.ts:495`).

**R2. Timers without aborts** (Med, V). See summary #9. Also:
- The query embedding sits in the chat's critical `Promise.all` with **no soft deadline** (`chat-context.ts:392`). A hung embedding stalls the turn for up to 45 s plus backoff. By contrast, contact search uses a 300 ms soft timeout.
- `completeMultimodalJson` accepts no caller signal.

**R3. Deadline mismatches** (Low-Med, T).

| Route | Route `maxDuration` | Worst-case call chain |
|---|---|---|
| Meeting chunk | 120 s | Deepgram 90 s + Whisper/Gemini 90 s |
| Extension parse / starters | 30 s | 45 s call deadline |

Separately, two concurrent uploads of the same meeting chunk are both transcribed before the insert conflict resolves (`meeting-sessions.ts:497-528`).

**R4. Batch apply failure loops** (High, V). See summary #4. A poisoned job also occupies one of the 25 `listPendingBatchJobs` slots every hour.

**R5. Concurrency and loops** (T).
- `outreach.draft` batch: a single failure rejects the whole `Promise.all` while the other workers keep spending.
- `generateDueFollowUps` is a sequential, unbounded loop inside a server action.
- "At most one web tool per turn" in gather is a prompt rule only. Up to 6 web calls are possible, and an injected note can trigger them.

**R6. Runaway protection exists, but only for managed keys** (T).
- **Managed keys:** credits with pre-call holds, a background floor of 50%, provider pools with 30 s cached checks, and an admin pause.
- **BYOK:** nothing caps dollars. Per-route buckets limit request rates, and some actions have no bucket.
- **No per-day global cap,** only a $10/day spike alert (`managed-ai-policy.ts:220-226`). Its comment ("fifty Pro allowances") is stale: Pro is $3/month now.

### 3.3 Safety

**S1. Drive import identity overwrite** (High, V). See summary #3. Contributing factors:
- The merge path writes `fullName` and `...rest` over the stored contact (`note-batch-save.ts:291-322`). Only phone, website, X handle, school and industry are gap-fill.
- `nameGroundedInDoc` is satisfied by one 2-character word (`drive-import-processor.ts:195-202`).
- Email and LinkedIn are never grounded in the doc, yet they drive the 0.95/0.98 duplicate confidence (`duplicates.ts:390-392`).
- `auditUntrustedWrite` logs the event but blocks nothing.

**S2. Other unreviewed writes from untrusted text** (Med, T). In each case the impact stays inside that user's own account:

| Path | What gets written |
|---|---|
| `relationship.digest` | auto-creates reminders; an attacker's own message satisfies the verbatim-excerpt check |
| `import.linkedin.timeline` | writes `interactions` rows |
| `contact.work_history` | rewrites company, title and school from web pages |

**S3. Gather as a cost and exfiltration channel** (Med, T).
- Tool results (notes, synced email or LinkedIn text, meeting transcripts, web pages) return to the model as raw JSON and are not fenced.
- An injected instruction can make the model call `research_person`, `research_company` or `find_people` with model-chosen strings (up to 300 chars) on the user's key.
- This leaks small amounts of data to the search provider and burns the daily research allowance. All tools are read-only, so no write is possible.

**S4. Unfenced third-party text** (Low-Med, V/T).
- capture `hintsPreamble` (ICS/EML attendee names)
- talking-points "With:" list
- `events.why` inputs (scraped)
- `chat.rerank` cards (notes and profile snippets)
- meeting reduce input
- `LlmDecider` state
- outreach `previousBody` and `templateSeed`

`JSON_UNTRUSTED_INPUT_RULE` covers these generically, but the codebase's own standard (`fenceUntrusted`) is not applied.

**S5. Output guard coverage** (Low-Med, T).
- `guardModelOutput` is applied to chat, follow-up and radar output.
- It is **not** applied to `outreach.draft`, `recruiter.draft`, starters, the brief or the digest.
- Outreach has a `contains_link` quality gate before sending; the others have none.

**S6. PII in logs** (Low, V). `conversation-starters.ts:736-740` sends `content.slice(0, 400)` (model output built from profile and history text) to `console.warn`, which reaches Vercel logs and possibly Sentry breadcrumbs. Other gaps:
- `smoke-log-hygiene.ts` guards only `parse-profile`.
- The Sentry scrubber removes emails and secrets but not names, and passes nested `extra` through.
- `secret-patterns.ts` lacks the Deepgram, TypeSafe, Resend (`re_…`), Twilio and Apollo key shapes.

**S7. Cross-user context bleed** (none found). Checked:
- All retrieval is scoped by `userId`.
- `ai_result_cache`, the embedding LRU and batch jobs are keyed by user.
- Deepgram tags are opaque IDs.
- The shared `recruiters` row is fenced in prompts, field-cleaned and consent-gated.

There is one *staleness* (not leakage) issue: `ai_result_cache` keys omit the model and provider (`ai-result-cache.ts:117-135`, despite a comment saying "model tier"). After a model switch, cached drafts, briefs and recruiter verdicts (TTL up to 90 days) replay the old model's answers.

### 3.4 Cost

**C1. Web search is the least-bounded cost** (Med-High, V/U).
- On Gemini (the default) and OpenAI, `maxSearches` is advisory, and grounding or search fees are unmetered.
- Work history alone allows 60 foreground + 20 background calls per user per day.
- If Google bills grounded requests at roughly $14–35 per 1,000 (**verify against current pricing**), a user's background backlog of ~1,500 LinkedIn-anchored contacts costs about **$8–21/month for ~2.5 months**, invisible in `usage_events`. That may be the single largest BYOK cost driver.

**C2. No prompt caching where it pays** (Med, V). Avoidable spend:
- **Chat answer:** the stable prefix (system rules, tails, the user's goals and schools) is about 2.5–3.5k tokens, re-sent every turn.
- **Chat history:** prior turns (up to 24k chars) are re-sent every turn under a fresh nonce, which defeats provider caching.
- **Gather:** about 4k tokens of system prompt and tools re-sent per round.
- **Capture identify:** misses the details batches' shared prefix.

Anthropic needs explicit `cache_control` (the minimum cacheable prefix is 512 tokens on Haiku 5.5 / Sonnet 5.5 and 4096 on Haiku 4.5). OpenAI and Gemini cache automatically, but only if the leading bytes are stable.

**C3. Redundant calls** (Med, V/T).

| Redundancy | Effect |
|---|---|
| Single-pass capture escalation discards up to 12k output tokens of per-person detail (`ai.ts:1755-1756` reuses identities only) | paid twice |
| `capture.dates` re-reads text the people pass already parsed for promises | duplicate extraction |
| Mentions resolved one call per mention | N calls instead of 1 |
| Recruiter gate runs per sender | unbatched |
| Recruiter prefilter is uncached | repeat work |
| Gmail batch path skips `ai_result_cache` | re-classifies known senders |
| `contact.brief` calls `getAiConfig` a second time just to read the model | extra grant per brief |
| Each work-history save triggers 2 embeddings + 1 brief | 3 follow-on calls |
| Meeting digest is always re-run when the user typed notes | repeat digest |
| User notes repeated in every digest map piece | repeated input |
| Drive import retries a row up to 2× | parse billed twice |

**C4. Oversized contexts** (Med, V/T).
- Chat rosters (up to ~20k chars) sit outside the 48k contact budget.
- Rerank sends 60 cards and returns 60 UUIDs (an alias like `c01` would cut ~70% of rerank output).
- `extension.parse` allows 4096 output tokens for a ~300-token answer.
- `contact.brief`, `followup.draft` and `outreach.draft` have no explicit output cap (default 4096). This only matters when combined with default thinking.

**C5. Thinking defaults** (Med, V/U). `gemini-3.1-flash-lite` is missing from the thinking table. User-tier generative operations set no thinking level, so on Gemini 3.x they think at the provider default, billed at the output rate. The Sep 19 eval found that lower thinking was *better and cheaper* on extraction, but `chat.answer`, `chat.gather`, `contact.brief`, the drafts and the digest were never swept.

**C6. Model choice** (Med, V).
- The BYOK Anthropic fast tier is Haiku 4.5 ($1/$5) while Haiku 5.5 is $0.10/$0.50.
- The default is Sonnet 4.5 ($3/$15) while Sonnet 5.5 is $2/$10.
- The Anthropic "best" tier is Opus 4.5 ($5/$25) while Opus 5.5 is $4/$20.
- `outreach.apollo` (tiny extraction) and `radar.draft` (background) run on the user tier.
- The OpenAI presets (`gpt-4o*`, `gpt-4.1*`) predate the cheaper gpt-5.x minis already in `ai-pricing.ts`. **Verify prices and availability before acting.**
- Note that Claude 4.7+ tokenizers yield ~30% more tokens for the same text, so compare on measured tokens (`ai-pricing.ts` comment).

**C7. Batch API under-used** (Low-Med, T).
- Already batched: recruiter scan (Gmail), LinkedIn timeline, relationship digests.
- Not batched: Outlook recruiter scan, Drive import, cloud-notes auto-extract, nightly radar drafts and why-lines.
- Cloud-notes auto-extract and Drive import also run on **foreground** operation IDs, so the managed background floor never applies to them.

### 3.5 Observability

**O1. What is recorded** (V). `usage_events` stores: operation, provider, model, kind, key owner, input/output/cached tokens, estimated or reported cost, success, error kind and `duration_ms`. Prompts and responses are not stored, which is good for PII.

**O2. What is missing** (V):
- **No finish or stop reason**, so truncation, refusal and safety stops cannot be counted.
- **No JSON-repaired or validation-failed flag**, so it is unknown how often `repairTruncatedJson` saves or corrupts an answer.
- **No retry count.** SDK retries are folded into one row and one duration.
- **No web-search count or fee.**
- **No request or trace ID** linking the 4–20 calls of one chat turn.
- **No prompt or template version** (a hash), so a prompt change cannot be correlated with a quality or cost shift in production.
- **Thinking and reasoning tokens** are not split from visible output.
- **No latency read path:** `duration_ms` is only read by `scripts/eval-ai.ts`. There is no p50/p95 per operation in admin and no latency alerts.
- **Errors are lumped together:** "Empty AI response" covers refusals, safety stops and genuinely empty replies; parse failures classify as `other`.

---

## 4. Cost model

### 4.1 Measured cost per action (Gemini 3.8 Flash on BYOK, from `docs/ai-evals/`)

| Action (eval task) | Cost per case | p50 latency | Source |
|---|---|---|---|
| Chat turn, large network | $0.0082 | 9.1 s | `2026-10-14-chat-large-network-after.json` |
| Chat turn routed to research | $0.0149 | 15.8 s | same |
| Capture (note → people + dates) | $0.0086–0.0110 | 3.0–5.2 s | `2026-09-19-gemini-candidate/capture.json`, `2026-09-29-capture-enrichment` |
| Meeting digest | $0.0124 | 8.5 s | `…/digest.json` |
| OCR, per page | $0.0012 | 1.5 s | `…/ocr.json` |
| Voice note (Gemini audio) | $0.0008 | 1.2 s | `…/transcribe.json` |
| Recruiter classification, per sender | $0.0003 | 0.9 s | `…/recruiter.json` |
| Extension profile parse | $0.0004 | 1.0 s | `…/extension.json` |

### 4.2 Estimated cost per action where no eval exists

These are derived from caps and prompt sizes in code, **±2×**. They assume BYOK Gemini 3.8 Flash at $0.75/$3.75 per MTok and the fast tier at $0.25/$1.50, with ~1k default-thinking tokens where no level is set.

| Action | Calls | ≈ tokens in / out | ≈ cost |
|---|---|---|---|
| Contact brief regeneration | 1 u + 1 embed | 4k / 0.4k + ~1k thinking | $0.008 |
| Follow-up / radar draft | 1 u | 3k / 0.2k + ~1k thinking | $0.007 |
| Outreach campaign, 25 recipients | 1 apollo + 25 u | 25 × 1.5k / 0.3k | $0.06 |
| Research person (web) | 1 f + searches | 1k + results / 1.8k | $0.003 tokens **+ grounding fee (unmetered)** |
| Work-history check | 1 f + 1–2 searches | as above | $0.002 tokens **+ fee** |
| 30-minute meeting end to end | Deepgram 30 min + digest + two-pass parse + dates | ~25–30k total | $0.13 Deepgram (Orbit) + ~$0.03 |
| 100k-char note, 12 people | identify + 3 detail batches + dates + retry | ~130k / ~40k | ~$0.25 |
| Full Gmail recruiter scan (400 senders, before rule-outs and cache) | ≤400 f (Batch API) | ≤2M / 0.3M | ~$0.35 (batch) |
| LinkedIn timeline backfill, per day at the 300-contact cap | ≤300 f (batch) | 300 × ~4k | ~$0.15/day |
| Managed (Haiku 5.5) chat turn | 4–5 calls | ~15k / 1k | ~$0.002 |

### 4.3 Monthly drivers per active BYOK user (illustrative)

| Driver | Light user | Heavy user | Notes |
|---|---|---|---|
| Chat (incl. research share) | 40 turns ≈ $0.40 | 400 turns ≈ $4.00 | #1 visible driver; answer ≈ 75% of a turn |
| Work-history web search | $0–8 | $8–21 | **fees unmetered**; backlog phase only; verify pricing |
| Captures + meetings | 10 + 4 ≈ $0.25 | 60 + 20 ≈ $1.30 | |
| Contact briefs | 30 ≈ $0.25 | 200 ≈ $1.60 | ~14 triggers; gate disabled |
| Radar nightly (rerank + ≤5 drafts + why-lines) | ≈ $0.30 | ≈ $1.10 | drafts on user tier with default thinking |
| Drafts and outreach | ≈ $0.10 | ≈ $1.00 | |
| Relationship, timeline, recruiter, embeddings | ≈ $0.10 | ≈ $1–5 one-off backfill | batch-priced |
| **Total** | **≈ $1.50 + search fees** | **≈ $12–35** | |

**Orbit's own spend:**
- Managed AI is capped per account by plan credits ($0.50–$6.50/month, `plan-config.ts:136-198`).
- Org-wide pools are capped too: Anthropic $190/month, OpenAI $950 total (`managed-ai-policy.ts:53-56`).
- **Deepgram:** $0.0043/min, with meetings capped at 5 h/month per account, so up to ~$1.29 per account per month plus short-form. This is likely Orbit's largest *uncapped-in-aggregate* AI line.

Managed overspend is bounded only by the cap headroom, because the pool check is cached for 30 s per instance.

### 4.4 Replace these estimates with production data

Every estimate above can be replaced with measured numbers from `usage_events`:

```sql
-- Top cost drivers, last 30 days
select operation, key_owner, model,
       count(*)                                   as calls,
       round(sum(estimated_cost_micros)/1e6, 2)   as usd,
       round(avg(input_tokens))                   as avg_in,
       round(avg(output_tokens))                  as avg_out,
       round(100.0*avg((not success)::int), 1)    as fail_pct,
       percentile_cont(0.95) within group (order by duration_ms) as p95_ms
from usage_events
where created_at > now() - interval '30 days'
group by 1,2,3 order by usd desc nulls last limit 40;

-- Cost per active user per month, by key owner
select key_owner, date_trunc('month', created_at) m,
       count(distinct user_id) users,
       round(sum(estimated_cost_micros)/1e6 / nullif(count(distinct user_id),0), 3) usd_per_user
from usage_events group by 1,2 order by 2 desc, 1;

-- Calls likely truncated (output within 2% of the cap). Proxy until finish_reason is logged.
select operation, model, count(*) filter (where output_tokens >= 2000 and output_tokens <= 2048) as near_2048,
       count(*) filter (where output_tokens >= 4014 and output_tokens <= 4096) as near_4096
from usage_events where created_at > now() - interval '30 days' group by 1,2 order by 3 desc, 4 desc;
```

---

## 5. Strengths to keep (do not regress)

- **One operation registry** drives tier, thinking and background policy. `operation` is typed as `AiOperationId`.
- **Telemetry on every call:** token-normalised cost, null kept distinct from zero, and announced price changes (`ai-pricing.ts`).
- **Managed credit holds before each call**, a background floor, pool caps, an admin pause, and a managed allowlist.
- **Nonce fences** that untrusted text cannot forge. `guardModelOutput` scrubs secrets, fence echoes and system-prompt echoes. The stream redactor never stores raw secrets.
- **Grounding by verbatim excerpt** for promises, opportunities, dates, digests and relationship commitments. Dates are resolved by code, not by the model.
- **Model-chosen IDs never act unchecked:** decision answers use `cNN` keys, and recommendations, actions, rerank and goal-fit IDs are allow-listed.
- **Chat proposes actions and never executes them.** `commitProposedAction` re-reads the stored action under the user's scope.
- **Existing eval harness:** gated thresholds, candidate files that mirror production values, and per-case cost and latency.
- **Heartbeats, leases and stall-resume caps** on capture, import and background runners.

## 6. Not verified, open questions

- Whether `@google/genai` 2.x retries by default, and whether Gemini 3.x and gpt-5.x count thinking or reasoning tokens toward `maxOutputTokens` / `max_completion_tokens` in this SDK version.
- Whether `gemini-3.1-flash-lite` thinks by default.
- Current Gemini grounding and OpenAI web-search fees, and current OpenAI model prices.
- The real usage mix per feature. Run §4.4 against production before prioritising the cost items in `AI_PLAN.md`.
- Whether extension-parsed fields save without a user click.
