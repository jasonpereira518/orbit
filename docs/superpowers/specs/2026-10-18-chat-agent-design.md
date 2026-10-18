# Chat as an agent — design

**Status:** draft for discussion. Nothing here is built.

**Goal:** the chat answers from everything Orbit knows, not from a slice of contacts; it can add, change and remove things in every other feature without the person leaving the thread; and it says "I don't know" only after it has actually looked.

## 1. Why it says it doesn't know today

The pipeline is: one cheap "understand" call → hybrid contact search → rerank → *optionally* a read-only research loop → one streaming answer call. Three things follow from that shape.

1. **The answer call cannot look anything up.** It writes from whatever was packed in front of it. The research loop (`src/lib/chat-gather.ts`) is the only place tools run, and `routeFromParsed` (`src/lib/decisions/chat-route.ts:58-94`) only sends a question there for intros, multi-lookups, web lookups, group follow-ups and "prep me". Everything else gets one pass over a 12-contact slice.
2. **Most features never reach the prompt.** Events, attendees, outreach, opportunities, radar cards, job matches, sent-email history, tags and companies as entities: no lane, no tool. Reminders are "due today or overdue, 8 max" (`src/lib/chat-context.ts:87,946`). Calendar is forward-only 14 days (`src/lib/chat-calendar.ts:53-65`). Commitments, goals, network stats and all reminder views exist as tools but only inside the research lane. Even the contact row itself omits email, phone, LinkedIn, how-met, closeness tier and last-touch date (`src/lib/ai.ts:1980`), so "what's Maya's email?" fails after search found Maya.
3. **The prompt tells it to abstain.** `src/lib/ai.ts:2210`: *"if the lists do not say it, you do not know it"*, and `:2212` *"never count from it"*. Correct for grounding, but with a thin prompt the honest answer is often "I don't know". Nothing measures how often that happens: there is no abstention metric, the eval fixtures test positive recall only, and admin feedback is thumbs up/down with the answer text deliberately unread.

Writes are narrower still: seven proposal kinds, at most three per answer, only "when the user asked for exactly one", and the tool registry hard-refuses any write on the chat surface (`src/lib/tools/registry.ts:165,191`). That refusal is deliberate: notes and profiles in the prompt are attacker-writable, so a write reachable from the model's tool loop is one poisoned note away from firing. The design below keeps that invariant and still gets to "do it for me".

## 2. Design

### 2.1 One agentic answer loop, every turn

Replace "gather, then answer" with one streaming answer call that has the read tools available on every question. The model streams prose, pauses to call a tool when it needs something, and continues; the existing step trail narrates each call ("Looked up your events at AWS Summit"). The current retrieval stays as *prefetched* context so simple questions still cost one call and no tool round.

- New `createStreamingToolDriver` beside `createToolDriver` in `src/lib/ai-tools.ts`: all three providers stream tool-use blocks. `runToolLoop` already bounds rounds, calls, time and failure; reuse it with a streaming step.
- Bounds per turn: 4 rounds, 8 calls, same 55 s answer deadline. A lookup budget line in the prompt, as the gather loop does today.
- The `understand` call stays, but its job shrinks to filters and the standalone query; the depth decision goes away (the model decides by calling or not calling).
- Cost control: the 2026-10-14 eval shows a research turn costs about twice a single-pass one. Mitigations: prefetch the cheap, always-useful blocks (below) so most questions need no call; dedupe identical calls (exists); prompt caching on Anthropic and OpenAI for the system prompt and prefetched blocks; a per-turn call cap. Gate on the existing `research` eval's `meanLookups`.

### 2.2 Everything readable

**Prefetched on every turn** (cheap, bounded, no model call): contact rows with email, phone, LinkedIn, how-met, closeness tier, last touch, open opportunities; reminders summary across views (counts plus the 8 nearest due); calendar both ways (past 7 days and next 14); open commitments count; active goals; upcoming events count.

**New read tools**, all in `src/lib/tools/definitions.ts` so MCP gets them too:

| tool | feature | wraps |
|---|---|---|
| `query_contacts` | contacts | `listContactsMatching` + `listContactsPage` filters, with `sort`, `group_by` (company, industry, tag, tier, school, location) and exact `count`. Also "added since", "never contacted", "missing email". |
| `query_interactions` | timeline | count and list by date range, type, contact, source ("how many coffees in March"). |
| `list_events`, `get_event_roster`, `who_did_i_meet_at`, `who_to_talk_to` | events | `listEventsForUser`, `listRosterForUser`, `whoToTalkTo` |
| `list_opportunities`, `list_radar_cards` | radar | `listOpportunitiesForContact`, `listPendingRecommendations` |
| `list_campaigns`, `get_campaign` | outreach | existing readers |
| `list_my_recruiters`, `search_recruiters` | recruiters | `searchCanonicalRecruiters` |
| `get_dossier` | knowledge | `loadKnowledgeDossier` |
| `list_sent_emails`, `list_pending_drafts` | email | `listContactPendingSends`, `listPendingAgentSends` |
| `recent_captures`, `recent_imports` | capture / imports | `listCaptureHistoryFor`, import list |
| `network_stats` (extend) | dashboard | `getDashboardCounts`, `getNetworkStats` |

Existing research-only tools (`list_reminders` all views, `list_open_commitments`, `get_goals`, `due_followups`, `search_notes`, `search_meetings`, `find_path_to`, web research) become available on every turn.

### 2.3 Everything writable, through proposals

Keep the rule: **no write executes from model output alone.** Generalize the mechanism instead of the seven hand-coded kinds.

- Add a third tool scope, `propose`. On the chat surface a write tool's `run` is swapped for a propose variant: validate args with the same schema the commit uses, store a `proposed_action` row on the message, return `{status:"proposed", actionId, preview}` to the model. The registry's read-only guard stays as the backstop for `write`.
- `commitProposedAction` (exists) executes from the stored, validated args, never from live model output. It dispatches by tool name to the same `*ForUser` lib function MCP calls.
- Every proposal carries an undo snapshot where the lib already returns one (reminders, follow-ups, merges, note batches, radar) and gets one added where it does not.
- Cap rises from 3 to 10 per answer; the cards get **Confirm all** and per-card **Undo** after commit.
- The prompt rule flips from "only when the user asked for exactly one" to "when the user asks you to do something, do it with the tools; when an answer has a clear next step, propose it".

Write tools to add (each wraps an existing lib function; the ones marked *extract* are inline in a server action today and need the `reminder-writes.ts` pattern):

| feature | tools |
|---|---|
| contacts | `update_contact` (widen to tags, notes append, closeness, cadence, phone, LinkedIn), `delete_contact`, `merge_contacts`, `rate_closeness`, `pin_contact` |
| interactions | `edit_interaction` *extract*, `delete_interaction`, `complete_action_item` |
| reminders | `update_reminder` *extract*, `delete_reminder`, `reopen_reminder`, `reschedule_reminder`, `move_to_list`, `create_list` *extract*, `set_keep_in_touch` *extract*, `clear_follow_up` |
| events | `create_event`, `update_event`, `delete_event`, `mark_spoke_to`, `add_attendee_as_contact`, `add_target_company` |
| goals, targets | `add_goal`, `remove_goal` *extract*, `set_schools`, `remove_target_company` |
| opportunities | `create_opportunity`, `update_opportunity`, `set_opportunity_status`, `delete_opportunity` *extract* |
| radar | `schedule_recommendation`, `snooze_recommendation`, `dismiss_recommendation` |
| outreach | `update_campaign` *extract*, `update_outreach_draft`, `log_outreach_outcome`; **no send** |
| recruiters | `log_recruiter`, `update_recruiter_link` *extract* |
| meetings | `rename_meeting`, `link_meeting_to_event`, `discard_meeting` |
| email | `draft_email` → the existing Gmail send dialog; the click in that dialog is the send |
| settings | `set_writing_instructions`, `set_radar_autopilot` |

Not exposed: sending anything (email, outreach, recruiter drafts), approving an agent draft, deleting all data, API keys, billing. These stay human-only, per the rule at the top of `src/lib/mcp/server.ts`.

### 2.4 "Without the user manually doing it": a reversible auto-apply tier

A per-user setting, off by default: **Let chat apply small changes itself.** When on, proposals in the *additive and reversible* tier commit immediately and render as a done card with Undo; everything else still asks.

- Auto tier: log a note, create a reminder, snooze or reschedule, add a tag, set a follow-up or cadence, mark spoke-to, add a goal, schedule a radar card.
- Always confirm: delete, merge, anything touching name, email, phone or LinkedIn, any send, settings, anything on more than 5 records at once.
- Guards: at most 5 auto-applies per turn; each one logged as an `ai_security_event`; a turn whose prompt triggered an output scrub (`guardChatAnswer`) auto-applies nothing.

### 2.5 Relevant answers, honest abstention

- Prompt rewrite at `src/lib/ai.ts:2210-2214`: *"If what you need is not in front of you, look it up. Say you don't know only after the relevant lookup returned nothing, and say what you checked."* Keep every grounding rule (never invent, never count from the slice).
- Answer length follows the question: a field lookup gets one line, a "tell me about" gets the profile shape that already exists.
- **Abstention telemetry**: classify every stored answer as answered / partial / abstained (regex first, lite-model fallback on the ambiguous), store it on `chat_messages`, surface the rate on `/admin/product` next to thumbs. This is the number that tells you whether the revamp worked.
- **Eval cases**: add abstention cases to `scripts/eval-fixtures/ai-chat-eval.json`: facts that live only in events, reminders, opportunities and interaction counts (must answer), and true unknowns (must abstain and say what it checked). Gate on both.

## 3. Phases

| phase | what ships | user sees |
|---|---|---|
| 0. Quick wins (1 PR) | Richer contact rows; reminders across views, calendar both ways and commitments prefetched; prompt rule rewrite; abstention telemetry and eval cases | Fewer "I don't know" on field and schedule questions; a number for the rest |
| 1. Agentic loop | Streaming tool driver; all read tools every turn; new read tools for events, outreach, radar, recruiters, knowledge, email, aggregates | Questions about any feature get answered; step trail shows lookups |
| 2. Proposal writes | `propose` scope; write tools for contacts, reminders and events; their lib extractions; Confirm all and Undo; cap 10 | "Add Sam to the AWS event and remind me Friday" is two cards, one click |
| 2b. Remaining writes | Goals, opportunities, radar, outreach, recruiters, meetings, settings tools and extractions | Every feature reachable from the thread |
| 3. Auto-apply | Setting, tier list, guards, audit | Small changes just happen, with Undo |
| 4. Hardening | Prompt caching, cost gate on `meanLookups`, smoke tests for every tool, MCP parity | |

Phase 0 and the telemetry come first so phases 1 to 3 are measured against a baseline.

## 4. Decisions (2026-10-18)

1. **Confirmation policy:** the reversible auto-apply tier in §2.4, behind a per-user toggle that is off by default. Deletes, merges, identity-field edits, sends and settings always ask.
2. **Loop architecture:** one streaming tool loop every turn (§2.1). The two-phase gather-then-answer path is retired once the loop passes the `research` eval.
3. **Order of write coverage:** phase 2 ships contacts, reminders and events; a phase 2b follows with goals, opportunities, radar, outreach, recruiters, meetings and settings.

Still to settle during implementation, not blocking: the exact per-turn call cap (start at 8 and tune on `meanLookups`), and whether `delete_contact` needs a typed confirmation like the contacts page uses.

## 5. Constraints carried over

- `READ_ONLY_SURFACES` and `scripts/smoke-tool-registry.ts:113-117` change to "chat gets `propose`, never `write`"; the smoke asserts that instead.
- Every new tool has a smoke in `scripts/smoke-tool-registry.ts` style and an entry in `scripts/run-smoke.ts`.
- Agent-written text through `sanitizeAgentText`; every tool result fenced as untrusted, as today.
- No tool sends, fetches a model-chosen URL or approves a draft.
- Read `node_modules/next/dist/docs/` before touching the route or server actions, per AGENTS.md.
