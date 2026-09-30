# Radar — proactive recommendation engine

**Date:** 2026-09-27
**Status:** Design for review. Implementation plan: `docs/superpowers/plans/2026-09-27-radar-recommendation-engine.md`.
**Branch:** `claude/inspiring-fermi-npcgb7`, cut from `main` at `f36306a` (schema 120).

## Where this came from

The product spec (`docs/orbit_networking_tracker_spec.md` §7.7 "Automatic Suggestions", §11.8
`ai_suggestions`, §18 "Ranking Logic") has always promised proactive recommendations: *"You have
not spoken to Maya in 45 days, and she previously offered to introduce you to someone."* Jason
asked for a new page that does that thinking ahead of time — analyse the whole network, watch what
is happening around it (job changes, company news, posts), and hand the user a short ranked list of
people to reach out to, follow up with, or re-connect with, each with a reason and a one-click
action. The goal is fewer decisions for the human, not more data on a screen.

Four product decisions were settled with Jason before this design was written:

| # | Decision | Alternatives declined |
|---|---|---|
| 1 | **News** comes from public bulk feeds pulled whole and matched locally. | A web-search API on the user's key (per-company queries leave the server); no news in v1. |
| 2 | **Social** signal is extension-captured LinkedIn activity (user-initiated) plus public Bluesky/Mastodon posts for contacts with handles. | X/Twitter via a BYOK developer key; LinkedIn only; no social in v1. |
| 3 | **Autonomy** is recommend + one-click by default, with a per-kind "autopilot" opt-in that auto-creates the reminder and pre-writes the draft. Sending always needs a click. | One-click only; autopilot on by default. |
| 4 | **Delivery** is a weekly Monday email digest plus the in-app bell plus the page. | Daily digest; bell and page only. |

## Problem

Orbit knows a great deal about each relationship and does nothing with it until the user asks.
Three heuristics (`dormant_high_value`, `post_event`, `linkedin_thread_quiet` in
`src/lib/reminders.ts`) run only when the dashboard is opened; `job_posting_signal`
(`src/lib/jobs/matcher.ts`) is the sole signal from outside the network; nothing notices a job
change, a funding round, a layoff, a post, or an upcoming meeting. The "why" behind a suggestion is
one hard-coded sentence, there is no notion of urgency, no learning from what the user dismisses,
and no way to hear about any of it without opening Orbit.

## Goals

1. **A ranked, explainable daily list.** Open `/radar` and see at most five things to do today,
   then soon, each with reasons a person can read and act on in one click.
2. **Proactive.** Computed nightly, delivered to the bell and a weekly email, kept fresh without
   the user asking.
3. **Aware of the world.** Job changes, company news, and public posts about the people in the
   network become dated signals that raise (or create) recommendations.
4. **Reduces work.** One click schedules, drafts, snoozes or dismisses. Autopilot, per kind and
   opt-in, does the scheduling and drafting itself and leaves only the send.
5. **Learns from the user.** Dismissals and "not for this person" suppress; accepts reinforce;
   weights nudge within bounds.
6. **Safe by construction.** Deterministic ranking, AI for prose only, fenced third-party text, no
   sends without a click, nothing about the user leaves the server.

## Non-goals (v1)

- No web-search or per-company news API. No X/Twitter. No server-side LinkedIn fetching of any
  kind (`docs/superpowers/specs/2026-09-19-integrations-strategy-design.md`, "Explicitly out").
- No auto-sending, ever. Autopilot stops at a ready draft.
- No model-driven ranking. An LLM never chooses or orders recommendations — the
  `src/lib/events/relevance.ts` principle: a ranking that reshuffles between loads is one the user
  stops trusting.
- No new entitlement or paywall. Radar ships to every plan; the seam for a future `radar` feature
  key in `src/lib/entitlements.ts` is noted, not built.
- No push notifications (no Web Push infrastructure exists).
- No replacement of Reminders. Radar proposes; accepted items become ordinary reminders and
  follow-ups through the existing writers.

## Constraints inherited from the codebase

- The user's company list never leaves the server (header of `src/lib/jobs/feed-fetch.ts`).
  Feeds are fetched whole; matching happens locally.
- AI containment is in code, not prompts (`docs/ai-security-audit-2026-09-26.md`):
  `fenceUntrusted`, zod plus length clamps, `guardModelOutput`, `safeHttpUrl`; models propose and
  humans confirm. Third-party text is never written into `contacts.notes`,
  `interactions.raw_notes` or `contacts.ai_summary`.
- Unconfirmed guesses never fire OS notifications: the bell maps suggestions at `urgency: "info"`
  (`src/lib/notification-panel.ts`).
- The only scheduler is `.github/workflows/ops.yml`, hitting `CRON_SECRET`-gated routes
  (`isInternalRequest`); every step is gated on an explicit cron line. Batch routes run at
  `maxDuration = 300` with `time-budget.ts` deadlines and self-continue via `internalFetch`;
  `after()` never extends `maxDuration`.
- Performance (`docs/performance.md`): never select `notes` or `profile_image_url` in a scan, no
  per-item statements, `<RenderStamp />` on every page, FK-leading indexes, external calls never on
  a write path, statement budgets pinned in `scripts/smoke-page-budgets.ts`.
- Schema: hand-written DDL in `src/db/index.ts`, Drizzle defs in `src/db/schema.ts`, one
  `SCHEMA_VERSION` bump per change set (main is 120; re-check `origin/main` and open branches at PR
  time). Neon HTTP has no transactions: `runAtomicWrite` and single-statement claims.
- All AI is BYOK (`MANAGED_AI_ENABLED = false`). Radar is fully useful with no AI key: ranking and
  reasons are deterministic; only the one-line "why" and drafts need a key.

## Principles

- **Score, then explain.** A pure `scoreContactKinds()` (modeled on `scoreAttendee`) produces
  per-kind scores and `reasons[{code, label, points}]`. Same inputs, same order, every run. AI
  writes one sentence about an already-chosen row (`src/lib/events/explain.ts` pattern), cached
  by an inputs hash.
- **One recommendation per person.** Signals fan in; the best kind wins; the losing kinds' top
  reason becomes a secondary chip on the same card.
- **External facts are rows; internal facts are read live.** Job changes, news items, posts and
  extension-noted activity are `contact_signals` rows (dated, sourced, dedupe-hashed, sanitized).
  Dormancy, open loops, opportunities, meetings and events already live in their own tables and are
  read in a handful of batched queries; the recommendation row carries the evidence it used.
- **Third-party text is quarantined.** Feed and post text lives only in `external_items` and
  `contact_signals.payload` (sanitized, capped), is rendered with a source label, is fenced when it
  reaches a model, and never touches notes, summaries or embeddings.
- **The user's intent wins.** `constellationPin = "out"`, an existing `nextFollowUpAt` (for
  reach_out and reconnect), a snooze, a dismissal, or "never for this person" all suppress, in
  that order of permanence.

## Design

### Recommendation kinds (priority order for tiebreaks)

| Kind | Meaning | Primary triggers |
|---|---|---|
| `prep` | You are about to see them | calendar `meeting` interaction within 7 days; upcoming event they attend |
| `heads_up` | Something happened around them | `job_change`, `company_news`, `social_post`, `linkedin_activity` |
| `follow_up` | You owe them something | open `action_items`, `contact_opportunities` due ≤ 7 d or overdue, `contact_briefs.next_step` |
| `opportunity` | Acting now advances a goal | pending `job_posting_signal` (read from `ai_suggestions`), target-company match, goal fit |
| `reach_out` | They are waiting on you, or the moment is fresh | inbound LinkedIn message unanswered ≥ 5 d; intro 7–21 d ago with one touch; event ended 1–14 d ago with no follow-up; quiet LinkedIn thread 14–90 d |
| `reconnect` | The relationship is slipping relative to how you said it should run | idle ≥ `cadenceDays` (default 30) with high `priorityLevel`, `statedCloseness` or tier |

### Scoring model

Every number below is a starting value, exported as a named constant in `RADAR_WEIGHTS` and tuned
against the pure harness (`scripts/smoke-radar-score.ts`), which asserts orderings rather than
literals. Score per kind = clamp(0, 100, Σ reason points). Points are hidden in the UI; labels are
shown.

| Signal → reason | Kind | Points | Decay half-life |
|---|---|---|---|
| `upcoming_meeting` (≤ 7 d) | prep | 40, +8 if ≤ 48 h | none |
| `event_upcoming` (≤ 7 d) | prep | 24 | none |
| `job_change` (company) | heads_up | 32; title-only 18 | 10 d |
| `company_news` | heads_up | 20, +6 for an EDGAR filing or funding/acquisition/IPO keywords | 5 d |
| `linkedin_activity` (opt-in) | heads_up | 14 | 7 d |
| `social_post` | heads_up | 12 | 4 d |
| `opportunity_due` | follow_up | 26 (≤ 7 d), 30 (overdue) | none |
| `action_item_open` | follow_up | 20, +6 if > 14 d old | none |
| `brief_next_step` | follow_up | 10 | none |
| `existing_suggestion:job_posting_signal` | opportunity | 28 | 21 d from posting |
| `inbound_unanswered` (≥ 5 d) | reach_out | 34 | none |
| `recent_intro` (7–21 d, single touch) | reach_out | 30 | none |
| `post_event` (ended 1–14 d ago) | reach_out | 26 | none |
| `linkedin_thread_quiet` (14–90 d, cadence-aware) | reach_out | 22 | none |
| `dormant` | reconnect | 18 + min(14, round(7 · (idle / window − 1))), window = `cadenceDays ?? 30`; the label quotes `cadencePhrase` | none |

Context adjustments (every kind for that contact unless noted): closeness tier inner / mid / outer
+8 / +4 / 0; `priorityLevel` ≥ 3 / = 2 → +8 / +4; `statedCloseness` ≥ 4 → +4; target company
priority 1 / 2 / 3 → +14 / +10 / +5 (`loadTargetKeys` and `company-match.ts` keys); goal fit →
round(10 · `goalRelevanceComponent`) over company, title and industry only (never notes); touched
within 7 days → −25 on reach_out, reconnect and follow_up; dismissed same (contact, kind) within
30 days → −30; per-kind feedback multiplier (P2) in [0.85, 1.15].

Exclusions (the kind is never produced): `constellationPin = "out"` (all kinds); `nextFollowUpAt`
set (reach_out and reconnect only — the Reminders surface owns them); `never` feedback for the kind
or for the contact; three or more dismissals in 90 days; outer tier with `priorityLevel < 2` for
reconnect.

Decay is `round(points · 0.5^(ageDays / halfLife))`; a decayed reason below 4 points is dropped.
The same fact from two producers (a transient `dormant` and a legacy `dormant_high_value` row
during the P0 overlap) collapses to one reason.

**Buckets:** `today` ≥ 50, `soon` ≥ 32, `later` ≥ 18, otherwise not stored.
**Caps:** `PENDING_CAP` 12 per user after a `PER_KIND_CAP` of 4; the Today section shows
`TODAY_CAP` 5; `NEWS_PER_RUN_CAP` 3 new news signals per run.
**Expiry:** reach_out / reconnect / follow_up = run + 7 d (re-upserted while still true);
heads_up = occurred + 14 d; prep = start + 1 d; opportunity = posting + 21 d. Expired rows keep
`status = 'expired'` for 90 days (feedback history) and are then pruned. Snoozed rows wake when
`snoozed_until` passes and the fact still holds.
**Stability:** `inputs_hash = sha256(kind, reason codes and points, evidence ids)` keeps the AI
note cached across unchanged runs, and the harness asserts that the same input scores identically
twice.

### Signals

**Internal — read live, at most eight statements per user.** A narrow candidate scan (≤ 1,500
contacts: inner or mid tier, or priority ≥ 2, or relationship ≥ 4, or a follow-up set, or first
touch ≤ 21 days; never `notes` or `profile_image_url`); LinkedIn message aggregates with last
inbound and outbound dates (`countsAsTouch`); future `meeting` interactions ≤ 7 days (calendar
sync writes up to 60 days ahead); `event_attendees` for events from 14 days ago to 7 days ahead;
open `action_items`; open `contact_opportunities` due ≤ 7 days; `contact_briefs.next_step`;
pending `ai_suggestions` of every type as `existing_suggestion` (the bridge during the overlap;
`score_bump` is ignored as an outreach reason).

**External — `contact_signals` rows.**

- **`company_news`.** The hourly sweep is *ingest-only*: whole public feeds land in the global
  tables `external_sources`, `external_items` and `external_item_companies(company_key,
  published_at)`. The *nightly per-user run* probes that last table with the user's
  `jobCompanyBucketKey`s in one indexed statement, confirms each hit with `companiesMatch`,
  optionally asks the decision model "does this headline concern this company?" (rules fallback,
  never autonomous), and inserts signals with a `(user, contact, item)` dedupe hash. This is the
  inverse of `src/lib/jobs/matcher.ts` on purpose: its header explains that no global company
  probe on `contacts` exists, and this way costs O(user's companies) per user with no outbound
  request. Starting sources, each an `external_sources` row so adding or disabling one is data:
  Hacker News via the Algolia public API (`search_by_date?tags=story`, newest page only; no query
  names our companies); SEC EDGAR current-filings Atom for 8-K and S-1 (EDGAR's fair-access policy
  requires a User-Agent carrying a contact address, so this source reads `SEC_EDGAR_CONTACT_EMAIL`
  and is skipped when unset); a curated set of tech and business RSS/Atom feeds (TechCrunch, The
  Verge, Ars Technica) parsed with `fast-xml-parser`. **GDELT ships `enabled: false`:** a
  15-minute GKG zip is tens of megabytes, above the 24 MB job-feed precedent, and it is sized on the
  ops box before it is turned on. Plainly: v1 news coverage is HN + EDGAR + RSS.
- **`job_change`.** One helper, `recordJobChangeSignals(userId, contactId, changes, source)`,
  called from every place a title or company can change: `updateContactForUser` (a manual edit),
  `refreshContactsFromLinkedIn` (an Apollo refresh the user asked for), and
  `resolveContactFromPage`, where the extension's `diffPageAgainstContact` already computes
  `FieldChange[]` server-side — no contract change, and page text is still never persisted because
  the stored strings are the same title and company already returned to the panel. Plus a periodic
  **Apollo re-check on the user's own key only** (never the hosted key): at most 10 inner/mid
  contacts with a `linkedinUrl` per nightly run, rotating by a keyset cursor with 30-day spacing.
  It diffs title and company and writes signals; it **never overwrites the contact** — the card's
  "Update record" is the human click.
- **`social_post` (P2).** A daily poll of public Bluesky
  (`public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`) and Mastodon
  (`/api/v1/accounts/lookup` then `/statuses`) for contacts with `bluesky_handle` or
  `mastodon_acct` identities (two new `IDENTITY_KINDS`, entered by the user on the contact page),
  through `guardedFetchText`, at most 10 handles per user per run with per-host politeness
  buckets, excerpt ≤ 280 characters sanitized, post URL through `safeHttpUrl`. Privacy posture,
  stated plainly: these are per-handle requests to a third party, unlike bulk news. The request
  carries only a public handle the user chose to add, never the list.
- **`linkedin_activity` (P2).** An additive extension route (`POST /api/extension/signals`; the v1
  contract stays valid) stores a 280-character excerpt and a "seen on" date when the user clicks
  "Save as Radar activity" on a post by a known contact. The server refuses unless
  `user_settings.radar_capture_linkedin_activity` is on.

### The page: `/radar`

- **Header.** "Radar"; run stamp ("Updated 6h ago · next tonight"); **Refresh now**, rate-limited
  to 3 per 10 minutes, which runs the per-user pass inline within a 20 s budget under the layout's
  60 s ceiling; a settings gear.
- **Today.** Up to five cards. Anatomy: avatar (`clientAvatarUrlSql`), name as an `IntentLink` to
  the contact, title · company, closeness dot (`ClosenessTierBadge dotOnly`), kind chip, reason
  chips (labels only), evidence line ("TechCrunch · 2d ago · 'Acme raises $40M'", the external link
  rendered only through `safeHttpUrl` with the domain visible), the AI why-line or "Add an AI key
  for a one-line why", and actions: **Schedule** 3 / 7 / 14 days (`scheduleContactFollowUpForUser`),
  **Draft** (opens `FollowUpDraftSheet`, preloaded on hover), **Snooze** 1 week / 1 month,
  **Dismiss** with Undo, and an overflow with "Not for this person", "Update record" (job change)
  and "Open contact".
- **Soon / Later.** Collapsed per-kind sections, same cards, denser.
- **Network health strip.** `getNetworkStats` items plus "signals this week" and "autopilot did N
  things".
- **Settings panel.** Pause Radar; autopilot per kind (stored in P0, honoured in P2); weekly digest
  toggle; extension activity capture opt-in (P2).
- **Empty states.** No contacts → onboarding. Contacts but no run yet → a first inline build (15 s
  budget, no AI), exactly the `ensureOutreachSuggestions` shape. Everything handled → "All clear".
- **Dashboard (overlap mode in P0).** Once Radar has run for this viewer, the "Suggested outreach"
  card renders a "Radar" preview (top five, "Open Radar →"); otherwise the legacy card. The legacy
  `buildOutreachSuggestions` keeps running through P0 — four smoke scripts and the dashboard
  statement budget pin it — and is retired in P1 after a week of real runs.
- **Bell.** Radar top items at `urgency: "info"`, url `/contacts/{id}` (never an external URL);
  legacy suggestion items for the same contact are dropped during the overlap.
- **Chat.** `getAttentionBrief.suggestions` unions Radar rows (reason labels joined), deduped by
  contact, so "who should I reconnect with?" answers from the same list the page shows.

### Delivery: the weekly digest

An hourly-on-Mondays cron (`13 * * * 1`) selects users whose *local* Monday is between 06:00 and
09:00 — the timezone is captured from the existing `orbit-tz` cookie into `radar_digest_tz`
whenever they open Radar or Settings, UTC otherwise — who have `radar_digest_enabled`, were active
in the last 30 days, and hold at least one `today` or `soon` recommendation. A single-statement
week claim (`SET radar_digest_last_week = $isoWeek … RETURNING`) makes overlapping runs unable to
double-send. One email via the lazily imported Resend client (pattern `src/lib/broadcasts.ts`):
the top five with reasons, deep links to `/radar?focus=<id>`, `List-Unsubscribe` headers, a
one-click unsubscribe route with a hashed token (pattern `/api/interest-list/unsubscribe`), and
the palette and `escapeHtml` helpers from `src/lib/interest-list-email.ts`. No third-party URL
appears in the body. Default on, with the toggle in Radar settings and Settings → Notifications
(open question 1).

### Data model

New user-scoped tables, all with `user_id text not null` and FK-leading `(contact_id)` indexes in
`SCALE_DDL`:

- **`recommendations`** — `id`, `user_id`, `contact_id` (cascade), `kind`, `score int`,
  `bucket`, `reasons jsonb`, `evidence jsonb` (sanitized labels, sources, dates, signal ids),
  `status` (pending | snoozed | accepted | dismissed | expired | auto_applied), `snoozed_until`,
  `expires_at not null`, `run_id`, `inputs_hash not null`, `ai_note jsonb`, `draft jsonb` (P2),
  `actions jsonb` (an audit of one-click actions), `created_at`, `updated_at`, `resolved_at`.
  Unique `(user_id, contact_id, kind) WHERE status IN ('pending', 'snoozed', 'auto_applied')`;
  `(user_id, status, score DESC)`; `(expires_at) WHERE status = 'pending'`.
- **`contact_signals`** — `id`, `user_id`, `contact_id` (cascade), `kind` (job_change |
  company_news | social_post | linkedin_activity), `occurred_at`, `source`, `external_item_id`
  (no FK; items are pruned), `payload jsonb` (sanitized), `dedupe_hash`, `created_at`. Unique
  `(user_id, dedupe_hash)`; `(user_id, occurred_at DESC)`.
- **`radar_runs`** — `id`, `user_id`, `trigger` (schedule | page | manual | first_visit),
  `status` (running | ok | partial | failed), `started_at`, `finished_at`, `duration_ms`,
  `stats jsonb`, `error`.
- **`recommendation_feedback`** — `id`, `user_id`, `contact_id` (cascade), `recommendation_id`,
  `kind` (null = every kind), `action` (accepted | dismissed | snoozed | never), `reason` (≤ 200),
  `created_at`.
- **`user_settings` columns** — P0: `radar_next_at`, `radar_lease_until`, `radar_last_run_at`,
  `radar_paused boolean default false`, `radar_autopilot jsonb default '{}'`,
  `radar_capture_linkedin_activity boolean default false`. P1: `radar_digest_enabled boolean
  default true`, `radar_digest_tz`, `radar_digest_last_week`, `radar_digest_unsub_token_hash`,
  `radar_apollo_cursor`. Partial index `(radar_next_at) WHERE radar_paused = false`.

Global tables (P1; no `user_id`; documented beside `job_postings` in `src/lib/user-data.ts`):
**`external_sources`** (`id text pk`, label, url, kind rss | atom | hn | edgar | gdelt, enabled,
etag, last_modified, last_fetched_at, last_status, last_error, consecutive_failures);
**`external_items`** (source_id FK cascade, external_id, title ≤ 200, summary ≤ 300, url,
published_at, first_seen_at; unique `(source_id, external_id)`); **`external_item_companies`**
(item_id FK cascade, `company_key` = `jobCompanyBucketKey`, company_name ≤ 120, published_at;
primary key `(item_id, company_key)`; index `(company_key, published_at DESC)`).

Lifecycle: the `insights` category in `src/lib/user-data.ts` exports, counts and deletes the four
user tables and nulls the `user_settings` radar columns; `src/lib/contact-merge.ts` repoints
`contact_signals` and `recommendation_feedback` (collision-guarded like `contact_profiles`) and
deletes-and-archives the loser's live `recommendations` (the next run regenerates them);
`scripts/smoke-purge.ts` seeds each table; `smoke-data-export` asserts the export. The
`IDENTITY_KINDS` extension in P2 happens only after verifying that the identity sync in
`contact-writes.ts` does not wipe kinds it does not derive; otherwise the handles become two
`contacts` columns.

### Jobs

| Job | Route | `ops.yml` line | Ledger (`CronJobName`) | Budget |
|---|---|---|---|---|
| Nightly per-user run | `POST /api/radar/run` | `"17 4 * * *"` (+ self-continue) | `radar.run` | 300 s route; 270 s pass; 25 users per claim; concurrency 4; 30 s per user |
| External feed sweep (ingest-only) | `POST /api/radar/feeds/sweep` | `"37 * * * *"` | `radar.feeds` | 300 s; 210 s shared deadline |
| Weekly digest | `POST /api/radar/digest` | `"13 * * * 1"` | `radar.digest` | 60 s |

Each job: `isInternalRequest` before any write; `startCronRun` / `finishCronRun`; an entry in
`PUBLIC_ROUTES` and in `scripts/smoke-public-routes.ts`; an `ops-sweep.ts` snapshot entry;
`ops-alerts.ts` missed/failed conditions (`radar.schedule_missed` at 30 h,
`radarfeeds.schedule_missed` at 6 h; the digest relies on `cron_runs` stats); a seed row in
`scripts/smoke-ops-sweep.ts`.

**The per-user run.** Claim with a single statement (`UPDATE user_settings … WHERE radar_paused
= false AND (radar_next_at IS NULL OR radar_next_at <= now()) AND the lease is free AND
last_active_at > now() − 60 days ORDER BY radar_next_at NULLS FIRST LIMIT 25 RETURNING`) →
`radar_runs` row → candidates → internal signals → existing-suggestion bridge → news probe (P1)
→ Apollo re-check (P1, own key, deadline-checked) → social poll (P2) → score in JS → per-kind cap
→ top 12 → one `runAtomicWrite` (expire rows no longer produced; upsert on the live unique index,
keeping snooze state and keeping `ai_note` when `inputs_hash` is unchanged; wake expired snoozes)
→ AI why-lines for `today` only when `userCanUseAi` (≤ 5 fast-tier calls under a shared timeout;
`skippedNoKey` otherwise) → autopilot (P2) → finish (`radar_next_at = now + 24 h`, or + 6 h after
a failure; lease cleared). Page-open stale-while-revalidate: when the last run is older than 24 h
and the lease is free, `after(() => runRadarForUser(userId, {ai: false, budgetMs: 20_000}))`. A
first visit runs inline with a 15 s budget and no AI.

### Security and privacy

- Every external fetch goes through `guardedFetchText` (SSRF guard, size caps, content-type
  allowlist, conditional GET, the `OrbitBot` User-Agent, which gains a `userAgent` option for
  EDGAR). No query string carries user data. Social polling is per-handle and opt-in by virtue of
  the user adding the handle.
- Every external string is sanitized on ingest (`cleanSingleLine`, caps, `safeHttpUrl` or
  dropped); `detectInjectionSignals` records an `ai.security` event with ids only, never text.
  Third-party text never reaches notes, summaries or embeddings.
- The `radar.why` prompt sees the cleaned name, title and company, the kind label, the reason
  labels, and evidence labels with any third-party text inside `fenceUntrusted("EVIDENCE", …)`. No
  notes, no mail. Output is zod-clamped (why ≤ 200, opener ≤ 300), passed through
  `guardModelOutput`, and stored on the row.
- Drafts reuse `generateContactFollowUpDraft` unchanged. Autopilot writes only through
  `scheduleContactFollowUpForUser`; it cannot send, cannot change contact fields, is capped at 3
  per user per run, and `radar_paused` is the kill switch. A smoke pins that `src/lib/radar/**`
  (except `digest.ts`) imports no send module.
- New AI operations, registered in `AI_OPERATIONS`: `radar.why` (fast tier, minimal thinking,
  background) and `radar.news_match` (decision tier, background; `canAct` stays `null`).

## Testing

All harnesses are `tsx` smoke scripts registered in `scripts/run-smoke.ts`:

- `scripts/smoke-radar-score.ts` (pure) — ordering properties (an unanswered inbound message
  outranks dormancy at equal context; the recent-touch penalty removes reach_out; `never` drops the
  kind; decay is monotone; bucket thresholds; kind-priority tiebreak) and determinism (the same
  input scores deep-equal twice).
- `scripts/smoke-radar-run.ts` (pglite) — a fixture with a dormant inner-tier contact, a recent
  intro, an unanswered inbound message, a future meeting, an open action item, a pinned-out
  contact, a contact with a follow-up set, a pending `job_posting_signal` row and a `never` row.
  Asserts one recommendation per contact, every exclusion, the caps, that a second run changes
  nothing, that a snooze survives, ≤ 14 statements, and start/finish `radar_runs` rows. P1 adds a
  seeded news item that yields a `heads_up` with a source label while a generic-word company yields
  nothing, a manual company change that yields "Now at Acme" exactly once, and the assertion that
  hosted-key accounts never call Apollo.
- `scripts/smoke-radar-feeds-parse.ts` (pure) — fixtures for every format; sanitisation (no
  newlines or HTML in titles), `javascript:` URLs dropped, EDGAR company extraction, n-gram keys.
- `scripts/smoke-radar-feeds-sweep.ts` (pglite, scripted fetch) — 304 path stores no validators;
  an oversize body is `too_large` and stores no validators; a second sweep upserts nothing;
  pruning removes old items.
- `scripts/smoke-radar-digest.ts` (pglite) — a New York user at Monday 07:30 local is selected
  and at Sunday 11:00 UTC is not; a second call the same week selects nobody; no Resend key yields
  `skipped` and releases the week claim; the HTML contains no external URL.
- `scripts/smoke-radar-social.ts`, `scripts/smoke-radar-autopilot.ts` (P2) — parsers on fixtures
  and dedupe; the autopilot cap, suppression, undo, and the no-send-module import assertion.
- Existing guards that must stay green: `smoke-schema-ddl`, `smoke-purge`, `smoke-data-export`,
  `smoke-contact-merge`, `smoke-public-routes`, `smoke-internal-auth`, `smoke-schedules`,
  `smoke-ops-sweep`, `smoke-ai-operations`, `smoke-draft-prompts`, `smoke-render-stamp-pages`,
  `smoke-admin-analytics`, `smoke-surface-visibility`, `smoke-command-palette`,
  `smoke-icon-button-names`, `smoke-tap-targets`, `smoke-action-user-scope`,
  `smoke-page-budgets` (dashboard 16 → 17 and panel 8 → 9 in P0, back to 16 in P1),
  `smoke-bounded-reads`, `smoke-batched-writes`, `smoke-behavior-golden` (untouched in P0,
  re-recorded once in P1 from trusted code).

## Files touched

| Area | Files |
|---|---|
| Engine | `src/lib/radar/{types,score,run,store,explain,page-data}.ts`, `src/lib/radar/signals/{internal,existing-suggestions,news,job-change,apollo-recheck,social}.ts`, `src/lib/radar/feeds/*`, `src/lib/radar/{digest,autopilot,feedback}.ts` |
| Schema | `src/db/schema.ts`, `src/db/index.ts` (DDL, alters, `SCALE_DDL`, `SCHEMA_VERSION`), `scripts/schema-ddl.lock.json` |
| Routes and actions | `src/app/api/radar/{run,feeds/sweep,digest,digest/unsubscribe}/route.ts`, `src/app/api/extension/signals/route.ts` (P2), `src/actions/radar.ts` |
| Page | `src/app/(clerk)/(app)/(main)/radar/{page,loading}.tsx`, `src/components/radar/*`, `src/components/loading/page-skeletons.tsx` |
| Registry | `src/lib/surfaces.ts`, `src/components/layout/app-nav.ts`, `src/lib/analytics-routes.ts`, `src/lib/feedback-report.ts`, `src/components/coming-soon/coming-soon.tsx`, `README.md` |
| Readers | `src/lib/reminders.ts`, `src/actions/reminders.ts`, `src/components/dashboard/dashboard-sections.tsx`, `src/lib/notification-panel.ts`, `src/lib/chat-attention.ts` |
| Jobs and ops | `.github/workflows/ops.yml`, `src/lib/cron-runs.ts`, `src/lib/public-routes.ts`, `src/lib/ops-sweep.ts`, `src/lib/ops-alerts.ts`, `src/lib/rate-limit.ts`, `docs/RUNBOOK.md`, `.env.example` |
| AI | `src/lib/ai-operations.ts`, `src/lib/decisions/catalog.ts`, `src/lib/events/guarded-fetch.ts` (`userAgent` option) |
| Signal hooks | `src/lib/contact-writes.ts`, `src/actions/contacts.ts`, `src/lib/extension/resolve.ts`, `src/lib/duplicates.ts` (P2) |
| Lifecycle | `src/lib/user-data.ts`, `src/lib/data-categories.ts`, `src/lib/contact-merge.ts` |
| Tests | `scripts/smoke-radar-*.ts`, `scripts/fixtures/radar/*`, `scripts/run-smoke.ts`, and the existing guards listed under Testing |

## Risks

- **`SCHEMA_VERSION` collisions** have happened seven times in this repository; each phase
  re-checks `origin/main` and open PRs before picking its number.
- **Company matching without domains** false-positives on common words (Apple, Square, Oracle).
  A stoplist, a capitalisation rule, `companiesMatch` confirmation, the decision-model check and
  `NEWS_PER_RUN_CAP` bound it; the design prefers false negatives.
- **Nightly BYOK spend** (≤ 5 fast-tier calls per user per night) follows the `recruiter.scan` and
  `import.enrich` background precedent; `radar_paused` is the kill switch and the usage card shows
  the spend under its own label.
- **GitHub schedule lag and the 60-day disable rule** apply to three new lines; the 30 h
  missed-run alert, the hourly-Monday digest window and the page's stale-while-revalidate cover it.
- **Timezone** comes only from a cookie; users who never open Radar or Settings get UTC Monday
  06:00–09:00.
- **`smoke-behavior-golden`** stays untouched in P0 (overlap mode) and is re-recorded once in P1.
- **Identity-kind extension** depends on the identity sync not wiping unknown kinds; the fallback
  is two `contacts` columns.
- **Social polling** is per-handle third-party traffic from shared Vercel egress IPs; caps are
  conservative and failures are recorded, never retried in-run.
- **Refresh now** runs inline under the layout's 60 s ceiling with a 20 s budget and reports
  partial results rather than timing out.

## Open questions

The plan proceeds on the stated default for each.

1. Digest default **on** (one-click unsubscribe; only accounts active in 30 days with at least one
   recommendation), or opt-in? Default: on.
2. Ship `/radar` behind `comingSoon: true` first and release by deleting the line? Default: yes.
3. Nightly run only for accounts active in the last 60 days (a returning user gets the first-visit
   inline build)? Default: yes.
4. Apollo re-check proposes only; "Update record" is the click? Default: yes.
5. Keep GDELT off until sized, treating HN + EDGAR + RSS as v1 news? Default: yes.
