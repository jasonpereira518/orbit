# Chat as an Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit's chat answers from everything Orbit knows, acts on contacts, reminders and events (then every other feature) from the thread, applies small reversible changes itself when the person opts in, and says "I don't know" only after it has looked — with a measured abstention rate to prove it.

**Spec:** `docs/superpowers/specs/2026-10-18-chat-agent-design.md`. Decisions §4: reversible auto-apply tier (off by default), one streaming tool loop every turn, contacts/reminders/events first.

**Architecture:**
- **Phase 0, prompt and prefetch.** No new model calls. Richer contact rows, wider always-on blocks (reminders across views, calendar both directions, commitments, goals, events), the "look before you abstain" rule, and an abstention label on every stored answer. Ships alone and sets the baseline.
- **Phase 1, the agentic answer.** A streaming tool driver per provider; `chatWithNetworkStream` runs `runToolLoop` with every chat read tool on every turn; the separate gather step retires once the `research` eval passes. New read tools cover events, opportunities, radar, outreach, recruiters, knowledge, email history and structured contact/interaction queries.
- **Phase 2, proposal writes.** Write tools gain a `proposal` descriptor. On the chat surface the registry exposes a *proposer* in place of the write: same schema, but its `run` stores a validated proposal on the message and returns `{status:"proposed"}`. The commit runs from the stored row through the same `*ForUser` function MCP calls. The JSON-tail `proposed_actions` retires.
- **Phase 3, auto-apply.** A `user_settings.chat_auto_apply` toggle. Proposals whose descriptor says `tier: "auto"` commit at once and render as done with Undo; caps and a scrub guard bound it.
- **Phase 4, hardening.** Prompt caching, cost gate, MCP parity check.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching the route or server actions, per AGENTS.md), Drizzle (neon-http in prod, PGlite locally), zod 4, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `tsx` smoke scripts registered in `scripts/run-smoke.ts`.

**Branch:** `claude/chat-agent-design` holds the spec and this plan. Each phase is its own branch off `main` and its own PR: `claude/chat-agent-p0-prefetch`, `-p1-loop`, `-p2-writes`, `-p2b-writes`, `-p3-auto-apply`, `-p4-hardening`. A phase starts after the previous one merges.

## Global Constraints

- **The write invariant holds throughout.** No write executes from live model output. A model tool call on the chat surface can only *store* a proposal; the commit reads the stored, validated args. `checkToolCall`'s refusal of `scope:"write"` on chat (`src/lib/tools/registry.ts:165,191`) stays exactly as it is. Auto-apply (Phase 3) commits from the stored row too, in the same request, after validation.
- **Never exposed to chat, in any phase:** sending email, outreach or recruiter drafts; approving an agent draft; `deleteAllData`; API keys; AI or billing settings; anything that fetches a model-chosen URL (`enrichEventFromUrl`, calendar subscription URLs). Rule source: top of `src/lib/mcp/server.ts`.
- **Every tool result is fenced untrusted text**, as the gather loop does today; free text a tool writes goes through `sanitizeAgentText` (`src/lib/mcp/sanitize.ts`).
- **`ApiKeyScope` stays `"read" | "write"`.** It is the API key scope type (`src/lib/api/keys.ts:34`); proposals are a property of a write tool, not a new scope.
- **Schema:** `SCHEMA_VERSION` is 170 on `main` today (`src/db/index.ts:2723`). Before each DDL task, re-scan every remote ref (`git ls-remote` + `git grep "SCHEMA_VERSION = " $(git for-each-ref --format='%(refname)' refs/remotes)`) and `git worktree list`, and take one above the highest found. A DDL change needs `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:check`.
- Every smoke script starts with `import "./smoke/_env";`, is registered in `MANIFEST` in `scripts/run-smoke.ts` (`pure` or `pglite`), uses its own user ids, deletes its own rows first, and ends with `process.exit(0)`.
- Server actions return client-facing errors through the existing refusal pattern (a thrown message does not survive production). Toast and refusal copy has no trailing period (`smoke-toast-copy`). `"use server"` files export only async functions.
- Before each push: `npm run typecheck`, `npm run lint`, `npm test`. For a phase that changes model behaviour, also the eval named in its last task.
- Commit after each task. Trailer: `Co-Authored-By: <your model> <noreply@anthropic.com>`. No model identifier anywhere else in the repo.

## Decisions made while planning (flag at handoff)

1. **A `proposal` descriptor on write tools instead of a third scope.** The spec said "a `propose` scope". `ApiKeyScope` is shared with API keys, so widening it would leak into key issuance. A write tool instead carries `proposal?: { tier, preview, allow? }`; `toolsFor(…, "chat", …)` returns a derived proposer for each write tool that has one. A write tool without a descriptor stays invisible to chat.
2. **The JSON tail survives for recruiter recommendations only.** `proposed_actions` moves to tool calls in Phase 2; `recommendations` (recruiters) stays in the tail because it is display data, not a write.
3. **Legacy proposals keep working.** Rows stored before Phase 2 have `args.kind`. The commit path keeps a branch for them for one release, then a follow-up removes it. New rows store `{ tool, args }`.
4. **Gather retires only after the eval.** Phase 1 keeps `maybeGather` behind `CHAT_LOOP_V2 !== "1"` until the `research` and `chat` evals pass at or above the 2026-10-14 numbers, then Task 1.8 deletes the old path.
5. **Abstention labelling is rule-based first.** A pure classifier with a phrase list and structure checks; a lite-model fallback is deferred unless the rule set mislabels more than 10% of a hand-labelled sample of 50.
6. **Undo for auto-applied changes uses the lib's own snapshots** where they exist (reminder snooze, complete, dismiss, follow-up clear). Where they do not (`logNoteInteractionForUser`, `createReminderForUser`, tag add), undo is the inverse write (`deleteInteractionForUser`, `dismissReminder`, tag remove), recorded on the proposal as `undo: { tool, args }`.

## File Structure

New:
- `src/lib/chat-abstention.ts` — pure answer labeller (`answered | partial | abstained`).
- `src/lib/chat-prefetch.ts` — always-on blocks that are not contacts (reminders summary, calendar window, commitments, goals, events). Replaces the scattered loaders in `chat-context.ts` over Phase 0.
- `src/lib/ai-tools-stream.ts` — `createStreamingToolDriver` for the three providers.
- `src/lib/chat-agent-loop.ts` — the answer loop: stream text, run tools, narrate steps, collect proposals.
- `src/lib/tools/chat-proposals.ts` — derives proposers from write tools; stores, validates and dedupes proposals.
- `src/lib/tools/definitions-events.ts`, `definitions-features.ts` — new read and write tools, split out of `definitions.ts` (already 1,400+ lines). `ORBIT_TOOLS` concatenates them.
- `src/lib/chat-auto-apply.ts` — tier gate, caps, guards.
- Smokes: `smoke-chat-abstention`, `smoke-chat-prefetch`, `smoke-tool-stream-driver`, `smoke-chat-agent-loop`, `smoke-chat-proposers`, `smoke-chat-auto-apply`, `smoke-chat-feature-tools`.

Changed: `src/lib/ai.ts` (prompt), `src/lib/chat-context.ts`, `src/lib/chat-retrieval.ts`, `src/lib/chat-gather.ts` (retired), `src/app/api/chat/route.ts`, `src/actions/chat-actions.ts`, `src/lib/chat-proposed-actions.ts`, `src/lib/tools/registry.ts`, `src/lib/tools/definitions.ts`, `src/components/chat/proposed-actions.tsx`, `src/db/schema.ts`, `src/db/index.ts`, `src/lib/admin-chat-feedback.ts`, settings page, `scripts/smoke-tool-registry.ts`, eval fixtures.

---

# Phase 0 — prefetch, prompt and the baseline

Branch `claude/chat-agent-p0-prefetch`. No new model calls; the cost per turn must not rise by more than the extra prompt tokens.

### Task 0.1: Abstention labeller (pure)

**Files:** create `src/lib/chat-abstention.ts`, `scripts/smoke-chat-abstention.ts`; register `"smoke-chat-abstention": "pure"`.

- [ ] Export `type AnswerOutcome = "answered" | "partial" | "abstained"` and `labelAnswer(answer: string, meta: { citedCount: number; peopleBlocks: number; listBlocks: number }): AnswerOutcome`.
- [ ] Rules, in order: any citation, people block or list block and no abstain phrase → `answered`. An abstain phrase in the first two sentences and nothing cited → `abstained`. An abstain phrase later in an answer that also cites or names people → `partial`. Otherwise `answered`.
- [ ] Phrase list (case-insensitive, curly and straight apostrophes): "i don't know", "i do not know", "i don't have", "i couldn't find", "i could not find", "no record", "not in your records", "nothing in your", "doesn't say", "don't see", "isn't recorded", "you haven't logged", "i can't tell", "no information". Keep it a single exported array so the smoke pins it.
- [ ] Smoke: 12 fixed answers covering each branch, including "I don't know Maya's email, but she's at Stripe [e2]" (partial) and "Nothing in your notes mentions the Series A." (abstained).
- [ ] Commit `feat(chat): label each answer answered, partial or abstained`.

### Task 0.2: Schema — `chat_messages.answer_outcome`

**Files:** `src/db/schema.ts` (chatMessages at :3522), `src/db/index.ts`.

- [ ] Add `answerOutcome: text("answer_outcome").$type<AnswerOutcome>()`, nullable (old rows stay null).
- [ ] Bump `SCHEMA_VERSION` per the Global Constraints scan; DDL `alter table chat_messages add column if not exists answer_outcome text`; changelog line.
- [ ] `npx tsx scripts/smoke-schema-ddl.ts --update`, `npm run db:check`.
- [ ] Commit `feat(db): chat_messages.answer_outcome`.

### Task 0.3: Store the label and show the rate

**Files:** `src/lib/chat-persist.ts`, `src/app/api/chat/route.ts`, `src/actions/chat.ts` (`askNetwork`), `src/lib/admin-chat-feedback.ts`, `src/app/(clerk)/(admin)/admin/product/page.tsx`.

- [ ] `persistAssistantTurn` takes `answerOutcome`; both call sites compute it with `labelAnswer(cleanAnswer, { citedCount: cited.length, peopleBlocks: placed.length, listBlocks: … })`.
- [ ] `getChatFeedbackSummary` adds `outcomes7d: Record<AnswerOutcome, number>` from a `count(*) … group by answer_outcome` over assistant rows in the last 7 days. It still never selects `content`.
- [ ] `/admin/product` shows abstained and partial as a share of labelled answers next to thumbs. Reuse the existing stat primitives in `src/components/admin/primitives.tsx`.
- [ ] Extend `scripts/smoke-chat-persist.ts`: a stored turn carries its label.
- [ ] Commit `feat(chat): record and report the abstention rate`.

### Task 0.4: Richer contact rows

**Files:** `src/lib/chat-retrieval.ts` (`BudgetedContact` :492-509, `budgetContactsContext` :526-596), `src/lib/chat-context.ts` (`renderFocusRelationship` :589-629), `src/lib/ai.ts` (row template :1980).

- [ ] Carry `email`, `phone`, `linkedinUrl`, `howMet`, `closenessTier`, `lastInteractionAt` and open `opportunities` (label and kind, at most 3) from `RankedContact` into `BudgetedContact`. Extend the hydration select if a field is missing.
- [ ] Row template adds, only when present: `email=… | phone=… | linkedin=… | met=<howMet> | tier=<n> | last_touch=<YYYY-MM-DD> | open: <label>; <label>`. All through `sanitizeProfileLine`.
- [ ] The focus block gets the same fields.
- [ ] Recruiter `piiUnlocked` logic is untouched; this is the user's own contacts only.
- [ ] Count the added characters in the 48,000 budget; the tier table does not change.
- [ ] Extend `scripts/smoke-chat-prompt.ts`: a contact with an email renders it; one without renders no `email=` key.
- [ ] Commit `feat(chat): contact rows carry email, phone, LinkedIn, how-met, tier, last touch and open opportunities`.

### Task 0.5: Always-on prefetch blocks

**Files:** create `src/lib/chat-prefetch.ts`, `scripts/smoke-chat-prefetch.ts` (pglite); change `src/lib/chat-context.ts` (:87, :797-952), `src/lib/chat-calendar.ts` (:17-19, :53-65), `src/lib/ai.ts` (`buildChatPrompt`).

- [ ] `loadChatPrefetch(userId, { tz, now })` runs in parallel and returns rendered, fenced-ready strings:
  - **Reminders:** counts by view (overdue, today, upcoming 7 days, no date) via `queryRemindersPage`, plus the 12 nearest-due open ones as `[reminder_id=…]` lines. Replaces the `view:"today"`, limit 8 load; `ctx.reminderTitles` is built from these 12.
  - **Calendar:** past 7 days and next 14 days, at most 25 events, through `listUpcomingEvents({ from, to })`. Always loaded when the user has a calendar source, not only on `route.calendar`. Past events are labelled `(past)`.
  - **Commitments:** `list_open_commitments`' underlying reader, 8 lines.
  - **Goals:** already loaded; move here.
  - **Events:** next 5 and last 5 from `listEventsForUser`, title, date, city, roster size and spoke-to count.
- [ ] Each block has a hard character cap (reminders 2,000; calendar 3,000; commitments 1,200; events 1,500). Measure the median user's added tokens in the smoke and record it in the PR.
- [ ] `buildChatPrompt` takes `prefetch` and renders each block fenced, replacing `openReminders` and `calendar` arguments.
- [ ] Prompt lines for the new blocks, one each, in `systemCoreRules`: what the block is and that it is complete for what it covers.
- [ ] Smoke (pglite): seed one user with reminders in every view, a past and a future calendar event, one commitment and two events; assert each block's content and caps.
- [ ] Update `scripts/smoke-chat-context.ts` and `smoke-chat-calendar.ts` for the moved loaders.
- [ ] Commit `feat(chat): reminders, both-way calendar, commitments and events in every prompt`.

### Task 0.6: Look before you abstain

**Files:** `src/lib/ai.ts` (:2210, :2212, :2214), `scripts/smoke-chat-prompt.ts`.

- [ ] Replace `if the lists do not say it, you do not know it` with: `Never invent people, companies, dates, contact details or message content. Everything Orbit knows that bears on the question is in the sections below; read all of them before answering.`
- [ ] Replace the closing abstain sentence at :2214 with: `When the sections answer only part of the question, answer that part first, then say in one sentence which section you checked and what it did not show. Say you don't know only when no section bears on it, and name what the user could add.`
- [ ] Add: `Match the length to the question: a detail (an email, a date, a count) is one line; "tell me about" is the profile shape below.`
- [ ] Keep :2212 (never count from the relevance slice) unchanged.
- [ ] Pin the new wording in `smoke-chat-prompt.ts`; remove the pin on the old sentence.
- [ ] Commit `feat(chat): read every section before saying it doesn't know`.

### Task 0.7: Eval cases and the baseline

**Files:** `scripts/eval-fixtures/ai-chat-eval.json`, `scripts/eval-fixtures/contact-search-eval.json` (seed), `scripts/eval-ai.ts` (scoring), `docs/ai-evals/README.md`.

- [ ] Add a `mustAbstain` case field and an `abstainRate` metric (via `labelAnswer`) beside `mentionRecall`.
- [ ] Add 10 must-answer cases whose fact lives only in a field or block Phase 0 adds: an email, a phone, how-met, a reminder due next week, a past calendar meeting, an open commitment, an event's spoke-to count, an opportunity label, the last-touch date, a tier.
- [ ] Add 4 must-abstain cases: a person not in the network, a field nobody recorded, an event that does not exist, a date with no meetings. Pass means `abstained` and the answer names what it checked.
- [ ] Gate: must-answer cases pass on `mentionRecall`; must-abstain cases pass on `mustAbstain`; `forbiddenHits` stays 0.
- [ ] Run `chat` and `research` on Gemini 3.8 Flash, 2 runs, `--network large` as well. Save as `docs/ai-evals/2026-10-xx-chat-agent-p0-before.json` (on `main`) and `-after.json` (on the branch). Add both rows to the README table.
- [ ] Commit `test(eval): abstention cases and the Phase 0 baseline`.

### Task 0.8: Phase 0 verification and PR

- [ ] `npm run typecheck && npm run lint && npm test`.
- [ ] Run the app (`run` skill) and ask: "what's <seeded contact>'s email", "what's on my plate next week", "who did I meet on Tuesday" (past calendar), "what do I owe people". Screenshot each answer for the PR.
- [ ] PR body: the eval table before and after, the abstention rate on the dev database, median added prompt tokens.

---

# Phase 1 — one agentic answer loop

Branch `claude/chat-agent-p1-loop`. Read the `claude-api` skill before Task 1.1 for Anthropic streaming tool use.

### Task 1.1: Streaming tool driver

**Files:** create `src/lib/ai-tools-stream.ts`, `scripts/smoke-tool-stream-driver.ts` (pure, with recorded provider event fixtures under `scripts/eval-fixtures/stream-tool-fixtures/`).

- [ ] `createStreamingToolDriver(input: DriverInput & { onText(delta: string): void }): Promise<StreamingToolDriver>` with `step(signal): Promise<ToolStep>` and `addResults(results)`, the same shape as `ToolDriver` in `src/lib/ai-tools.ts`. `step` streams text through `onText` as it arrives and returns the tool calls once the round's stream ends.
- [ ] Anthropic: `client.messages.stream`, text from `content_block_delta` of type `text_delta`, tool input assembled from `input_json_delta` per block index; push the final message (`stream.finalMessage()`) verbatim.
- [ ] OpenAI-shaped (OpenAI, OpenRouter): `stream: true`, `stream_options: { include_usage: true }`; text from `delta.content`; tool calls assembled by `index` from `delta.tool_calls[].function.arguments` fragments; a malformed final JSON string passes through as a string, as `ai-tools.ts` does.
- [ ] Gemini: `generateContentStream` with `functionDeclarations`; text parts excluding `thought`; `functionCall` parts collected across chunks.
- [ ] Usage: one `withUsage` row per round, operation `chat.answer`, tokens from the final chunk as `streamText` does today.
- [ ] Reuse `translatingProviderErrors`, `runOnGrant`, `geminiThinking`, `openaiCompletionOptions` exactly as `createToolDriver` does. Extract any helper both drivers need rather than copying it.
- [ ] Smoke replays one fixture per provider: text, then two tool calls, then text. Asserts deltas in order, calls with parsed args, and the native message history after `addResults`.
- [ ] Commit `feat(ai): streaming tool driver for all three providers`.

### Task 1.2: The answer loop

**Files:** create `src/lib/chat-agent-loop.ts`, `scripts/smoke-chat-agent-loop.ts` (pure, fake driver and executor).

- [ ] `runChatAgent({ driver, execute, steps, onText, bounds, signal, deadline }): Promise<{ text: string; calls: ExecutedCall[]; stoppedBy }>`. Built on `runToolLoop` (`src/lib/chat-tool-loop.ts`), unchanged except that `driver.step` now streams.
- [ ] Bounds: 4 rounds, 8 calls, 6,000 characters per result, 20,000 characters total results; deadline is `answerDeadlineMs(requestStartedAt)`.
- [ ] Each call narrates through `steps` with a label from a per-tool `stepLabel(args)` on the tool definition (add the optional field to `OrbitTool`), falling back to the tool's `title`.
- [ ] Text written in a round before a tool call is kept and streamed; the final text is the concatenation. When the budget runs out mid-question, the last round runs with `tools: []` so the model must finish in prose.
- [ ] Tool results go back fenced with the same nonce scheme as `buildChatPrompt`; extract the fence helper from `ai.ts` into `src/lib/ai-fence.ts` and use it in both.
- [ ] Smoke: no-call answer is one round; a two-call answer narrates two steps; a repeated call is deduped; an executor throw becomes an error result and the answer still finishes; the budget-exhausted path forces prose.
- [ ] Commit `feat(chat): one answer loop that can look things up mid-answer`.

### Task 1.3: Wire the loop into the route behind a flag

**Files:** `src/app/api/chat/route.ts`, `src/lib/ai.ts` (`chatWithNetworkStream`), `src/lib/chat-gather.ts`, `src/actions/chat.ts`.

- [ ] Read `node_modules/next/dist/docs/` on route handlers and streaming before editing the route.
- [ ] `chatWithNetworkStream` gains a path that builds the prompt as today, then calls `runChatAgent` with `toolsFor(ORBIT_TOOLS, "chat", ["read"])` and the registry executor `chat-gather.ts` already uses (move it to `src/lib/tools/chat-executor.ts`).
- [ ] With `process.env.CHAT_LOOP_V2 === "1"` the route skips `maybeGather` and uses the loop; otherwise it is unchanged.
- [ ] Contacts surfaced by tool results join `ctx.allowedContacts` and `blocks.people` (reuse `contactsIn` from `chat-gather.ts`, moved to the executor module), so `::people` cards and proposals can name them.
- [ ] Evidence: tool results that return interactions, meetings or notes mint `[eN]` ids from the same ledger, so citations work for looked-up facts. The ledger is created before the loop and passed in.
- [ ] `askNetwork` (non-streaming) uses the same loop with a no-op `onText`.
- [ ] System prompt addition (only on the loop path): `You can look things up with the tools. Look before you say you don't know; say what you looked up when it found nothing. Do not look up what the sections already show.`
- [ ] Extend `scripts/smoke-chat-route.ts` and `smoke-chat-stream.ts` for the flagged path with a fake driver.
- [ ] Commit `feat(chat): the answer loop behind CHAT_LOOP_V2`.

### Task 1.4: Structured query tools

**Files:** `src/lib/tools/definitions.ts`, `src/lib/hybrid-search.ts`, `scripts/smoke-chat-feature-tools.ts` (pglite, new; this task creates it and later tasks extend it).

- [ ] `query_contacts` (BOTH, read): filters (company, industry, school, location, tag, tier, `added_after`, `added_before`, `interacted_after`, `interacted_before`, `never_interacted`, `missing`: email|company|title), `sort` (name, closeness, last_touch, added), `group_by` (company, industry, tag, tier, school, location), `limit` ≤ 50. Returns `{ total, groups?: [{key, count}], rows: [...] }`. Wraps `listContactsMatching` with a new `groupBy` and unfiltered mode; the exact `count(*) over()` stays.
- [ ] `query_interactions` (BOTH, read): `contact_id?`, `type?`, `source?`, `after?`, `before?`, `count_only?`, `group_by?` (type, month, contact), `limit` ≤ 50.
- [ ] Field allowlists: MCP gets no `notes`, as `search_contacts` does.
- [ ] Smoke: totals and groups on a seeded 30-contact network; `never_interacted`; a month group.
- [ ] Commit `feat(tools): structured contact and interaction queries with counts and groups`.

### Task 1.5: Feature read tools

**Files:** create `src/lib/tools/definitions-features.ts`; extend `smoke-chat-feature-tools.ts`.

Each wraps the named lib reader; each takes `userId` explicitly. Where only a Clerk-bound action exists, extract the body into a `*ForUser` lib function first and have the action call it.

- [ ] Events: `list_events` (`listEventsForUser`; tab upcoming|past|all, query), `get_event_roster` (`listRosterForUser`; spoke_to filter, in_network filter), `who_to_talk_to` (`whoToTalkTo`), `events_with_contact` (extract from `getEventsWithContact`).
- [ ] Opportunities and radar: `list_opportunities` (`listOpportunitiesForContact`, plus an all-contacts variant), `list_radar_cards` (`listPendingRecommendations`).
- [ ] Outreach: `list_campaigns`, `get_campaign` (extract from `act/outreach.ts:169,190`). Gate with the outreach surface key so a closed surface drops the tools.
- [ ] Recruiters: `list_my_recruiters` (extract from `listMyRecruiters`), `search_recruiters` (`searchCanonicalRecruiters`). Recruiter PII follows the existing `piiUnlocked` rule.
- [ ] Knowledge: `get_dossier` (`loadKnowledgeDossier`).
- [ ] Email: `list_sent_emails` (`listContactPendingSends` plus sent history from `email_sends`, subject and date only, never bodies), `list_pending_drafts` (`listPendingAgentSends`).
- [ ] Capture and imports: `recent_captures` (`listCaptureHistoryFor`), `recent_imports`.
- [ ] Stats: extend `get_network_overview` with `getDashboardCounts` and `getNetworkStats`.
- [ ] Surfaces: everything here is CHAT only in this task; MCP parity is Task 4.3.
- [ ] Update the count assertion in `scripts/smoke-tool-registry.ts:121-125` to the new total, and list the new names.
- [ ] Smoke: each tool on seeded rows returns its rows and refuses another user's ids.
- [ ] Commit per feature group (`feat(tools): event reads`, and so on).

### Task 1.6: Router simplification

**Files:** `src/lib/decisions/chat-route.ts`, `src/lib/chat-retrieval.ts` (`UNDERSTAND_SYSTEM` :196-223), `src/lib/chat-context.ts`.

- [ ] On the loop path, `routeFromParsed` no longer decides depth; `needs_research` is ignored. Shape, filters, time and calendar window still drive prefetch lanes.
- [ ] The `prep` regex keeps its retrieval effect (3 search hits plus the meeting's people) but no longer forces a research round.
- [ ] factLane keeps `note_batch` and `brief` chunks (`chat-lanes.ts:200`) and searches meetings for the person shape too.
- [ ] Update `scripts/smoke-chat-route.ts`, `smoke-chat-lanes.ts`, `ai-chat-routing-eval.json` expectations.
- [ ] Commit `refactor(chat): the model decides when to look things up`.

### Task 1.7: Eval and flip

- [ ] Run `chat`, `research` and `--network large` with `CHAT_LOOP_V2=1`, 3 runs. Gate: every metric at or above Phase 0's `-after` numbers; `meanLookups` ≤ 3.5; p50 latency within +3 s; cost per case within +60% of Phase 0.
- [ ] If a gate fails, tune bounds and the tool descriptions, not the eval. Record each attempt in the PR.
- [ ] On pass, save `docs/ai-evals/2026-10-xx-chat-agent-p1.json`, add the README row, and make the loop the default (`CHAT_LOOP_V2 !== "0"`).
- [ ] Commit `feat(chat): the answer loop is the default`.

### Task 1.8: Retire gather

**Files:** `src/lib/chat-gather.ts`, `src/app/api/chat/route.ts`, `src/actions/chat.ts`, `src/lib/ai-operations.ts`, `scripts/smoke-chat-gather.ts`, `smoke-relationship-gather.ts`, `smoke-eval-research-task.ts`.

- [ ] Delete `maybeGather`, `gatherEvidence` and the flag. Keep `chat.gather` in `ai-operations.ts` only if historical `usage_events` reporting reads it; otherwise remove it.
- [ ] Move any assertion in the gather smokes that still applies to `smoke-chat-agent-loop.ts`; delete the rest and their `MANIFEST` entries.
- [ ] The `research` eval task now runs the loop path; its plumbing smoke follows.
- [ ] Commit `refactor(chat): remove the separate research step`.

### Task 1.9: Phase 1 verification and PR

- [ ] Full checks. Run the app and ask one question per new tool family; screenshot the step trail.
- [ ] PR body: eval table, cost delta, latency delta, the abstention rate before and after on the dev database.

---

# Phase 2 — proposal writes for contacts, reminders and events

Branch `claude/chat-agent-p2-writes`.

### Task 2.1: The proposal descriptor and proposers

**Files:** `src/lib/tools/registry.ts`, create `src/lib/tools/chat-proposals.ts`, `scripts/smoke-chat-proposers.ts` (pure); update `scripts/smoke-tool-registry.ts`.

- [ ] `OrbitTool` gains `proposal?: { tier: "auto" | "confirm"; preview(args): string; undo?(args, resultId): { tool: string; args: unknown } | null; maxRecords?: number }`.
- [ ] `toolsFor(tools, "chat", scopes)` returns, for each write tool with `proposal`, a derived tool: same `name`, `description` prefixed "Proposes: ", same `inputSchema`, `scope: "read"` so `checkToolCall` admits it, and a `run` that never calls the write. Its run calls `ctx.propose({ tool, args, preview, tier })` and returns `{ status: "proposed", id, preview }`.
- [ ] `ToolContext` gains optional `propose`. A proposer called without one returns a tool error (fails closed).
- [ ] The underlying write tool is still refused on chat by `READ_ONLY_SURFACES`; a test calls it directly through `runTool` with `surface: "chat"` and asserts `read_only_surface`.
- [ ] `chat-proposals.ts`: `createProposalSink({ allowedContacts, allowedReminders, allowedEvents })` collects proposals for one turn, rejects ids outside the allowlists (contacts, reminders and events the turn has seen, including tool results), dedupes identical `{tool, args}`, caps at 10, and mints ids. Text args through `sanitizeAgentText`.
- [ ] `smoke-tool-registry.ts`: replace "no write tool is exposed to chat" with "every chat tool runs as read; every write reaches chat only as a proposer; a write tool without `proposal` is absent from chat".
- [ ] Commit `feat(tools): write tools reach chat only as proposers`.

### Task 2.2: Store `{tool, args}` proposals; keep legacy rows

**Files:** `src/lib/chat-proposed-actions.ts`, `src/db/schema.ts` (`StoredProposedActionRecord` type only, no DDL), `src/actions/chat-actions.ts`, `scripts/smoke-chat-proposed-actions.ts`, `scripts/smoke-chat-actions.ts`.

- [ ] `StoredProposedAction` becomes a union: legacy `{ id, args: ProposedActionArgs, … }` and new `{ id, tool: string, args: unknown, preview, tier, status, resultId?, undo? }`.
- [ ] `commitProposedAction(messageId, actionId)` keeps its claim/CAS (`chat-actions.ts:40-77`). For a new-shape row it looks up the write tool by name in `ORBIT_TOOLS`, re-validates `args` with `z.object(tool.inputSchema)`, re-checks ownership, and calls `tool.run(userId, args, { surface: "chat-commit" })`.
- [ ] Add `"chat-commit"` to `ToolSurface`; only `commitProposedAction` and `chat-auto-apply.ts` construct it. A write tool lists `"chat-commit"` in `surfaces` when it has a `proposal`. `checkToolCall` admits writes on `chat-commit`.
- [ ] Legacy rows go through the existing `args.kind` branches, unchanged.
- [ ] `undoProposedAction(messageId, actionId)`: new server action; claims `done → undoing`, runs the stored `undo` through the same path, sets `undone`. Add `undoing` and `undone` to the status union.
- [ ] Smokes: a new-shape proposal commits through the registry; a tampered stored arg fails validation; a legacy row still commits; undo restores.
- [ ] Commit `feat(chat): proposals commit through the shared write tools, with undo`.

### Task 2.3: Contact write tools

**Files:** `src/lib/tools/definitions.ts`, `src/lib/contact-writes.ts`, `src/lib/contact-merge.ts`, `src/lib/contact-delete.ts`; extend `smoke-chat-feature-tools.ts`.

Give each existing or new write tool a `proposal` descriptor. Tier `auto` only where §2.4 of the spec lists it.

- [ ] `update_contact` (exists, MCP): add `proposal` (confirm). Chat may set title, company, location, how_met, tags_add, tags_remove, cadence_days, closeness (1–5), notes_append. `notes_append` appends a dated line; it never replaces `notes`. Name, email, phone and LinkedIn changes are allowed but force `confirm` whatever the tier.
- [ ] `add_tags` / `remove_tags` (new): auto / confirm.
- [ ] `create_contact` (exists): confirm; keeps the duplicate check.
- [ ] `log_interaction`, `add_note` (exist): auto; undo is `delete_interaction`.
- [ ] `delete_interaction` (new, wraps `deleteInteractionForUser`): confirm.
- [ ] `edit_interaction` (new): extract `updateInteraction`'s inline body (`act/contacts.ts:864`) into `updateInteractionForUser` in `contact-writes.ts`; confirm.
- [ ] `complete_action_item` (new, `setActionItemStatusForUser`): auto; undo reopens.
- [ ] `delete_contact` (new, `deleteContactForUser`): confirm; preview names the person and their interaction count. Not in MCP (rule in `docs/mcp-vision.md`): `surfaces: ["chat-commit"]` only.
- [ ] `merge_contacts` (new, `mergeContacts`): confirm; chat-commit only; undo is `unmergeContacts`.
- [ ] `pin_contact` (new, extract `setConstellationPin`): auto.
- [ ] Smoke each: proposer stores, commit writes, undo reverses, another user's id refused.
- [ ] Commit `feat(tools): contact writes as chat proposals`.

### Task 2.4: Reminder write tools

**Files:** `src/lib/reminder-writes.ts`, `src/lib/reminders.ts`, `src/actions/reminders.ts`, `src/lib/tools/definitions.ts`.

- [ ] `create_reminder`, `complete_reminder`, `snooze_reminder`, `schedule_follow_up` (exist): add descriptors; create, snooze and schedule are auto, complete is auto with undo via `reopenReminder`'s snapshot.
- [ ] Extract into `reminder-writes.ts`: `updateReminderForUser` (from `act/reminders.ts:320`), `scheduleContactFollowUpAtForUser` (:572), `setKeepInTouchCadenceForUser` (:671), `createReminderListForUser` (:396). The actions call them.
- [ ] New tools: `update_reminder` (confirm), `reschedule_reminder` (auto, `snoozeReminderTo`), `reopen_reminder` (auto), `delete_reminder` (confirm, `dismissReminder`, undo `restoreDismissedReminder`), `move_reminder_to_list` (auto), `create_reminder_list` (auto), `set_keep_in_touch` (auto), `clear_follow_up` (confirm, undo from its snapshot).
- [ ] The proposal allowlist for reminder ids is every reminder the turn saw (prefetch's 12 plus tool results), not only "Open reminders".
- [ ] Smoke as in 2.3.
- [ ] Commit `feat(tools): reminder writes as chat proposals`.

### Task 2.5: Event write tools

**Files:** `src/lib/events/store.ts`, `src/lib/events/connect.ts`, `src/lib/events/target-companies.ts`, `src/lib/tools/definitions-events.ts`.

- [ ] `create_event` (confirm; title, starts_at, venue, city, role, notes; no `url` field, since enrichment fetches it), `update_event` (confirm), `delete_event` (confirm, chat-commit only).
- [ ] `mark_spoke_to` (auto, `setSpokeToForUser`, undo sets false), `add_attendees_as_contacts` (confirm, `connectAttendees`; `maxRecords: 20`), `add_attendee` (confirm, `upsertEventAttendees`), `remove_attendee` (confirm).
- [ ] `add_target_company` (auto), `remove_target_company` (confirm).
- [ ] Event ids join the proposal allowlist from prefetch and from `list_events` and `get_event_roster` results.
- [ ] Smoke as in 2.3.
- [ ] Commit `feat(tools): event writes as chat proposals`.

### Task 2.6: Retire the JSON-tail proposals

**Files:** `src/lib/ai.ts` (`PROPOSED_ACTIONS_TAIL` :2356-2371, `CHAT_STREAM_TAIL`, `CHAT_JSON_TAIL`), `src/app/api/chat/route.ts`, `src/actions/chat.ts`.

- [ ] Remove `proposed_actions` from both tails; the marker and JSON appear only for recruiter recommendations.
- [ ] Prompt rule, replacing the old "only propose when…": `When the user asks you to add, change, remove, log, remind or schedule something, do it with the tools in this answer. When the answer has one clear next step the user would obviously want, propose it with a tool. Do not propose what nobody asked for on every answer. Never write as though a change is done unless the tool result says "applied".`
- [ ] The route sends `actions` events from the proposal sink as proposals are made, mid-stream, so cards appear while the answer is still writing.
- [ ] `validateProposedActions` remains for legacy rows only; mark it deprecated.
- [ ] Update `smoke-chat-prompt.ts`, `smoke-chat-stream.ts`, `smoke-chat-pipeline.ts`.
- [ ] Commit `feat(chat): proposals come from tool calls, not a JSON tail`.

### Task 2.7: Cards — Confirm all, Undo, done state

**Files:** `src/components/chat/proposed-actions.tsx`, `src/lib/chat-stream-client.ts`, `src/lib/chat-stream-protocol.ts`.

- [ ] Group cards under the answer; a **Confirm all (n)** button when two or more are proposed, which commits sequentially and stops at the first failure.
- [ ] Done cards show **Undo** while `undo` exists and the action is younger than 24 hours.
- [ ] Confirm-tier cards for destructive tools (delete, merge, clear) use the destructive button style and name what will be lost.
- [ ] Mid-stream `actions` events append, not replace.
- [ ] Accessibility: buttons have labels naming the action; Confirm all announces progress through the existing `LoadingRegion`.
- [ ] e2e: add a Playwright case to the chat spec under `e2e/` that confirms two cards and undoes one, with a fake model fixture if one exists; otherwise a component-level test.
- [ ] Commit `feat(chat): confirm all, undo and destructive cards`.

### Task 2.8: Eval and PR

- [ ] Add 8 write cases to the eval: "remind me to call Sam Friday", "Maya moved to Ramp", "log that I had coffee with Omar today about the Series A", "snooze my Stripe reminder a week", "I met Priya at AWS Summit, mark her as spoke to", "delete the duplicate Alex", "add tag investor to everyone I met at the mixer", "move all my overdue reminders to next Monday". Score: the right tool proposed with the right ids and fields; nothing committed without a click.
- [ ] Full checks, app run, PR with the write-case table.

---

# Phase 2b — remaining features

Branch `claude/chat-agent-p2b-writes`. Same pattern as Tasks 2.3–2.5: extract any inline action body into a `*ForUser` lib function, add the tool with a `proposal` descriptor, smoke it.

### Task 2b.1: Goals and schools
- [ ] `add_goal` (auto), `remove_goal` (confirm; extract from `act/goals.ts:64`, undo `restoreGoal`), `set_schools` (confirm).

### Task 2b.2: Opportunities and radar
- [ ] Extract `act/opportunities.ts` bodies into `contact-opportunities.ts` `*ForUser` functions.
- [ ] `create_opportunity` (auto), `update_opportunity` (confirm), `set_opportunity_status` (auto), `delete_opportunity` (confirm, undo `restoreOpportunity`).
- [ ] `schedule_recommendation`, `snooze_recommendation` (auto), `dismiss_recommendation` (confirm, undo `restoreRecommendationForUser`).

### Task 2b.3: Outreach (no sends)
- [ ] Extract `updateCampaign`, `updateOutreachMessage`, `logMessageOutcome` into `src/lib/outreach-writes.ts`.
- [ ] `update_campaign` (confirm), `update_outreach_draft` (confirm), `log_outreach_outcome` (auto). No send, bulk send or prospect search tool.

### Task 2b.4: Recruiters
- [ ] Extract `logRecruiter` and `updateMyLink` into `src/lib/recruiter-writes.ts`.
- [ ] `log_recruiter` (confirm; writes the shared canonical row, so preview says so), `update_recruiter_link` (auto for status and personal rating, confirm for notes).

### Task 2b.5: Meetings
- [ ] `rename_meeting` (auto, `updateMeetingDetails`), `link_meeting_to_event` (auto), `discard_meeting` (confirm, chat-commit only).

### Task 2b.6: Email drafts and settings
- [ ] `draft_email` (confirm): stores a proposal whose card opens the existing Gmail send dialog (`src/components/chat/gmail-send-dialog.tsx`) prefilled; the dialog's own Send is the send. The commit path for this tool never sends.
- [ ] `set_writing_instructions` (confirm), `set_radar_autopilot` (confirm).

### Task 2b.7: Eval cases, full checks, PR
- [ ] One write case per task above in the eval. Full checks. PR.

---

# Phase 3 — auto-apply

Branch `claude/chat-agent-p3-auto-apply`.

### Task 3.1: Schema and setting

**Files:** `src/db/schema.ts` (`user_settings` :113), `src/db/index.ts`, `src/actions/settings.ts`, the settings page AI section.

- [ ] `chatAutoApply: boolean("chat_auto_apply").notNull().default(false)`. Schema bump per Global Constraints.
- [ ] `saveChatAutoApply(enabled: boolean)` server action; extract `saveChatAutoApplyFor(userId, enabled)`.
- [ ] Settings copy: "Let chat make small changes for you" with a one-line list of what it can and cannot do, and a link to undo history (the chat thread).
- [ ] Commit `feat(settings): let chat make small changes itself`.

### Task 3.2: The gate

**Files:** create `src/lib/chat-auto-apply.ts`, `scripts/smoke-chat-auto-apply.ts` (pglite).

- [ ] `shouldAutoApply(proposal, turn): boolean` is true only when all hold: the setting is on; the tool's tier is `auto`; the args do not touch name, email, phone or LinkedIn; `maxRecords` is not exceeded and the proposal touches at most 5 records; fewer than 5 auto-applies have run this turn; the turn's prompt triggered no output scrub and no `injection_signal` (`ai-security.ts:326`) for any record in it.
- [ ] Auto-applied proposals commit in-request through the Task 2.2 path from the stored row, then emit an `actions` event with status `done`.
- [ ] Every auto-apply records `recordAiSecurityEvent({ kind: "chat_auto_apply", userId, detail: { tool, actionId } })`; add the kind.
- [ ] The tool result to the model says `applied` or `proposed`, so the prose matches.
- [ ] Smoke: off → proposed; on and auto tier → applied; identity field → proposed; sixth in a turn → proposed; injection signal in the turn → proposed; undo works on an applied action.
- [ ] Commit `feat(chat): apply small reversible changes when the person allows it`.

### Task 3.3: UI, eval and PR

- [ ] Done cards from auto-apply read "Done · Undo" with the preview text; a thread-level note on first use links to the setting.
- [ ] Re-run the Phase 2 write cases with the setting on: auto-tier cases apply, confirm-tier cases stay proposed.
- [ ] Full checks, app run with the setting on and off, PR.

---

# Phase 4 — hardening

Branch `claude/chat-agent-p4-hardening`.

### Task 4.1: Prompt caching
- [ ] Anthropic: `cache_control` on the system prompt and the prefetched blocks (read the `claude-api` skill for current limits). OpenAI: keep the system prompt and prefetch as a stable prefix. Gemini: implicit caching applies; verify `cachedInputTokens` rises in `usage_events`.
- [ ] Measure cost per case on the eval before and after.

### Task 4.2: Cost and latency gate
- [ ] Add `meanLookups` ≤ 3.5, p50 ≤ Phase 1's +2 s and cost per case ≤ Phase 1's to `scripts/eval-fixtures/ai-eval-thresholds.json` for `chat` and `research`.

### Task 4.3: MCP parity
- [ ] Every new read tool that is safe for outside agents moves to `BOTH` with an MCP field allowlist (no notes, no email bodies). Every new write tool except delete and merge gets `"mcp"` in `surfaces`, following `docs/mcp-vision.md`.
- [ ] Update `smoke-tool-registry.ts` and `docs/mcp-vision.md`.

### Task 4.4: Remove legacy proposal support
- [ ] After one release, migrate stored legacy proposals still in `proposed` status to the new shape with a one-off script, then delete the `args.kind` branches and `validateProposedActions`.

---

## Self-review notes

- Every task names its files, its smoke, and its commit. Every DDL task points at the schema-version scan.
- The write invariant is tested at three layers: the registry smoke (writes never reach chat as writes), the proposers smoke (a proposer without a sink fails closed), and the commit smoke (tampered stored args are rejected).
- Phase 0 is shippable alone and produces the baseline every later gate compares against.
- Biggest risks: cost of tool rounds (Task 1.7 gate, Phase 4 caching); provider streaming quirks (Task 1.1 fixture replays); proposal spam (prompt rule in 2.6, cap of 10, eval cases that score unwanted proposals).
