# Radar flagship — design addendum

Status: proposed, 2026-09-29. Extends `2026-09-27-radar-recommendation-engine-design.md` (the "base
spec"). Where the two disagree, this document wins. Everything the base spec says about safety,
privacy, lifecycle and ops still applies unless it is changed here.

## Where this came from

P0 shipped on PR #368 (behind `comingSoon`): a deterministic scorer over internal signals, the
`/radar` page, the nightly job, and Radar in the dashboard, bell and chat. Jason asked to make
Radar the flagship feature and optimize it on every axis. His decisions:

| Question | Decision |
|---|---|
| What to optimize | All four: better picks, more proactive, richer signals, feel and polish |
| AI in ranking | **Hybrid.** The scorer shortlists and explains; AI reranks within bounds |
| How we know it works | **Live acceptance metrics**, shown in admin |
| Home | **Radar is the dashboard's hero**: a morning briefing on top; `/radar` is the full list |
| Drafting | **Pre-draft Today's cards** nightly for people with an AI key; autopilot scheduling stays opt-in per kind; never auto-send |
| Delivery | Fold into PR #368 (one release, still gated until Jason flips it) |

## What changes from the base spec

1. **The "no model-driven ranking" non-goal is replaced by a bounded rerank** (below). The
   principle behind it survives: the order a person sees must not reshuffle between loads, and
   every card's reasons stay deterministic and true.
2. **Learning ships now**, not in a later phase, and it goes beyond "suppress on dismiss".
3. **Phases P1–P3 fold into this release**: external signals, the digest, social, extension
   activity and autopilot.
4. **Social handles are `contacts` columns** (`bluesky_handle`, `mastodon_acct`), not identity
   kinds. `syncIdentitiesForContact` releases every identity that `identityKeysFor` doesn't
   derive, so a new kind would be wiped on the next edit. This settles the base spec's open
   conditional.

## 1. Measurement first

Nothing below can be tuned without knowing what people do with cards. So measurement lands first.

**On `recommendations`:**
- `first_seen_at`, `last_seen_at`, `seen_count`: stamped when a card is rendered on `/radar`
  or in the dashboard briefing. One batched `UPDATE … WHERE id = ANY(…)` per render, fired from
  `after()`, so it never blocks the page.
- `base_score`: the scorer's own number. `score` becomes the final number after learning and
  the rerank.
- `ai_delta` (int, nullable): what the rerank added or removed.
- `acted_at` and `outcome_at`: `outcome_at` is set by the nightly run when an interaction
  that `countsAsTouch` lands within 14 days of an accept.

**Derived states** (computed, not stored):
- *Accepted*, *dismissed*, *snoozed*, *never*: from status and feedback.
- *Ignored*: seen at least 3 times, then expired without an action.
- *Converted*: accepted, and `outcome_at` is set.

**Admin: `/admin/analytics/radar`.** It shows:
- For the last 7 and 28 days, per kind: acceptance rate, conversion rate and ignore rate.
- Median time from first seen to action.
- Acceptance of cards the AI promoted versus demoted versus left alone. This is the rerank's
  report card.
- Draft use: opened, and edited before send.
- Runs, failures, p95 duration, and AI calls per run.

All of it is aggregated in SQL over `recommendations` and `recommendation_feedback`. No new
tracking table is added. `page_views` and `usage_events` stay as they are.

## 2. Better picks

### 2a. Per-person learning (deterministic)

Each account gets a small model in `user_settings.radar_model jsonb`:
`{ kinds: {kind: {a, d}}, reasons: {code: {a, d}}, updatedAt }`.
- `a` counts accepts plus conversions, where a conversion counts double.
- `d` counts dismisses plus ignores, where an ignore counts half.

The multiplier is a Beta-smoothed ratio pulled toward 1 with a prior of 6:
`m = clamp(0.7, 1.3, (a + 3) / (a + d + 6) / 0.5)`.

The scorer scales each signal reason's points by the geometric mean of its kind's multiplier
and its own, before bucketing. A reconnect card nearly always carries the dormancy reason, so
multiplying by both would count the same votes twice. With the mean, a card's signal points
stay within ×0.7–1.3. Context codes (tier, priority, goals) and penalties are not learned: they
describe the person, or what the person already did, not the signal.

The model is built from one grouped statement at the start of each run, so tonight's list
already uses it. It is saved to `user_settings.radar_model` in the run's final atomic write.

The model covers the last 90 days of rows. Nothing is updated on the click path.

The scorer stays pure. The model is an input, and the harness asserts both that it is bounded and
that the same model plus the same data scores the same way.

### 2b. Hybrid AI rerank (bounded)

This runs only for accounts with a completion key. There is one `fast`-tier call per nightly run,
plus one per "Refresh now". The steps:

1. **Shortlist.** After learning, take the top 20 picks by score, before the caps.
2. **Prompt.** A new operation, `radar.rerank` (background, `thinking: "minimal"`). The fenced
   `FACTS` block gets, per candidate: an id, kind, reason labels, evidence dates, title, company
   and tier. From the account: the active goal texts and the one-line `contact_briefs.summary`
   if one exists. Never raw notes and never message bodies.
3. **Output.** zod-validated: `[{ id, adjust: -15..15, angle: string ≤ 90 }]`. Unknown ids
   are dropped, and adjustments are clamped.
   - `angle` is a short "why now" that may only restate facts it was given.
     `guardModelOutput` is applied, and an angle is dropped if it names a number that doesn't
     appear in the facts.
4. **Apply.** `score = base_after_learning + adjust`, then bucket, caps and write as today. The
   angle becomes the card's why-line when there is no fresh `ai_note`.
5. **Stability.** The rerank is cached by a hash of the shortlist's `radarNoteKey`s plus the
   goals. An unchanged shortlist reuses yesterday's adjustments without a call. Reloading a page
   never reranks.
6. **Fallback.** No key, a timeout (8 s), or an invalid reply means `adjust = 0` for everyone.
   The run records `stats.rerank = "skipped" | "ok" | "failed"`.

**Why bounded.** ±15 against bucket gaps of 14–18 points means the model can move a card one
bucket, or reorder within one. It cannot surface a card that has no deterministic reason, and it
cannot bury a meeting tomorrow. Prep cards within 48 hours are exempt from negative adjustments.

## 3. More proactive

- **Pre-drafted Today cards.** After the rerank, for up to 5 `today` cards whose kind is
  reach_out, reconnect, follow_up or heads_up, the run calls `generateContactFollowUpDraft`
  (`src/lib/follow-up-drafts.ts`). The run loads the account's goals and writing instructions
  itself. The result is stored in `recommendations.draft jsonb` `{ channel, subject, body,
  inputsHash, generatedAt }`.
  - A draft is reused while `inputs_hash` is unchanged.
  - The card shows "Draft ready". Draft opens `FollowUpDraftSheet` with a new optional
    `initialDraft` prop, so the text appears instantly and can be edited or regenerated.
  - Budget: a shared 25 s AI deadline per user covers the rerank, then drafts, then why-lines,
    in that order.
- **Autopilot, per kind, opt-in.** `user_settings.radar_autopilot jsonb` `{ kind: true }`. For
  an opted-in kind, the run does two things:
  - schedules the follow-up with `scheduleContactFollowUpForUser` for 3 days out (prep: the day
    before the meeting), and marks the row `status = 'auto_applied'`;
  - drafts it.

  The card moves to an "Autopilot did this" strip with Undo. Undo removes the reminder only
  while it is still the one autopilot set (a follow-up the person has since moved stays), and
  retires the card as `expired`, not `dismissed`, so it is not a vote against the kind. The
  card records what it set in `recommendations.autopilot`. An autopilot action is not the
  person's vote either: the learned model counts it only if a conversation followed.
  Nothing is ever sent.
- **Weekly digest.** As the base spec describes: the Monday local-time window, a week claim,
  Resend through the `broadcasts.ts` pattern, and one-click unsubscribe through the
  `interest-list` token pattern. It adds the count of drafts ready.
- **Bell.** The row reads "3 drafts ready · 5 people worth a message" when drafts exist. It
  still never becomes a due item.

## 4. Richer signals

All of these write `contact_signals` rows, as in the base spec's data model. The scorer reads them
as the base spec's `heads_up` table describes (points and half-lives unchanged).

- **Job changes.** Main already notices them: the work-history sweep (PR #367/#369) re-checks
  contacts on the person's own AI key on a staggered schedule, and `recordJobChanges`
  (`src/lib/job-changes.ts`) writes every move to `contact_career_moves`, updates the contact's
  title and company, and adds a timeline entry. Radar reads that log (one windowed read in
  `produceInternalSignals`) and turns a move from the last 30 days into a `heads_up` card in
  the move's own words ("Joined Ramp as Staff PM (from Stripe)"): 32 points for a new
  employer, 24 for leaving, 18 for a new title, decaying with a 10-day half-life. No Radar
  hooks, no Radar-owned Apollo re-check, and no "Update record" action: the contact is
  already updated. `radar_apollo_cursor` and the `job_change` kind of `contact_signals` are
  left over from the earlier design and are removed with the next schema change.
- **Company news.** Global ingest-only tables: `external_sources`, `external_items` and
  `external_item_companies`.
  - An hourly sweep at `/api/radar/feeds/sweep` (`53 * * * *`, ledger `radar.feeds`) follows
    the `src/lib/jobs/feed-sweep.ts` structure: conditional GETs through `guardedFetchText`, a
    loud 3 MB cap, every outcome recorded on its source row, a feed being down is never a
    throw. It stands down when `page.radar` is hidden and until someone has opened Radar.
  - Sources: Hacker News (Algolia JSON) and the TechCrunch, The Verge and Ars Technica feeds.
    SEC EDGAR is out: it requires a contact address in the User-Agent, and `guardedFetchText`
    fixes its own agent string by design.
  - Each headline is filed under the bucket keys of every run of one to three capitalized
    words in it (`src/lib/radar/feeds/companies.ts`). Candidates, not verdicts.
  - The nightly per-user probe (`probeCompanyNews`) runs one indexed statement against
    `external_item_companies` with the account's candidates' company keys, confirms each hit
    with `companiesMatch`, keeps at most 3 a night (one per person), and writes them to
    `contact_signals`. A headline becomes a `heads_up` card naming the company, 20 points
    (+6 for money or a deal), decaying with a 5-day half-life, gone after 7 days. The card
    links the source through `safeHttpUrl`.
  - Known weakness: a company named with an ordinary word at the start of a sentence-case
    headline. The card shows the headline, and dismissals teach the model.
- **Social.** Two contact fields, Bluesky and Mastodon, on the contact form, normalized by
  `src/lib/social-handles.ts` (a pasted `@handle` or profile URL becomes the canonical form;
  anything else is cleared, so a typo never becomes a request). On the nightly pass only, the
  run checks at most 10 handles (rotating across nights), at most 3 requests per host,
  inside a 12 s budget, through `guardedFetchText`: Bluesky's public AppView
  (`getAuthorFeed`) and each Mastodon server's public API (`accounts/lookup`, then
  `statuses`). Each request carries only the public handle. Each person's newest post from
  the last week is kept once in `contact_signals` as a sanitized 280-character excerpt with
  its link through `safeHttpUrl`, and becomes a `heads_up` card quoting it (12 points,
  4-day half-life). Anyone with a handle counts as a candidate.
- **LinkedIn activity (extension).** `POST /api/extension/signals`, additive to contract v1
  (`SaveActivityRequest`, with a drift guard on its schema). It is refused unless the person
  turned on `radar_capture_linkedin_activity`, and only for their own contact. The excerpt
  is capped at 280 characters and deduplicated; a saved post counts more than a polled one
  (16 points). The extension's own "Save as Radar activity" button is a follow-up in the
  extension package.

## 5. Feel and polish

- **Morning briefing (dashboard hero).** It replaces the current Radar preview slot and moves up
  to sit right under `DashboardHeader`, above `AgentDraftsSection`. It shows:
  - a greeting line with today's count;
  - the top 3 Today cards in compact form, with Draft, Schedule and Dismiss inline;
  - "N drafts ready";
  - "What changed overnight": new job changes and news, as one line each;
  - "Open Radar →".

  Viewers who can't open Radar keep today's dashboard exactly as it is.
- **`/radar` redesign.**
  - **Focus mode** (the default on mobile): one card at a time, with Next and keyboard shortcuts
    (`j`/`k` to move, `s` schedule, `d` draft, `x` dismiss, `z` snooze).
  - **List mode** (desktop default): today's layout, with a "What changed" strip at the top and
    an "Autopilot did this" strip.
  - **Settings sheet:** pause, autopilot per kind, weekly digest, and LinkedIn activity capture.
  - **Network health strip:** `getNetworkStats` plus "signals this week".
- **Motion.** Cards collapse on resolve, using the repo's 0fr→1fr grid-rows technique, and Undo
  re-expands them. All of it respects `prefers-reduced-motion`.
- **Empty states.**
  - "All clear" with the next run time.
  - First run: an inline build, with a skeleton that names what it's reading.

## Data model changes (one schema version)

The version is the next free integer after re-scanning every remote ref. It will be at least 134:
133 stays as P0's merge version, and databases stamped 133 re-sweep.

- **`recommendations` + columns:** `base_score int`, `ai_delta int`, `ai_angle text`,
  `draft jsonb`, `first_seen_at`, `last_seen_at`, `seen_count int NOT NULL DEFAULT 0`,
  `acted_at`, `outcome_at`.
  - The status vocabulary gains `auto_applied`.
  - The live unique index becomes `status IN ('pending','snoozed','auto_applied')`. It is
    renamed so both engines rebuild it.
- **New tables:**
  - `contact_signals` (base spec).
  - `external_sources`, `external_items`, `external_item_companies` (global, base spec).
- **`user_settings`:**
  - `radar_model jsonb`, `radar_autopilot jsonb NOT NULL DEFAULT '{}'`.
  - `radar_capture_linkedin_activity integer NOT NULL DEFAULT 0`.
  - `radar_digest_enabled integer NOT NULL DEFAULT 1`, `radar_digest_tz`,
    `radar_digest_last_week`, `radar_digest_unsub_token_hash`, `radar_apollo_cursor`.
  - All of them go in the three `user_settings` places.
- **`contacts`:** `bluesky_handle`, `mastodon_acct` (text, nullable).
- **Lifecycle:**
  - Export and delete: `insights` gains `contact_signals`. The global tables are documented
    beside `job_postings`.
  - Contact merge: repoints `contact_signals`.
  - Purge and export smokes seed every new user-scoped table.
  - `radar_model` resets with an insights delete. Autopilot and digest preferences survive.

## Jobs (additions)

| Job | Route | Schedule | Ledger |
|---|---|---|---|
| Feed sweep (ingest-only) | `POST /api/radar/feeds/sweep` | `53 * * * *` | `radar.feeds` |
| Social poll | inside the nightly run (deadline-checked) | — | — |
| Weekly digest | `POST /api/radar/digest` | `13 * * * 1` | `radar.digest` |

Each job gets the base spec's full ops wiring: internal gate, ledger, `PUBLIC_ROUTES`, ops-sweep
snapshot, alerts and RUNBOOK rows. While Radar is coming soon, all three stand down, as the
nightly run does.

## Safety

- **Third-party text** (news titles, posts, job-change strings) is fenced as untrusted wherever it
  reaches a prompt. It is shown only as sanitized text, and links only through `safeHttpUrl`.
- **The rerank** can move a card only within ±15, and only among cards that already have
  deterministic reasons. Its angle is guarded and number-checked.
- **Drafts** use the existing draft pipeline and guardrails. No path sends.
- **Autopilot** only schedules, is opt-in per kind, and every action has Undo.
- **Spend** is BYOK only, capped per run, and none happens for accounts that can't open Radar.

## Testing

- `smoke-radar-score`: learning bounds and determinism; rerank application (clamping, the
  prep-in-48 h exemption, unknown ids dropped); news, job-change and social reason scoring.
- `smoke-radar-run`:
  - impressions are batched;
  - outcome detection;
  - the model is recomputed from rows;
  - the rerank is stubbed three ways: ok, invalid and timeout;
  - drafts are cached by `inputs_hash`;
  - autopilot schedules, and Undo clears it;
  - nothing runs without a key or while gated.
- `smoke-radar-feeds` (new, PGlite): parse fixtures for HN, EDGAR and RSS; the per-user
  probe runs in one statement; dedupe; the per-run cap.
- `smoke-radar-digest` (new, PGlite): the week claim can't double-send; the timezone
  window; the unsubscribe token.
- `smoke-radar-metrics` (new, PGlite): the admin aggregates over seeded rows.
- Existing smokes that need updates: purge, data-export, contact-merge, page-budgets (the
  briefing costs ≤ 3 statements; `/radar` stays ≤ 6), public-routes, internal-auth, ops-sweep,
  ops-alerts, ai-operations (`radar.rerank`), surface-visibility, toast-copy, icon-button-names,
  tap-targets.

## Risks

- **PR size.** #368 grows from about 5.5k to about 15k lines. Mitigations: one commit per
  section, in the order of the plan; a reviewer's guide in the PR body; the release stays gated
  throughout.
- **Rerank drift.** The admin panel's promoted-versus-demoted acceptance is the check. If
  promoted cards don't beat demoted ones after two weeks, one constant, `RADAR_RERANK_ENABLED` in `src/lib/radar/run.ts`,
  turns the rerank off.
- **Feed fragility.** Each source records `consecutive_failures`, and alerts fire at 24 h
  silence.
