# Outreach Campaigns: discover people, start conversations, build relationships

**Date:** 2026-09-13
**Status:** Design approved in brainstorming; awaiting spec review. Implementation is planned
and delivered in four stages (see [Rollout](#15-rollout-stages-and-acceptance)).
**Branch:** `claude/outreach-redesign-campaigns-48b9fc` (stage PRs merge to `main` behind a
closed gate).

## 1. Problem

Outreach today is three tables, one 1,268-line server-action module, and a wizard whose
fourth step does not exist. It cannot do the thing it is named for: help a person start
and sustain real conversations with 20–100 people who matter to them.

What the code does today, and why each part has to change:

- **It sends from Orbit's address, not the user's.** Email goes through Resend from
  `RESEND_FROM_EMAIL` (default `outreach@orbit.local`) with no reply-to, so replies never
  reach a mailbox Orbit can see. A compliance footer is appended at send time
  (`src/lib/outreach-send.ts:73`) and is not visible in the draft the user approved.
- **Bulk sending is request-bound.** `bulkSendOutreach` is a sequential loop inside one
  server action, silently capped at `BULK_SEND_LIMIT = 25` while the UI promises 50/day.
  The daily ceiling is check-then-act (`countSendsToday`), so it can be exceeded.
- **Follow-ups never happen on their own.** They are empty `scheduled` placeholder rows
  that become drafts only when the user presses "Generate due follow-ups"; the admin alert
  "Scheduled outreach is not sending" fires whenever users simply don't press it.
- **Replies are logged by hand.** `OutcomeControls` is the only reply tracking. "Opened" (a
  mailto click) counts as sent in the reply rate.
- **History is not safe.** Re-running search overwrites the status of people already
  contacted (`src/actions/outreach.ts:375`); "Regenerate selected" upserts step 0 and can
  overwrite the body of a message that was already sent.
- **Discovery is a single Apollo query.** 25 results, page 1 only, filters from one LLM
  call, no ranking evidence, no email verification status, and — in production — ten fake
  people returned whenever there is no Apollo key.
- **LinkedIn is copy-and-open only.** `canAutoSend` is false for LinkedIn.

## 2. Goals and non-goals

**Goal.** Rebuild Outreach around personal networking campaigns of 20–100 people:

> **Describe → Confirm audience → Find people → Review drafts → Send → Track conversations**

Each campaign uses exactly one channel (email or LinkedIn) and pins one sender. Users approve
initial messages and suggested follow-ups, read incoming messages, and send reviewed replies
inside Orbit. Orbit's visual system and all historical campaign records are preserved.

**Non-goals (this redesign):**

- New SMS, LinkedIn InMail, automatic follow-up sequences, hosted/cloud browsers.
- More than one connected Gmail and one connected Outlook account per user.
- HTML email, attachments, open/click tracking of any kind.
- Push-based mail sync (Gmail Pub/Sub watch, Graph change notifications) — deferred.
- The `gmail.compose` scope (see [§8.2](#82-sending)).
- Charging research credits for non-Outreach Apollo use (contact refresh,
  `fillContactProfileFromApollo`). Those keep today's behaviour; their calls are metered.

## 3. Decisions settled in brainstorming

| Decision | Choice | Why |
|---|---|---|
| Delivery shape | One umbrella spec; one plan + PR per stage, merged to `main` behind a gate | Stages 2–4 all build on stage 1's model; frequent merges avoid `SCHEMA_VERSION` collisions with parallel worktrees |
| Mail sync cadence | Sync while any Orbit tab is open (app pulse, >5 min stale) + manual Refresh + scheduler backstop | GitHub Actions actually fires every ~35 min (observed 10–78 min gaps against `*/10`/`*/15`); no new infrastructure |
| Discovery search cost | Free but capped; credits are spent only on person research | Discovery is a few cents; charging for searches that find nobody punishes exploration |
| Browser execution | Companion extension ("Orbit Runner") from the same `extension/` codebase | `debugger` cannot be an optional permission; adding it to the main extension would disable it for every existing user and put every update under stricter review |
| Data model | Extend `outreach_campaigns` and `outreach_prospects`; add new tables for drafts, attempts, conversations, runner sessions, jobs, credits; freeze `outreach_messages` as legacy history | Satisfies "separate draft, execution, and outcome state" without two parallel campaign models during the gate |
| Durable execution | One `outreach_jobs` table + a self-continuing worker route | Matches the sync/imports patterns, works on Hobby, fully exercisable in the PGlite smoke harness |

Defaults chosen during design (overridable; each is a named constant in
`src/lib/outreach/config.ts`):

- Email daily ceiling: **50 per rolling 24 h per user**, counting initial messages and
  follow-ups. **Replies to a human reply are exempt** (they are conversation, not outreach)
  but still paced.
- Email pacing ~20 s between sends. LinkedIn: one action at a time, 60–120 s apart, default
  cap 20 invitations/day, and an immediate stop on any restriction notice.
- Follow-up suggestions: at most **2 per conversation**.
- Funding source is chosen **per run, all-or-nothing** (personal keys or Orbit allowance).
- Orbit-funded discovery: 5 runs/day, ≤15 Brave queries per run. Person research attempt:
  45 s, ≤2 supporting Brave queries.
- Pro monthly credit period is anchored to the user's first Pro credit use (lazy rollover),
  not the Stripe period (annual subscribers would otherwise get a yearly period).

## 4. Architecture

### 4.1 Release gate

`isOutreachNextEnabled(userId)` in `src/lib/outreach/gate.ts`:

```
admin (and not currently "viewing as user")  OR  process.env.OUTREACH_NEXT === "on"
```

It **fails closed**. The existing `app_surface_flags` mechanism is right for finished
features but fails open (a database error shows every surface, and a surface key must be
deployed before it can be hidden), which is wrong for a half-built feature that sends real
email from real mailboxes.

Enforced in every layer, as surfaces are: nav, route (page renders new vs. legacy UI),
server action, Runner endpoints, and the job worker. A queued job belonging to a user
outside the gate is **paused**, never run and never failed. Local development sets
`OUTREACH_NEXT=on` in `.env.local`; smoke scripts set it explicitly.

Everyone outside the gate keeps legacy Outreach, unchanged. At cutover `OUTREACH_NEXT=on`
is set, the legacy migration runs, and `page.outreach` resumes its role as the kill switch.

### 4.2 Routes

URLs are unchanged; each page picks the new or legacy UI from the gate.

| Route | Purpose |
|---|---|
| `/outreach` | Campaign list, "Needs attention" strip |
| `/outreach/new` | Describe — creates the campaign immediately (a refresh never orphans it) |
| `/outreach/[id]/audience` | Confirm audience (criteria editor) |
| `/outreach/[id]/people` | Find people + select |
| `/outreach/[id]/review` | Review drafts |
| `/outreach/[id]/send` | Send confirmation + live queue |
| `/outreach/[id]` | Tracking workspace: People · Drafts · Conversations · Activity |

`outreach_campaigns.setup_step` records the furthest step reached; `/outreach/[id]`
redirects to it until the campaign has launched.

### 4.3 Server modules — `src/lib/outreach/`

Each module has one purpose and exposes an injectable seam for the smoke harness.

| Module | Responsibility | Seam |
|---|---|---|
| `gate.ts`, `config.ts` | Release gate; all tunable limits | — |
| `jobs/` | Leased job table, claim/fence/complete, worker loop, handler registry | handler map |
| `discovery/` | Brief → criteria, query planning, candidate parsing, identity + dedupe, ranking | `SearchProvider`, AI completer |
| `research/` | Per-person bounded research attempts | `EnrichmentProvider`, `SearchProvider` |
| `credits/` | Reservation ledger | — |
| `drafts/` | Generation, versions, canonical rendering, content hashes, approvals, channel limits | AI completer |
| `send/` | Send batches, attempts, ceiling, pacing, per-provider transports | `MailTransport` |
| `runner/` | Sessions, tokens, claims, checkpoint protocol, recovery | multimodal completer |
| `conversations/` | Mail sync, message matching, classification, follow-ups, reply suggestions, contact linking | `MailTransport`, AI completer |
| `metrics.ts` | Campaign counts and rates | — |

Server actions live in `src/actions/outreach-campaigns.ts`, `outreach-people.ts`,
`outreach-drafts.ts`, `outreach-send.ts`, `outreach-conversations.ts` — every export async
(a single non-async export breaks a `"use server"` file), every mutation wrapped in
`asActionResult` and throwing `UserFacingError` for anything a person should read.

### 4.4 Entry points

- `POST /api/outreach/worker` — internal (`isInternalRequest`, `CRON_SECRET`), listed in
  `PUBLIC_ROUTES`, `maxDuration = 300`, total budget ~240 s, re-invokes itself through
  `after()` + `internalFetch` when due work remains. Kicked by: actions that enqueue work,
  the app pulse, and `ops.yml` (added to the `*/15` sync job).
- `/api/outreach/runner/*` — Runner endpoints (see [§10.3](#103-endpoints-and-auth)).
- `/api/outlook/callback` — existing, extended with mail scopes.

### 4.5 Invariants

1. **Tenancy.** Every row carries `user_id`, including child tables (fixing today's
   scope-via-parent gap on prospects and messages). Every query filters on it; every
   worker handler receives the job's `user_id` and never reads another.
2. **Untrusted content is data.** Search snippets, enrichment payloads, incoming messages,
   page DOM, and screenshots never change recipients, approved content, or which actions
   are approved. In prompts they are delimited and labelled as untrusted.
3. **Approval is bound to content.** An approval is valid only for the exact `content_hash`
   it approved; the hash is recomputed at claim time.
4. **Every external side effect has an idempotency key** (see [§6.6](#66-exactly-once)).
5. **Nothing is invented.** Emails come only from a provider or the user; profile facts
   only from stored evidence. Sample data exists only in explicit demo mode.

## 5. Data model

All new tables: `user_id text not null`, indexes leading with `user_id`, registered in
`purgeUserData` (`src/lib/user-data.ts`, enforced by `smoke-purge`) and — for encrypted or
token columns — in `NEVER_REVEALABLE` (`src/lib/admin-redaction.ts`). Timestamps are
`timestamptz`. Status columns are `text` with TS unions in `src/lib/outreach/types.ts`
(matching the codebase: no pg enums). DDL goes in the `DDL` template (new tables) and
the `alters` list + PGlite `ensureColumn` (new columns); `SCHEMA_VERSION` is chosen at
implementation time after scanning every branch for burned numbers, and
`scripts/schema-ddl.lock.json` is regenerated.

### 5.1 Extended: `outreach_campaigns`

| Column | Type | Notes |
|---|---|---|
| `generation` | int, default 1 | 1 = legacy, 2 = new model |
| `brief` | jsonb | `{ purpose, desiredOutcome, notes? }` |
| `channel` | text | `email` \| `linkedin` for generation 2 (`default_channel` stays for legacy) |
| `sender_account_id` | uuid null | → `outreach_sender_accounts` |
| `sending_method` | text null | `gmail_api` \| `outlook_api` \| `browser_gmail` \| `browser_outlook` \| `browser_linkedin` |
| `sender_intro` | text | copied from `user_settings.outreach_sender_intro`, editable per campaign |
| `criteria` | jsonb | `{ required: Criterion[], preferred: Criterion[], exclusions: Criterion[] }` |
| `criteria_version` | int, default 0 | bumped on every confirmed edit |
| `criteria_confirmed_at` | timestamptz null | |
| `setup_step` | text | `describe` \| `audience` \| `people` \| `review` \| `send` \| `tracking` |
| `launched_at` | timestamptz null | first send batch started |

`Criterion = { id, kind: "role"|"organization"|"geography"|"experience"|"other", label,
values: string[], priority: number }`. Required and preferred are structurally separate;
`priority` orders preferences.

### 5.2 Extended: `outreach_prospects`

| Column | Type | Notes |
|---|---|---|
| `user_id` | text | backfilled from the campaign |
| `external_id` | (existing, not null) | generation 2: the strongest identity at insert — `li:<slug>`, `apollo:<id>`, `email:<address>` — or `manual:<uuid>`; the existing `UNIQUE (campaign_id, external_id)` stays |
| `origin` | text | `discovered` \| `manual` \| `legacy` \| `demo` |
| `status` | (existing) | generation 2: **selection only** — `suggested` \| `selected` \| `excluded`. Pipeline state lives on conversations, so a re-run can never reset someone already contacted |
| `excluded_reason` | text null | user reason or filter reason |
| `headline` | text null | |
| `rank_score` | real null | 0–1, computed in code ([§7.4](#74-ranking)) |
| `rank_tier` | text null | `strong` \| `possible` \| `weak` \| `filtered` |
| `rank_explanation` | jsonb null | `{ summary, criteria: [{ criterionId, verdict, evidenceIds[], note }] }` |
| `ranked_criteria_version` | int null | stale when `< campaigns.criteria_version` |
| `ranked_at` | timestamptz null | |
| `research_state` | text | `none` \| `queued` \| `running` \| `done` \| `partial` \| `failed` \| `skipped_budget` |
| `research_confidence` | text null | `high` \| `medium` \| `low` |
| `email_status` | text null | `verified` \| `unverified` \| `unavailable` \| `bounced` |
| `email_source` | text null | `apollo` \| `user` \| `legacy` |
| `possible_duplicate_of` | uuid null | name-only match; never auto-merged |
| `duplicate_review` | text null | `pending` \| `merged` \| `distinct` |
| `flags` | jsonb | `{ existingContactId?, previousCampaigns?, suppressed? }`, computed on insert |

### 5.3 New: discovery and research

**`outreach_identities`** — `id, user_id, campaign_id, prospect_id, kind (linkedin_slug|email|apollo),
value (normalized), created_at`.
- `UNIQUE (campaign_id, kind, value)` — dedupe within a campaign is structural: a candidate
  whose identity already exists merges its evidence into that prospect.
- `INDEX (user_id, kind, value)` — "Contacted in *other campaign*" and suppression lookups.
- LinkedIn values use the existing normalizer in `src/lib/duplicates.ts` (which must stay
  byte-identical to `extension/src/inject/dom/url.ts`); emails are lower-cased and trimmed.
- Normalized with `identityKeysFor` from `src/lib/duplicates.ts`, the same rule `contact_identities`
  uses.

**`outreach_evidence`** — `id, user_id, campaign_id, prospect_id, run_id null,
kind (search_result|enrichment|web_page|user_note), provider (brave|apollo|user|demo),
url, title, snippet (≤1,000 chars), facts jsonb, observed_at, content_hash, created_at`;
`UNIQUE (prospect_id, content_hash)`. `facts` holds extracted claims with provenance
(`{ title?, company?, location?, … }`). Missing information is the absence of evidence;
a confirmed mismatch is a verdict that cites evidence.

**`outreach_research_runs`** — `id, user_id, campaign_id, criteria_version, status
(queued|running|completed|partial|failed|cancelled), phase
(planning|searching|ranking|researching|finishing), funding_source (orbit|personal),
query_budget, queries_used, research_budget, research_used, candidates_found, plan jsonb
(the queries and per-query outcome), stats jsonb (per-provider calls, errors, costs),
hold_id null, error, started_at, finished_at, created_at`.

**`outreach_research_attempts`** — `id, user_id, campaign_id, prospect_id, run_id null,
funding_source, status (queued|running|succeeded|partial|failed|cancelled), credit_state
(none|held|charged|released), hold_id null, provider_calls jsonb, started_at, finished_at,
created_at`. One attempt = one bounded person-research unit; provider retries inside it
reuse the row and never charge again.

**`outreach_suppressions`** — `id, user_id, kind, value, reason (opted_out|bounced|user),
source_conversation_id null, created_at`; `UNIQUE (user_id, kind, value)`. Checked at
selection (flag) and at claim time (block).

### 5.4 New: research credits

**`research_credit_accounts`** (one row per user, PK `user_id`): `monthly_allowance,
monthly_used, monthly_held, period_start, period_end, lifetime_remaining, lifetime_held,
lifetime_granted_at, last_hold_monthly, last_hold_lifetime` (scratch columns written by the
reserve statement so `RETURNING` can report the split), `updated_at`.

**`research_credit_holds`**: `id, user_id, run_id null, amount_monthly, amount_lifetime,
used_monthly, used_lifetime, period_start, status (active|settled|released),
last_charge_bucket (monthly|lifetime null — scratch: which bucket the latest charge drew
from), created_at, updated_at`.

**`research_credit_ledger`** (append-only audit): `id, user_id, entry_type
(grant|reserve|charge|release|expire|adjust), amount_monthly, amount_lifetime (signed),
hold_id, run_id, attempt_id, period_start, idempotency_key, note,
created_at`; `UNIQUE (user_id, idempotency_key)`.

Mechanics in [§7.6](#76-credits).

### 5.5 New: jobs

**`outreach_jobs`**: `id, user_id, campaign_id null, kind, payload jsonb, status
(queued|running|succeeded|failed|cancelled|paused), priority int, run_after, lease_owner,
lease_expires_at, attempts, max_attempts, progress jsonb, result jsonb, last_error,
idempotency_key, created_at, updated_at, finished_at`;
`UNIQUE (user_id, idempotency_key)`; partial index on `(run_after)` where
`status IN ('queued','running')`.

Job kinds: `discovery.run`, `ranking.batch`, `ranking.rerank`, `research.person`,
`drafts.generate`, `send.user`, `mail.sync`, `conversation.classify`,
`conversation.suggest_reply`, `followups.scan`, `contacts.link`.

### 5.6 New: senders and drafts

**`outreach_sender_accounts`** — the durable sender identity a campaign pins:
`id, user_id, kind (gmail|outlook|linkedin), transport (api|browser), address
(stored normalized: lower-cased email, or the normalized LinkedIn profile URL),
display_name, signature (email only), linkedin_note_limit int null (null = unknown →
enforce 200; never above 300), status (active|needs_reauth|disconnected),
last_verified_at, created_at, updated_at`; `UNIQUE (user_id, kind, transport, address)`.

It outlives OAuth connections (a disconnect deletes the `gmail_connections` row). At send
time the pinned `address` is resolved against the user's live connection; a mismatch
blocks sending with "Reconnect the account this campaign uses". Browser accounts are
created when a Runner session identifies them.

**`outreach_drafts`** — one row per message slot: `id, user_id, campaign_id, prospect_id,
conversation_id null, kind (initial|follow_up|reply), step int, current_version_id,
approved_version_id null, state (suggested|editing|approved|locked|discarded),
blocked_reason null, legacy_message_id null (UNIQUE), created_at, updated_at`.

**`outreach_draft_versions`** — immutable snapshots: `id, user_id, draft_id, version int,
channel, to_address null, recipient_profile_url null, from_address, from_name, subject null,
body, signature null, rendered_text, char_count, content_hash, created_by
(ai|user|batch_instruction|legacy), generation_meta jsonb, approved_at null, created_at`;
`UNIQUE (draft_id, version)`.

- `rendered_text` is exactly what is sent: for email `body` + `"\n\n"` + `signature` (when
  non-empty); for LinkedIn the note/message text.
- `content_hash = sha256(canonical JSON of { channel, from_address, from_name, to_address |
  recipient_profile_url, subject, rendered_text })`.
- Any edit writes a new version and clears `approved_version_id`.

### 5.7 New: sending

**`outreach_send_batches`** — the queue behind one Send confirmation: `id, user_id,
campaign_id, sender_account_id, method, status (queued|running|paused|cancelled|completed|
blocked), blocked_reason, total, idempotency_key, created_at, started_at, paused_at,
cancelled_at, finished_at`; `UNIQUE (user_id, idempotency_key)`.

**`outreach_send_attempts`** — execution state: `id, user_id, campaign_id, batch_id null,
draft_id, draft_version_id, content_hash, sender_account_id, method, state (pending|claimed|
submitting|accepted|confirmed|needs_verification|failed|cancelled), run_after,
lease_owner, lease_expires_at, runner_session_id null, provider_draft_id,
provider_message_id, provider_thread_id, rfc_message_id, error_code, error_detail,
retryable bool, checkpoint jsonb, claimed_at, submitted_at, accepted_at, confirmed_at,
created_at, updated_at`.

`UNIQUE (draft_id) WHERE state IN ('pending','claimed','submitting','accepted','confirmed',
'needs_verification')` — one live-or-successful attempt per draft, enforced by the database.

### 5.8 New: conversations and sync

**`outreach_conversations`**: `id, user_id, campaign_id, prospect_id, channel
(email|linkedin|sms), sender_account_id null, provider (gmail|outlook|linkedin|resend|
twilio), provider_thread_id null, linkedin_invite_state null (pending|accepted|withdrawn),
invite_accepted_at null, outcome null (positive|neutral|negative|not_now|opted_out|bounced),
outcome_source null (ai|user), outcome_set_at, needs_attention bool, last_inbound_at,
last_outbound_at, last_human_reply_at, follow_up_due_at, follow_up_state
(none|due|suggested|suppressed|done), follow_ups_suggested int, suppressed_reason null
(human_reply|opted_out|closed|bounced), closed_at, contact_id null, created_at, updated_at`;
`UNIQUE (user_id, provider, provider_thread_id)` (where not null).

**`outreach_conversation_messages`**: `id, user_id, conversation_id, direction
(outbound|inbound), kind (message|invitation|invitation_accepted|auto_reply|bounce|
delivery_failure|system), send_attempt_id null, provider_message_id null, rfc_message_id,
in_reply_to, references_ids text[], from_address, to_addresses text[], subject,
body_text (sanitized plain text, ≤20,000 chars), body_hash, occurred_at, observed_via
(gmail|graph|runner|legacy|orbit), sent_outside_orbit bool, match_confidence
(exact|probable|ambiguous), legacy_message_id null (UNIQUE), created_at`.

- `dedupe_key text not null` with `UNIQUE (user_id, dedupe_key)` — duplicate sync events are
  no-ops. Computed in code: `"<observed_via>:<provider_message_id>"` when the provider gives
  an id; for Runner observations (no provider ids)
  `"runner:" + sha256(conversation_id | body_hash | UTC hour of occurred_at)`; for legacy rows
  `"legacy:<legacy_message_id>"`. (A stored key, because an expression index over
  `date_trunc` on `timestamptz` is not IMMUTABLE and Postgres rejects it.)
- Only messages in tracked threads (plus matched bounces) are stored; the rest of the
  mailbox is never persisted.

**`outreach_mail_sync_state`** (PK `sender_account_id`): `user_id, provider, cursor jsonb
(Gmail `{ historyId }`; Outlook `{ inbox: deltaLink, sentItems: deltaLink }`),
last_success_at, last_attempt_at, status (idle|syncing|error|needs_reauth), error,
failures, next_sync_at, lease_expires_at, updated_at`. Deliberately separate from
`gmail_connections.sync_cursor`, which the calendar sync overwrites wholesale
(`src/lib/sync-scheduler.ts:228,238`).

### 5.9 New: Runner sessions

**`outreach_runner_sessions`**: `id, user_id, install_id, token_hash, token_expires_at,
sites text[], accounts jsonb (per site: identified account, e.g. LinkedIn
`{ profileUrl, name, noteLimit }`, email `{ address }`), status (active|paused|stopped|
expired), last_heartbeat_at, last_tracking_check_at jsonb (per site), started_at,
stopped_at, stop_reason null (user|account_mismatch|login_challenge|restriction|
uncertain_state|browser_closed|expired)`.

Runner actions **are** send attempts (the `browser_*` methods) plus conversation checks;
there is no parallel action table.

### 5.10 Settings columns (`user_settings`)

`outreach_sender_intro text`, `brave_api_key_encrypted text`, `brave_key_verified_at`,
`apollo_key_verified_at`, `outreach_funding_preference text (orbit|personal)`,
`linkedin_risk_acknowledged_at`. The two `*_encrypted`/verification columns are added to
`NEVER_REVEALABLE`, and the per-user flags to `purgeUserData`'s preserved-column review.

### 5.11 Legacy

`outreach_messages` is frozen (no new writes once a user is inside the gate) and becomes
read-only history. The cutover migration ([§14](#14-legacy-migration)) maps it into
drafts, conversations, and messages, keyed on legacy row ids.

## 6. State machines

### 6.1 Drafts

```
suggested ─┐
           ├─► editing ──approve──► approved ──attempt claimed──► locked
created ───┘      ▲                    │
                  └──── new version ◄──┘   (edit, sender/signature/recipient change)
any ──discard──► discarded
```

- **Validation before approval.** Email: `to_address` present and `email_status` not
  `unavailable`/`bounced`; an `unverified` address requires an explicit per-draft
  acknowledgment. LinkedIn: `char_count ≤ limit` (sender account's
  `linkedin_note_limit ?? 200`, never >300) and a profile URL. Recipient not suppressed.
- **Batch approve** approves only drafts that pass validation and reports the rest ("18
  approved · 3 need attention").
- **Invalidation.** Any change to a hash input — body, subject, recipient (including research
  later changing an address), sender, or signature — produces a new version with no
  approval. Signature edits list affected drafts as "Re-approve (signature changed)" and
  offer batch re-approval.
- **Editing a draft whose attempt is still `pending`** cancels that attempt. Once claimed,
  the draft is `locked`.

### 6.2 Email send attempts

```
pending ─► claimed ─► submitting ─► accepted ─► confirmed
              │           │            │
              │           └─(lease lost)─► needs_verification ─► confirmed | pending | (user)
              └─(check fails)─► failed | (blocked batch)
```

**Claim-time checks** (all must pass, else the attempt is not claimed and the batch shows
why): gate open; batch not paused/cancelled; ceiling room; pinned sender address equals the
live connection's address and the connection has send scope; recomputed `content_hash`
equals the approved version's hash; recipient not in `outreach_suppressions`.

Provider-specific submission and recovery are in [§8.2](#82-sending). Errors:

| Class | Examples | Handling |
|---|---|---|
| Retryable | 429, 5xx, timeouts | Back to `pending`, `run_after` backoff (30 s, 2 m, 10 m, 1 h), same attempt |
| Actionable | revoked grant, missing scope, recipient rejected, mailbox full | `failed`, `retryable = false`, message names the fix ("Reconnect Outlook", "Address rejected") |
| Unknown outcome | lease expired in `submitting` | `needs_verification` → reconciliation |

A new attempt for the same draft is allowed only after the previous one is `failed` with
`retryable` or `cancelled`; `needs_verification` must be reconciled first.

### 6.3 Runner send attempts

```
claimed → navigated → composer_open → content_verified → send_clicking → clicked → post_verified
```

Stages are stored in `checkpoint` with timestamps. The server accepts only the legal next
stage. Before `send_clicking` is persisted:

1. the signed-in account on the page equals the pinned sender (the session's identified
   account);
2. the recipient identity on the page (profile URL; otherwise name + headline) matches the
   prospect;
3. the composer read-back, hashed server-side, equals the approved `content_hash`.

After `send_clicking`, a lost lease or heartbeat means `needs_verification`. On the next
session the Runner revisits the recipient: pending invitation or the sent message present →
`confirmed`; `Connect` available and no message → back to `pending`; anything else → user.
A pre-existing pending invitation or an existing 1st-degree connection is recorded as
observed state (never re-sent); "already connected" offers to convert the draft into a
message draft for approval.

### 6.4 Batches

`queued → running ⇄ paused → completed`, plus `cancelled` and `blocked (reason)`.
Cancelling cancels `pending` attempts; the one in flight still resolves. Recipients beyond
the ceiling stay `pending` with `run_after` = when room frees ("32 sent · 18 waiting for
allowance"); nothing is truncated. A closed gate pauses, never fails.

### 6.5 Conversations

Created when an attempt reaches `accepted` (so replies can match immediately). State is
derived from messages plus explicit fields: invite pending → accepted; outbound only →
awaiting reply; human inbound → `needs_attention` until the user replies, closes, or
dismisses. `outcome` is AI-suggested on human replies and **always overridable** by the
user (`outcome_source = 'user'` wins and is never overwritten by later classification).

### 6.6 Exactly-once

| Concern | Mechanism |
|---|---|
| Jobs, batches, credit operations | `UNIQUE (user_id, idempotency_key)` |
| Double-clicked Send | batch idempotency key = campaign + sorted approved version ids |
| Sends | unique live attempt per draft + provider draft id (Outlook) or content match (Gmail) |
| Concurrent workers | lease claim + `lease_owner` fence on every completion write; `send.user` is one job per user |
| Synced messages | provider-id uniqueness; Runner body-hash key |
| Contact creation | `UPDATE … SET contact_id = $1 WHERE id = $2 AND contact_id IS NULL`, plus the `contact_identities` unique index |
| Campaign history in the contact timeline | ingest spine interactions with external id `outreach:msg:{message_id}` |

## 7. Discovery, ranking, research, credits

### 7.1 Describe → Audience

On leaving Describe, an AI call (user's key, `operation: "outreach.criteria"`) turns the
brief into `{ required, preferred, exclusions }`, validated with Zod. The Audience step edits
them as chips grouped by requirement; "Confirm audience" sets `criteria_confirmed_at` and
bumps `criteria_version`. If people have already been found, confirming enqueues
`ranking.rerank`.

### 7.2 Funding

Chosen per run and shown before Start: "Orbit allowance · 212 credits left" or "Your Brave +
Apollo keys".

- **Personal:** requires a verified personal Brave key. Without a personal Apollo key,
  research is skipped and the run says so. A rejected personal key (401/403) stops the run
  with "Your Brave key was rejected" — it never falls back to Orbit's allowance.
- **Orbit:** requires Pro or Lifetime and is rate-limited (`RATE_LIMITS.outreachOrbitSearch`:
  5 runs/day) with ≤15 Brave queries per run.
- Personal keys are verified live on save (a minimal Brave query; Apollo `auth/health`),
  following the verified-key pattern of `connectLuma`.

### 7.3 Discovery job (`discovery.run`)

1. **Query plan.** AI generates queries from criteria, predominantly
   `site:linkedin.com/in "<role>" "<organization>" <place>`, plus exclusion terms. On AI
   failure, a deterministic template expansion of the criteria is used. Stored in `plan`.
2. **Search.** `SearchProvider.search(query, { count: 20, offset })`. Brave:
   `GET https://api.search.brave.com/res/v1/web/search`, `X-Subscription-Token`, `count ≤ 20`,
   `offset ≤ 9`; request the next page only while `more_results_available`.
3. **Parse.** LinkedIn profile results become candidates — name, headline, company, location
   from the result title (`Name - Title - Company | LinkedIn` and variants) and snippet —
   plus a `search_result` evidence row. Unparseable results are kept as run stats, not
   people.
4. **Dedupe + flag.** Insert-or-merge by identity ([§5.3](#53-new-discovery-and-research)).
   Name-only collisions create a separate prospect with `possible_duplicate_of`.
   Flags computed on insert: existing contact (`contact_identities`), previous outreach
   (identity index across the user's other campaigns), suppressed.
5. **Rank** in batches of 8 as candidates arrive (`ranking.batch`).
6. **Research** the best candidates within the run's budget (`research.person`).
7. Finish as `completed`, or `partial` with reasons when a budget or provider stopped it.
   Everything found is kept.

The People page polls a read action for rows past a cursor while a run is active.

### 7.4 Ranking

The AI (user's key, `operation: "outreach.rank"`) receives the criteria and each
candidate's evidence (delimited, untrusted) and returns, per candidate and criterion,
`verdict ∈ { match, partial, mismatch, unknown, conflicting }` with evidence ids and a short
note, plus a one-line summary. Output is Zod-validated; a candidate with an invalid
response is retried once, then marked `unknown` across the board.

**Score and tier are computed in code** (explainable, deterministic, tunable against
fixtures):

```
known(v)       = v ∈ { match, partial, conflicting }         // "unknown" is excluded
value(match)=1, value(partial)=0.5, value(conflicting)=0.5
requiredFit    = mean(value over known required verdicts), or 0.5 if none known
preferredFit   = priority-weighted mean over known preferred verdicts, or 0.5 if none known
rank_score     = 0.7·requiredFit + 0.3·preferredFit
confidence     = |known required| / |required|  → high ≥ 0.8, medium ≥ 0.5, else low

tier = filtered  if any required verdict = mismatch, or any exclusion = match
     = strong    if every required verdict = match and confidence = high
     = possible  if requiredFit ≥ 0.5
     = weak      otherwise
sort by tier, then rank_score desc, then confidence desc
```

`unknown` lowers confidence, never the score: missing information is not a mismatch.
`conflicting` is shown with both sources. `filtered` people appear under "Filtered out"
with the reason.

**Reranking.** `ranking.rerank` re-scores every prospect whose `ranked_criteria_version` is
stale, from stored evidence only — no provider calls, no credits. Rows show "Re-ranking…"
until current.

### 7.5 Research (`research.person`)

- The run reserves `min(research_budget, available)` credits at start. Research proceeds in
  rank order over `strong` and `possible` prospects not yet researched, as ranking arrives.
  Users can research more people later from the People page (1 credit each, same mechanics).
- One attempt, bounded to 45 s:
  1. `EnrichmentProvider.match` — Apollo `people/match` by LinkedIn URL, else by name +
     organization domain → email, `email_status`, employment history, Apollo id.
  2. ≤2 targeted `SearchProvider` queries (`"<name>" "<organization>"`) for supporting
     sources → evidence rows.
  3. Re-rank this prospect with the fuller evidence.
- Retries inside the attempt (Apollo's existing 429/5xx backoff) are free.
- **Charging:** `succeeded` or `partial` charges 1 credit from the run's hold; `failed`
  (no provider returned anything) releases it. Run completion releases the remainder.
- **Email status mapping** from Apollo: `verified` → `verified`; `guessed`, `extrapolated`,
  `likely to engage`, unknown values → `unverified`; `unavailable` → `unavailable`;
  `bounced` → `bounced`. Addresses never come from anywhere else except the user.
- **Demo.** Fixture-backed `DemoSearchProvider`/`DemoEnrichmentProvider` are selected only for
  demo accounts (`isDemoAccount`) or when a smoke test injects them. Every row they produce
  is `origin = 'demo'` with a visible Demo badge. Production with no usable key shows an
  honest setup state; today's fake-prospects fallback (`apollo.ts:419-425`) is not used by
  the new flow.

### 7.6 Credits

- **Grants.** Pro — a live Orbit Pro subscription or an `orbit` comp, i.e. the condition
  `entitlements.ts` already uses for `canUseHostedEnrichment` (which is *not* the same as
  `plan === "orbit"`: a Lifetime holder with a live subscription resolves to `lifetime`):
  `monthly_allowance = 250` (`OUTREACH_ALLOWANCES.orbitMonthly`, env-overridable). The
  period is anchored lazily on first credit use and rolls over (`used = 0`, new
  `period_start/end`) on the first credit operation past `period_end`; a user no longer on
  Pro rolls to an allowance of 0. Lifetime — `lifetime_purchased_at` set or a `lifetime`
  comp: `lifetime_remaining += 100` once, idempotent on ledger key `lifetime-grant`. A
  Lifetime holder who also subscribes has both buckets; monthly is spent first.
- **Outreach research uses this credit check, not `canUseHostedEnrichment`.** That is what
  lets Lifetime holders spend their 100 credits on Orbit's Apollo key; every other Apollo
  path keeps the existing entitlement.
- **Every operation is one SQL statement** (neon-http has no interactive transactions): a
  data-modifying CTE that updates the account row under its row lock (the `WHERE` re-check
  makes concurrent reservations safe) and inserts the hold and ledger rows from the
  `UPDATE … RETURNING`. Reserve takes `LEAST(n, monthly_free)` from monthly and the rest
  from lifetime, writing the monthly share to `last_hold_monthly` so the hold row can record
  the split. Charge and release move amounts between `*_held` and `*_used`/`*_remaining`,
  guarded by `credit_state` transitions on the attempt row in the same statement.
- **Holds in flight at a rollover carry over.** Rollover resets `monthly_used` but keeps
  `monthly_held`, so an in-flight hold's charges count against the new period and its
  release frees new-period credits. Runs last minutes, so this only touches a run that
  straddles the instant of rollover, and never creates or destroys credits.
- **Metering** of actual provider cost is separate: every Brave and Apollo call records a
  `usage_events` row (`provider: 'brave'|'apollo'`, `kind: 'search'|'enrichment'`,
  `key_owner: 'orbit'|'user'`, `estimated_cost_micros`), so costs appear in the existing admin
  views. `KNOWN_OPERATIONS` gains the new operation labels. Metering never enforces.
- **Visibility.** The People page shows the balance and the run's reservation; Settings shows
  balance, period, and the ledger history.

### 7.7 Selection

Per-row checkboxes; "Select page" selects the visible page; a banner then offers "Select all
87 matching Strong + Possible". "All matching" is a server action taking
`{ campaignId, filter, exceptIds }` that updates every matching row at that moment and returns
the exact count, which the confirmation states. Selection never modifies anyone with a
conversation.

## 8. Connected email

### 8.1 Scopes and setup

- **Outlook** adds delegated `Mail.ReadWrite` (drafts, `createReply`, delta) and `Mail.Send`
  to `src/lib/outlook.ts` scopes. `hasMailScopes()` gates sending; existing connections show
  "Reconnect to send and track mail". Consent errors `AADSTS65001`/`AADSTS90094` render
  "Your organization requires an admin to approve Orbit".
- **Gmail** needs no scope change: `gmail.send` + `gmail.readonly` cover sending, history
  sync, reading tracked threads, and importing the user's signature via
  `users.settings.sendAs.list`.

### 8.2 Sending

All email is `text/plain; charset=UTF-8`, body exactly `rendered_text` — no footer, no
tracking, no hidden headers. Replies and follow-ups carry only the reviewed text (no quoted
history).

**Outlook — draft-then-send** (deterministic recovery):

1. `POST /me/messages` (new) or `POST /me/messages/{id}/createReply` (in-thread, then
   `PATCH` the body to `rendered_text`), with `Prefer: IdType="ImmutableId"` so the id
   survives the move to Sent Items.
2. Checkpoint `provider_draft_id`, `conversationId`, `internetMessageId` → `submitting`.
3. `POST /me/messages/{id}/send` → 202 → `accepted`. (202 means accepted for processing,
   not delivered.)
4. `GET /me/messages/{id}` shows it in Sent Items with `isDraft = false` → `confirmed`.
- **Recovery** from `needs_verification`: draft still in Drafts → resend the same draft;
  in Sent Items → `confirmed`.

**Gmail — direct send** (`gmail.send` cannot create drafts, and the Gmail API replaces any
caller-supplied Message-ID, so neither can be the recovery key):

1. Checkpoint → `submitting` (with `submitted_at`).
2. `users.messages.send` with `{ raw, threadId? }` → `{ id, threadId }` → `accepted`.
3. `users.messages.get(id, format=metadata, metadataHeaders=Message-ID)` shows `SENT` →
   `confirmed`; store Gmail's real `Message-ID` as `rfc_message_id` for future threading.
- **Recovery** from `needs_verification`: `messages.list(q = "in:sent to:<addr>
  after:<submitted_at − 60 s>")`, fetch candidates, match recipient + subject +
  sha256(normalized body). Exactly one → `confirmed`; none after a 2-minute grace → not sent,
  retry allowed; several → the user decides.

**Threading.** In-thread sends set the provider thread (`threadId` / `createReply`) and
`In-Reply-To` + `References` from `rfc_message_id`s captured by sync, with a `Re:` subject.
This fixes today's broken threading, where `recruiter-messages.ts` passes a `threadId` but no
RFC headers.

**Sent is not delivered.** A bounce observed later marks the attempt's conversation
`bounced`, adds the address to `outreach_suppressions`, and shows on the person.

### 8.3 Sender identity

Every campaign header and the Send screen show "From: Name <address> · via Gmail" (or
Outlook, or the Runner). The signature belongs to the sender account; it is editable in
Settings and importable from Gmail (`sendAs` signature, HTML → text). The reusable sender
introduction lives in `user_settings.outreach_sender_intro`; each campaign keeps an
editable copy.

### 8.4 Sync (`mail.sync`, one job per sender account)

- **Gmail:** `users.history.list(startHistoryId, historyTypes=messageAdded)`; keep only
  messages whose `threadId` is tracked; fetch them (`format=full`), sanitize, store.
  The initial `historyId` comes from `users.getProfile` at the account's first send.
  **Expired cursor** (404): rebaseline — `threads.get` for each tracked thread (bounded),
  then a fresh `historyId`.
- **Outlook:** per-folder delta on Inbox and Sent Items with `$select` and
  `Prefer: odata.maxpagesize`; keep messages whose `conversationId` is tracked.
  **Expired delta** (410 / `syncStateNotFound`): rebaseline by filtering each tracked
  conversation, then start a fresh delta with `$filter=receivedDateTime ge <last success>`.
- **Classification, rules first:**
  - auto-reply: `Auto-Submitted: auto-replied`, `X-Autoreply`, `X-Autorespond`,
    `Precedence: auto_reply|bulk|junk`, out-of-office subject patterns;
  - bounce / delivery failure: DSN (`multipart/report; report-type=delivery-status`),
    Exchange NDRs, `mailer-daemon`/`postmaster` senders — matched to the original through
    `References`/`In-Reply-To` or the embedded original's `Message-ID` (`exact`), else
    subject + recipient + time (`probable`);
  - everything else inbound is a human reply → `conversation.classify` (AI outcome).
- **Bounces outside the tracked thread.** A DSN does not always land in the original
  thread, and the tracked-thread filter would miss it. Gmail therefore also runs one
  `messages.list(q = "from:(mailer-daemon OR postmaster) newer_than:3d")` per sync and
  inspects only those; Outlook already has `from`/`subject` in its delta `$select` and
  inspects NDR senders. A bounce is stored only if it matches a tracked outbound message.
- **Replies sent outside Orbit:** the user's own messages in a tracked thread (Gmail `SENT`
  label; Outlook Sent Items) are recorded as outbound with `sent_outside_orbit = true`; they
  clear `needs_attention` and satisfy the follow-up timer.
- **Cadence:** the app pulse enqueues `mail.sync` (idempotency key per account per 5-minute
  bucket) for any sender account with `last_success_at` older than 5 minutes and kicks the
  worker; the Conversations tab has Refresh; `ops.yml` is the backstop. The lease prevents
  overlap; upserts are idempotent.
- **Failures:** a rejected refresh (`isRefreshRejection`) marks the sender account
  `needs_reauth`, blocks its sends with a reason, and shows "Outlook disconnected · last
  synced 2 h ago · Reconnect" on the campaign and in Settings. Transient failures back off
  and show the last successful sync.

### 8.5 Targeted fixes to existing code

- `getValidAccessToken` (`src/lib/gmail.ts:307-349`) refreshes through an upsert that also
  resets `next_sync_at`, `sync_failures`, and `sync_error`, so every refresh re-arms the
  calendar sync and cancels its backoff. Token refresh will write only token columns (same
  for Outlook). Refreshes also become single-flight per connection (a conditional update on
  `token_expires_at`) so concurrent sends and syncs don't race.
- `buildMimeMessage` (`src/lib/gmail-send.ts`) gains `Date`, correct `References` chains, and
  RFC 2047 display names; the recruiter sender benefits too.

## 9. Conversations, follow-ups, contacts, metrics

### 9.1 Replies

A human inbound message sets `needs_attention`, stores sanitized text, and enqueues
`conversation.suggest_reply`, which drafts a `kind: reply` draft (thread + brief + evidence;
untrusted content delimited). The user edits and submits it; submission creates a
single-draft batch through the normal send machinery (exempt from the ceiling, still paced).
Nothing is ever sent without that submission.

### 9.2 Follow-up suggestions (`followups.scan`)

- **Email:** 7 days after the last outbound message with no human reply →
  `follow_up_state = due` → a `kind: follow_up` draft is generated (`suggested`). Approval
  is required to send.
- **LinkedIn:** never while an invitation is pending; no repeated invitations. 7 days after
  acceptance with no human reply → a follow-up *message* suggestion.
- At most 2 suggestions per conversation (`follow_ups_suggested`).
- **Suppressed** by a human reply, an opt-out (AI-classified or user-marked), a bounce, or
  the conversation being closed; `suppressed_reason` records why. Auto-replies do not count
  as replies and do not suppress.
- Opt-outs and bounces also write `outreach_suppressions`, which blocks the person in every
  campaign.

### 9.3 Contacts

On the first human reply (email) or an accepted invitation (LinkedIn), `contacts.link`:
1. uses `prospect.contact_id` if set; else matches `contact_identities` by LinkedIn URL or
   email; else creates a contact through the existing `createContact` duplicate-detection
   path (`source: "outreach"`) from the prospect's stored data;
2. sets `conversation.contact_id` and `prospect.contact_id` conditionally (exactly once);
3. writes the conversation's messages (and every later one) to the contact timeline through
   the ingest spine as `email`/`message` events with external id `outreach:msg:{id}`, so
   re-running never duplicates them.

"Save to contacts" remains available earlier on any person (manual, same path, no Apollo
call — it uses stored research).

### 9.4 Metrics (`metrics.ts`)

| Count | Definition |
|---|---|
| Confirmed sends | attempts in `confirmed`, plus legacy `sent`, shown separately as "legacy" |
| Pending invitations | LinkedIn conversations with `linkedin_invite_state = pending` |
| Accepted connections | `linkedin_invite_state = accepted` |
| Replies | conversations with ≥1 human inbound message |
| Positive replies | `outcome = positive` |
| Follow-ups due | `follow_up_state IN (due, suggested)` |
| Reply rate | replies ÷ (confirmed sends − bounced) |

Legacy "copied"/"opened" rows are "possibly sent (legacy)" and never count as confirmed.

## 10. Orbit Runner (companion extension)

### 10.1 Packaging

- A second build target in `extension/`: `manifest.runner.config.ts` +
  `vite.runner.config.ts`, its own pinned ID (`VITE_RUNNER_EXTENSION_KEY`), its origin added
  to `EXTENSION_ORIGIN` (Clerk `authorizedParties`), and the same production build gates as
  the main extension (live Clerk key, non-localhost app URL, pinned key).
- Shares adapter DOM helpers and URL normalization with the main extension.
- `minimum_chrome_version: "118"`, relying on attached `chrome.debugger` sessions keeping the
  MV3 service worker alive (to be re-verified against Chrome's service-worker lifecycle
  documentation during stage 3; fallback is running the executor loop from the Runner side
  panel, which must then stay open).
- Required permissions: `debugger`, `scripting`, `storage`, `alarms`, `tabGroups`, `cookies`
  (Clerk). Hosts: the app, Clerk, `https://*.linkedin.com/*`, `https://mail.google.com/*`,
  `https://outlook.live.com/*`, `https://outlook.office.com/*`, `https://outlook.office365.com/*`.
  Installing the Runner is the opt-in, so required permissions are acceptable.

### 10.2 Sessions

1. The user presses **Start session** in the Runner panel (or follows the Send page's deep
   link). The panel is signed in through Clerk `syncHost`, like the main extension.
2. `POST /api/outreach/runner/sessions` (Clerk-authenticated) returns a short-lived session
   token (random 32 bytes, stored as `sha256` in `token_hash`, expires after 12 h or on
   stop/expire), bound to the user, the session, and the requested sites. The service worker
   uses only this token; no Clerk token lives in the worker.
3. The Runner opens **one dedicated tab** in an "Orbit Runner" tab group and, per site,
   `identifyAccount()` (LinkedIn global nav profile link; Gmail and Outlook account headers).
   The server compares each with the campaign's pinned browser sender: mismatch → stop
   (`account_mismatch`); first use → the user confirms "Use <account> as this campaign's
   sender".
4. Heartbeat every 30 s from the executor loop, with a `chrome.alarms` wake-up as the
   backstop (alarm periods below 1 minute need Chrome 120+). No heartbeat for 2 minutes → the server
   marks the session `expired`; attempts past `send_clicking` → `needs_verification`, earlier
   ones → `pending`.

### 10.3 Endpoints and auth

All under `/api/outreach/runner/`, implemented with the `extensionRoute` pattern
(zod-validated, body cap, `{ok,data}` envelope, per-install rate budget) and the gate.
`sessions` uses Clerk auth; everything else uses `Authorization: Runner <token>`, resolved to
`(user_id, session_id)` and checked for `status = active` and site scope.

| Endpoint | Purpose |
|---|---|
| `POST sessions` | Create session + token |
| `POST sessions/:id/accounts` | Report identified accounts (and LinkedIn note limit) |
| `POST sessions/:id/heartbeat` | Liveness; returns pause/stop instructions |
| `POST sessions/:id/stop` | Stop with reason |
| `POST claim` | Next allowed action: a browser send attempt or a tracking check |
| `POST attempts/:id/checkpoint` | Report a stage + observations; server validates transition |
| `POST recover` | Screenshot + current-step goal → located element (see §10.5) |
| `POST observations` | Conversation observations from tracking checks |

### 10.4 Loop and adapters

One action at a time: `claim` → the adapter steps through [§6.3](#63-runner-send-attempts),
posting each checkpoint → next claim after the pacing gap. Adapters (`linkedin-runner-1`,
`gmail-web-1`, `outlook-web-1`) implement:

`identifyAccount`, `detectPageState` (`normal | login_challenge | restriction | captcha |
unknown`), `openRecipient`, `openComposer`, `fillContent`, `readBack`, `clickSend`,
`verifyOutcome`, `observeConversations`.

- Selectors are semantic — roles, aria labels, visible button text, URLs — never hashed
  class names.
- Input goes through CDP: `Input.insertText` into the focused composer; clicks via
  `Input.dispatchMouseEvent` at the element's box after `DOM.scrollIntoViewIfNeeded`, with
  `DOM.getNodeForLocation` confirming the node under the point is the intended element.
- The LinkedIn invitation note limit is read from the textarea's `maxlength` and reported;
  the sender account's `linkedin_note_limit` updates and any draft over it is blocked
  ("Your account allows 200 characters").

### 10.5 Constrained visual recovery

When an expected element is missing, the Runner captures `Page.captureScreenshot` and posts
it with the **current step's goal** (e.g. "the Send button in the invitation dialog") to
`/recover`. The server calls `completeMultimodalJson` (user's key, `speed: "vision"`,
`operation: "outreach.runner.recover"`) and returns `{ found, box, label, confidence }`.
The Runner clicks only if confidence ≥ 0.8 and the node at that point is a button whose
accessible name fits the goal. Recovery can only *locate an element for the current step*;
it cannot choose actions, recipients, or content. Otherwise → stop with `uncertain_state`.
Screenshots are never persisted.

### 10.6 Stop conditions (never worked around)

Account mismatch; login challenge or CAPTCHA; LinkedIn restriction or weekly-limit notice;
an unexpected dialog; uncertain page state; the user pressing Cancel on Chrome's
"is debugging this browser" bar (debugger detach); heartbeat loss. Closing or navigating
away from the dedicated tab **pauses** the session. Pause before `send_clicking` returns the
attempt to `pending`; after it, verification finishes first. Pause/Resume are in the Runner
panel and on the Send page (server-side session status, delivered on heartbeat).

### 10.7 Browser-only tracking

On session start and every 10 minutes while active, the Runner performs a tracking check:
LinkedIn Sent invitations (still pending vs. gone), the recipient's relationship (1st degree
→ accepted; `invite_accepted_at` observed), and message threads with accepted connections.
Identity matching is `exact` on profile URL, `probable` on name + headline, otherwise
`ambiguous` and queued for the user's review. Without a session, the workspace shows
"LinkedIn tracking last checked 3 days ago · Start a Runner session to refresh."

### 10.8 Risk notice

Shown on the Runner's first session and whenever a LinkedIn campaign is created: LinkedIn
prohibits third-party automated activity
([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin?lang=en)),
and using the Runner may put the account at risk. Requires acknowledgment
(`linkedin_risk_acknowledged_at`). No stealth measures: no fingerprint changes, no simulated
human mouse paths; pacing exists for courtesy and limits.

## 11. UI

Orbit's existing visual system throughout — Fraunces/Outfit, teal + gold (light) / blue
(dark), liquid-glass cards, existing Card/Badge/Sheet/Dialog components, `CardTitle as=`
headings — and the existing card-reflow pattern for tables on phones.

- **`/outreach`** — "Needs attention" strip (replies across campaigns) first; campaign cards
  with channel, sender, and live counts; legacy campaigns labelled "Earlier campaign"
  (read-only until cutover).
- **Describe** — purpose, desired outcome, Email/LinkedIn toggle, sender picker (with
  "Connect Outlook" / "Install Runner" prompts), sender introduction pre-filled from the
  default with "Save as default", signature preview.
- **Audience** — Required / Preferred / Exclude chip groups, each chip tagged by kind;
  preferences reorderable; "Confirm audience".
- **People** — funding card + research budget stepper + Start; progress header ("Searching…
  38 found · 14 researched · 11 credits"); ranked rows (name, headline, company, tier,
  confidence, contact methods with email-status icon, LinkedIn link, flags: In your
  contacts / Contacted in "X" / Possible duplicate / Opted out); expand → per-criterion
  verdicts (✓ ~ ? ✗ ⚠) with source links; "Filtered out (12)"; the selection banner.
- **Review** — split view: selected people with state (Needs review / Approved / Blocked:
  reason) beside an evidence panel and the editor. Email shows From (read-only here, with a
  change link), To + status, Subject, Body, Signature (read-only here). LinkedIn shows a live
  counter ("187 / 200"), amber from 90%, blocking past the limit. Shortcuts: `J`/`K` move,
  `A` approve, `E` edit, `R` regenerate (optional instruction). Batch bar: instruction for
  unapproved drafts (a job with progress; a confirmation if it would clear approvals) and
  "Approve 18 that pass checks · 3 need attention". Unverified addresses need
  acknowledgment.
- **Send** — account and method, recipient count, ceiling math ("50 today, 20 tomorrow"),
  every message exactly as it will be sent, unverified-address warnings, Start sending →
  live progress (sent / waiting for allowance / failed with the fix / needs verification)
  with Pause, Resume, Cancel.
- **Workspace** — counts header ([§9.4](#94-metrics-metricsts)); sync line ("Gmail synced
  3 min ago · Refresh", or the Runner staleness notice); tabs:
  - **People:** each person's stage.
  - **Drafts:** follow-up suggestions, reply drafts, unsent drafts.
  - **Conversations:** needs-attention first; thread view with sanitized incoming text,
    an editable suggested reply that is sent only on submit, the outcome picker (AI
    suggestion, user override), Close, Save to contacts.
  - **Activity:** runs, sends, syncs, Runner sessions, credit use.
- **Settings → Integrations → Outreach** — sender accounts (signature, default intro,
  reconnect state, last sync), personal Brave and Apollo keys with live verification, credit
  balance and history, Runner install and session status.
- **Accessibility** — every action keyboard-reachable with visible focus; progress counts in
  a polite `aria-live` region; the LinkedIn counter announces crossing 90% and 100%.

## 12. Security and privacy

- **Tenancy:** [§4.5](#45-invariants); `smoke-outreach-tenancy` calls every action and
  endpoint with another user's ids.
- **Prompt-injection hygiene:** evidence, incoming mail, and page text are wrapped in
  labelled delimiters with an instruction that their contents are data; AI outputs are
  Zod-validated; no AI output can set a recipient, sender, or approved content —
  those come only from stored, user-approved rows.
- **Incoming mail** is stored as sanitized plain text (HTML stripped, ≤20,000 chars) and
  rendered as text; remote content is never loaded.
- **Secrets:** Brave key encrypted with `src/lib/crypto.ts`; Runner tokens stored hashed;
  both in `NEVER_REVEALABLE`. No message bodies in `error_events` or logs.
- **Minimization:** only tracked-thread messages are stored; screenshots are never persisted.
- **Purge:** every new table is removed by `purgeUserData`; new per-user settings are
  reviewed against its preserved-column list.

## 13. Testing

Smoke scripts (`tsx`, registered in `scripts/run-smoke.ts` `MANIFEST`; `pure` for logic,
`pglite` for anything touching the DB; each `pglite`/`manual` script imports
`./smoke/_env` first). Fakes at every seam: `FakeSearchProvider` / `FakeEnrichmentProvider`
(429, 5xx, timeouts, partial results), `FakeMailbox` for Gmail and Outlook (drafts, Sent,
history ids, delta tokens with 404/410 expiry, duplicate events, bounces, auto-replies,
external replies), a deterministic fake AI completer, and for the Runner a `FakeCdpDriver`
with linkedom HTML fixtures (LinkedIn profile: Connect, Pending, 1st degree, login wall,
restriction notice, invite modal with `maxlength` 200 and 300; Gmail and Outlook compose).

| Script | Covers |
|---|---|
| `smoke-outreach-ranking` | relevant ordering on fixtures, conflicting evidence, missing vs. mismatch, rerank on criteria change |
| `smoke-outreach-identity` | duplicate identities, LinkedIn URL normalization, ambiguous names, previous-outreach and contact flags |
| `smoke-outreach-credits` | reserve/charge/release, exhaustion, Pro rollover, Lifetime once, holds across rollover, personal key never falls back |
| `smoke-outreach-discovery` | partial provider failures, query and research budgets, partial runs keep results, no invented emails, demo only in demo |
| `smoke-outreach-drafts` | exact previews, signatures, LinkedIn limits (200 default, observed 300), approval invalidation on every hash input |
| `smoke-outreach-selection` | page vs. all-matching selection, `exceptIds`, contacted people untouched |
| `smoke-outreach-jobs` | claim, lease expiry, fencing of stale workers, idempotency keys, gate pauses |
| `smoke-outreach-send-queue` | double clicks, competing claims, interrupted sends (both providers), cancellation, verify-before-retry, ceiling queueing, pacing, reply exemption |
| `smoke-outreach-mail-sync` | Gmail/Outlook threading, expired auth, expired cursors, duplicate events, auto-replies, bounces, replies outside Orbit |
| `smoke-outreach-runner` | checkpoint legality, account change, login challenge, pending invitation, already connected, browser closure, session expiry, stale tracking, recovery constraints |
| `smoke-outreach-conversations` | contact created exactly once, history not duplicated, follow-up rules and suppression, outcome override, metrics |
| `smoke-outreach-tenancy` | every action and endpoint rejects another user's ids |
| `smoke-outreach-legacy-migration` | mapping table, idempotent re-run, SMS readable, historical campaigns intact |

PGlite runs a single writer, so race tests there check interleavings; a `manual`-tier
`smoke-outreach-races` runs genuinely concurrent claims and credit reservations against a
disposable Neon branch (`SMOKE_ALLOW_REMOTE=1`). UI checks (keyboard-only review, responsive
layouts at phone/tablet/desktop) run in headless Chrome over CDP — an occluded preview pane
starves `requestAnimationFrame` and passes vacuously, so it does not count.

**Live acceptance** uses designated test accounts: a test Gmail, a test Outlook (personal;
a work tenant if available), and a test LinkedIn account.

## 14. Legacy migration

`scripts/migrate-outreach-legacy.ts` — `--dry-run` prints a report; idempotent on legacy row
ids (`legacy_message_id` unique on drafts and messages); explicit `process.exit(0)`; run with
the worktree's dev server stopped (PGlite single-writer).

| Legacy | Becomes |
|---|---|
| campaign | `generation = 2`; `audience_query` kept in `brief.notes`; `audience_filters` converted to criteria where possible; no sender pinned until the user picks one |
| prospect | kept; `user_id` backfilled; identities from `linkedin_url` / `email` / `external_id`; `contacted`/`replied`/`interested`/`not_interested` → `selected` + conversation state |
| message `draft` / `generated` | unapproved draft (`created_by: legacy`), "Needs review under your new sender" |
| message `sent` (Resend/Twilio) | conversation (`provider: resend|twilio`) + outbound message "sent · legacy" |
| message `copied` / `opened` | outbound message marked "possibly sent (legacy)", never counted as confirmed |
| `outcome` + `replied_at` | conversation `outcome`, `outcome_source: user`, a `system` message "Reply logged manually" |
| message `scheduled` | follow-up suggestion (`follow_up_due_at = scheduled_for`); nothing generated |
| `failed` / `skipped` | `system` history messages |
| SMS | read-only conversations; no new SMS |

Rehearsed on a Neon branch of production before cutover.

## 15. Rollout, stages, and acceptance

Each stage is one implementation plan and one PR, merged to `main` behind the gate only
when its smoke scripts pass and its live acceptance check passes on the admin account.

1. **Foundation + discovery** — schema (all tables, so later stages add behaviour, not
   migrations), jobs + worker, gate, config, criteria, Brave + Apollo adapters, identity,
   ranking, research, credits, personal keys; Describe → Audience → People → Select UI.
   *Acceptance:* a real Brave/Apollo run returns ranked, evidenced people; the ledger
   balances; editing a criterion reranks without provider calls.
2. **Drafts + connected email** — sender accounts, signatures, drafts/versions/approvals,
   Review, Outlook mail scopes, Gmail/Outlook transports, send batches/attempts, ceiling,
   Send screen, token-refresh fix. *Acceptance:* test sends to own inboxes via both
   providers; correct threading; ceiling queueing; a forced crash in `submitting` resolves
   correctly on each provider.
3. **Runner** — second extension target, sessions and tokens, endpoints, LinkedIn / Gmail web /
   Outlook web adapters, checkpoints, recovery, tracking checks, risk notice.
   *Acceptance:* an invitation to the test LinkedIn account; killing Chrome after the click →
   `needs_verification` → reconciled; account-mismatch and login-wall stops.
4. **Conversations + dashboard** — mail sync, classification, reply suggestions and sending,
   follow-up suggestions and suppression, contact linking, workspace tabs and metrics, legacy
   migration. *Acceptance:* real replies, bounces, and auto-replies classified correctly;
   follow-ups suggested and suppressed; contacts linked once; migration rehearsed.
5. **Cutover** — run the migration, set `OUTREACH_NEXT=on`, monitor; a follow-up PR deletes the
   legacy UI and the Resend/Twilio outreach send paths (legacy tables stay as history).

## 16. Prerequisites (owner: Jason)

- Azure app registration: add delegated `Mail.ReadWrite` and `Mail.Send`.
- Brave Search API key → `BRAVE_SEARCH_API_KEY` in Vercel (Production + Preview).
- Designated test Gmail, Outlook, and LinkedIn accounts.
- A Chrome Web Store listing for Orbit Runner (with the `debugger` justification).

## 17. Risks and verify-during-implementation

- **MV3 worker lifetime under `chrome.debugger`** (§10.1) — verify; fallback to a side-panel
  executor.
- **Clerk in the Runner** — the Runner panel uses `syncHost` like the main extension; confirm
  a second extension origin works in `authorizedParties`.
- **Gmail search lag** for crash recovery — the 2-minute grace is an estimate; tune from the
  forced-crash acceptance test.
- **Graph `createReply` + `PATCH` body** — confirm the patched body fully replaces the quoted
  original and that the immutable id survives send.
- **LinkedIn markup drift** — adapters are fixture-tested but will break on redesigns;
  `detectPageState = unknown` stops safely, and adapter versions are logged with every
  checkpoint.
- **Brave result parsing** — LinkedIn SERP title formats vary by locale; unparseable results
  are counted in run stats so drift is visible.
- **Scheduler lag** — replies arriving while Orbit is closed surface within ~35 minutes; the
  sync line always shows the true last sync.
