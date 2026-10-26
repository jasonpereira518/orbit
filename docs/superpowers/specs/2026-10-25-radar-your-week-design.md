# Radar: Your Week — rethink and ship

Status: approved by Jason, 2026-10-25. Supersedes `2026-09-27-radar-recommendation-engine-design.md`
and `2026-09-29-radar-flagship-design.md` wherever they disagree. Phase 0 ships with this document.

## Context

Radar exists: about 6.6k lines, shipped dark Sep 29 (#368), released Sep 30 (#380), pulled back to coming soon Oct 1 (#387). Jason pulled it back for three reasons: the picks weren't good, cost and DB load, and the UX wasn't ready. He wants a **rethink**, not a re-release.

Research (two workflows, 15 agents, every load-bearing claim re-checked in code) found:

- **Wrong people.** Any signal can create a card. A company headline, a social post or a job posting is enough. `loadCandidates` (`src/lib/radar/signals/internal.ts:261`) admits anyone a signal names, anyone with a Bluesky or Mastodon handle, and anyone "met" in 21 days, which includes every recent LinkedIn connection, because the import stamps `first_interaction_at`. Importance only adds points (`score.ts:287-537`).
- **Generic reasons, nothing to say.** Reasons are signal labels ("96 days since you last spoke"). Nothing from the relationship itself reaches the card, though `relationship_digests` (`schema.ts:1782`: `topics`, `open_threads` with `owedBy`, `working_on`) and `contact_briefs` (`goal_fit`, `recent_discussions`, `next_step`) already store it.
- **Too many cards.** 12 live cards, and "Today" means four different things across the page, the drafts, the bell and the email.
- **Cost.**
  - Live leak: the Sep 30 openers still get a nightly AI run on the managed pool (`api/radar/run/route.ts:35` checks only `hidden`). Radar AI falls back to Orbit's pool on every plan, Free included.
  - The hourly news sweep wakes Neon 720 times a month.
  - GitHub fires about 10% of cron schedules.
- **UX bugs** (confirmed in code):
  - Focus-mode key listeners cancel each other (`use-radar-keys.ts:31,43`).
  - Schedule silently moves an existing hand-written reminder (`reminder-writes.ts:191-206`), with no Undo.
  - "Not for this person" Undo restores only one card.
  - Cold-start accounts see "All clear".
- **No paywall.** The coming-soon screen says "Unlocks with Pro". No `radar` FeatureKey exists (`plan-config.ts:83-95`), and tier rules don't reach the cron, email, bell or extension paths.

### Jason's decisions (binding)

| Question | Decision |
|---|---|
| Scope | Rethink Radar |
| Core job | One list blending **goals**, **moments** and **keep-warm**, ranked |
| Shape | A **weekly plan** of 5–10 people, worked through at your own pace |
| Access | **Free taste, Pro full** |
| Weak ties | Target-company people with no history may enter the Goal lane **only with a real hook** |
| News and social | **Cut** company news feeds and Bluesky/Mastodon polling |
| Mid-week | **Frozen** plan at launch, no meeting cards; revisit at week 4 |
| Flagship extras | **Keep** the AI rerank, learned model, why-lines, autopilot, Schedule, focus mode, What-changed and the bell row. Fit them to the weekly plan and fix their bugs |

### Defaults I've assumed (say if you want otherwise)

- **Free "Write it"** makes an on-demand AI draft from Free's own credits. This is the existing contact-page draft (`followup.draft`, foreground, rate-limited by #474).
- **Monday email**: Pro only, on by default, 06:00–09:00 local. A global daily cap and bounce suppression come first. Buy Resend Pro ($20/mo) before about 80 weekly recipients.
- **Release**: dogfood, then a `live:page.radar` override for every plan, then delete `comingSoon` after a 4-week ship bar.
- **Plan size**: Free 3, Pro 7, never padded, no setting.
- **Pause stays.** Refresh now and the network-stats aside are removed (both conflict with a frozen week).
- **No schema change.** The name "Radar" and the `/radar` route stay; the page is titled "Your week".

## What users get

**The week.** The first time you open the dashboard or `/radar` in your local week (Monday 00:00 in `radar_digest_tz`, else UTC), Radar builds your plan. For Pro accounts with the email on, the Monday email job builds it first. After that the plan is frozen: page views never rescore it, and it only shrinks as you work through it.

**Each card shows:**
- name · title · company, and a lane chip (Goal / Moment / Keep warm)
- WHY THIS WEEK: one specific, dated line
- BRING UP: one true fact from your own data, with its source and date
- on Pro, "Draft ready · LinkedIn" and the draft's first sentence
- the AI angle or why-line under the WHY

Actions:
- Review & send (Pro) or Write it (Free)
- Schedule
- Done
- Not this week
- ⋯ menu: Not someone I care about · Nothing to say here · Something here is wrong

Every action has Undo. A card closes itself when Orbit sees an outbound message or a past meeting or call after the card was made.

Example card (Pro, Goal):

> **Priya Shah** · Senior SWE · Stripe — *Goal*
> WHY: Stripe posted "Software Engineer Intern, Summer 2027" — #1 on your target list.
> BRING UP: Last time you talked about her move to Payments — your conversations, Mar 12.
> Draft ready · LinkedIn: "Hi Priya! Hope Payments has been fun…"

**Free** gets the same rules and cards for up to 3 people, all actions, focus mode, What-changed, the bell row and cold-start triage. After the third card comes a teaser with the true count: "4 more people are worth your time this week. Orbit Pro plans all 7, writes every draft, and sends your week on Monday", linking to `/upgrade?gate=radar`.

**Pro** gets up to 7 people, plus:
- the AI rerank at the weekly build
- pre-written drafts
- why-lines
- opt-in autopilot (schedules, never sends)
- the Monday email

**Cold start.** If the plan comes up empty and the circle has fewer than 10 people, the page shows "Radar plans your week around people who matter to you". The existing onboarding `TriageStep` appears inline and writes `stated_closeness`. Links to add goals and target companies sit beside it, and **Build my week** follows. "All clear" never appears. A short week says "Only 2 people need you this week."

**Other surfaces:**
- Dashboard briefing: "Your week · 5 of 7 left", the top 3 remaining, and "N drafts ready" on Pro.
- Bell: "This week: 4 of 7 left · 3 drafts ready". It is never a due item.
- Chat/MCP: `getAttentionBrief` and `list_radar_cards` read the stored plan, so Free sees its 3.
- Header tally: "October: you reached 9 · 4 replied".

## Engine design

### 1. Who matters: the circle gate (`signals/internal.ts` `loadCandidates`)

Importance is the entry ticket; a signal only attaches to someone already in. It is one statement, LEFT JOINing `contact_touch_counts` and `contact_briefs`. The cap drops from 1,500 to 400. A candidate needs one of:

- **C1** `constellation_pin = 'in'`
- **C2** `priority_level >= 1`
- **C3** `stated_closeness >= 3`
- **C4** notes, or note interactions. Use `contactsWithNotes`, exported from `src/lib/dashboard-network.ts:87`.
- **C5** a real two-way exchange: at least 3 messages in and 3 out (constellation thresholds, `clampThresholds`)
- **C6** `closeness_tier IN ('inner','mid') AND closeness_evidence >= EVIDENCE_FLOOR`

Exceptions:

- **Goal lane from outside the circle**, hook required:
  - G1: an open `contact_opportunities` row
  - G2: an active-goal item in `contact_briefs.goal_fit`
  - G3: works at a priority-1 or -2 target company
- **Moment lane from outside the circle:**
  - M1: they wrote last, in a thread you've written in before, 5–30 days ago
  - M2: something you owe: an action item not owed by them, or an opportunity due
  - M3: a shared event in the last 14 days
  - M4: met 7–21 days ago through capture, scan or manual entry, not an import

**Never enough on its own:**
- being named by a signal
- `relationship_score`
- meeting counts (an ICS import logs one per attendee, with no size cap)
- undirected message volume
- tags
- `next_follow_up_at`
- social handles
- importer-stamped met fields

Add `IMPORTER_CONTACT_SOURCES` beside `IMPORT_SOURCE_TAGS` in `src/lib/constellation-eligibility.ts`. For those sources, `how_met`, `met_context`, `date_met` and `first_interaction_at` are neither evidence nor hooks.

Store the circle reason as a 0-point `circle:<code>` context reason, for the "Why them" tooltip.

### 2. Hooks: no hook, no card (new `src/lib/radar/hooks.ts`)

`loadHooks(userId, ids)` is one statement over the top 30 picks. It reads `contacts` (`key_facts`, `shared_interests`, `school`, `source`, the met fields), `relationship_digests` and `contact_briefs`, plus `user_settings.schools`.

`pickHook` is pure; the first hit wins:
1. a digest open thread owed by me, ≤180 days old
2. the brief's `next_step`, ≤60 days
3. digest `topics[0]`, ≤365 days
4. `working_on`, ≤180 days
5. `recent_discussions[0]`, ≤365 days
6. `key_facts[0]`, for C1–C3 and C6 people only
7. `shared_interests[0]`
8. how-met, for non-importer sources only
9. shared school

A hook is rejected if it is under 20 characters or a pleasantry (`/^(thanks|ok|great|…)\b/i`).

**Self-hooking reasons** are their own fact and need no BRING UP line:
- a job move
- their message (`last_in_text`, added to the existing messages aggregate)
- an action item
- an opportunity
- an event
- a saved post
- a job posting
- a goal-fit "why"

**Storage:** the hook goes in `evidence[0] = {label, at, source}`. `RadarEvidence.source` is a TypeScript-only change to a jsonb column. `inputs_hash` already covers evidence.

**Web-sourced job moves** (`contact_career_moves.source = 'web'`) get the code `job_change_web`. The WHY reads "Looks like he joined Ramp — web check (worth confirming)", and the draft asks rather than congratulates.

**Fencing (the injection fix):**
- `generateContactFollowUpDraft` gains a `reminderBlock` option (`follow-up-drafts.ts:359` hard-codes it today). Radar's WHY and hook go into `fenceUntrusted('REMINDER')`.
- `draftIntent` (`types.ts:115`) becomes a fixed Orbit-written template per lane or code, with nothing interpolated. It ends "Mention exactly the fact in REMINDER; add no other facts".
- The rerank and why prompts get the hook inside their existing fenced FACTS block.
- The draft sheet sends `radarId`, and the server rebuilds the context. Client-side intent text stops.

### 3. Ranking and the weekly mix (`score.ts`, tuned rather than rewritten)

- **Remove** the prep reasons (Reminders owns meetings: `calendar-reminders.ts`, ≤8 guests), `company_news`, `social_post`, and `brief_next_step` as a trigger (it is a hook now).
- **Add** Goal-lane bases, as kind `opportunity`:
  - `goal_fit_brief` 24
  - `target_company_lead` {1: 22, 2: 16}
  - `opportunity_open` 26 (undated opportunities count)
  - `job_posting` 28, limited to the last 30 days
- **Decay inside windows:**
  - inbound: 34 → 17 across days 5–30 (the window drops from 90 days to 30)
  - `post_event` decays across 14 days
  - just met: 30 → 15
- **Relabel:**
  - dormant: "You said '<phrase>' — nothing logged since <date>"
  - quiet thread: "went quiet Sep 12"
  - "N days since you last spoke" is no longer produced
- **`isHighValue`** drops `relationship_score`. Tier cadence: inner 30 days, everyone else 60, unless the contact has its own cadence.
- **Lanes:** `laneOf(kind)` maps heads_up, follow_up and reach_out to Moment, opportunity to Goal, and reconnect to Keep warm.
- **`rankPlan(picks, size)`** replaces `rankPicks`:
  - drop picks with no hook
  - sort by score, then hook strength, then older last touch, then id
  - cap each lane at ceil(size/2)
  - goal floor of 1 if one qualifies
  - never pad
  - store `qualified` for the Free teaser
- **`PLAN_SIZE = {free: 3, pro: 7}`.** Every plan row is written with `bucket = 'today'`, so "Today" means "this week's plan" everywhere, and the drafts, autopilot, digest and bell need no reader changes.
- **Suppression:**
  - any accept rests the person for 21 days, across every kind
  - Not this week lasts the rest of the week, with no penalty
  - Nothing to say uses the existing 14-day exclusion, then −30
  - `wrong_fact:<hookKey>` suppresses that hook forever
  - never stays permanent

### 4. Keeping the flagship extras

- **Learned model** (`model.ts`): kept, for Free and Pro, and rebuilt from one grouped statement at each weekly build. Votes:
  - accept: sent, done, schedule, or detected
  - converted counts double
  - dismiss: never, or nothing to say
  - Not this week casts no vote
  - ignore: seen ≥3 times, then expired untouched, counts half
  - cards closed by detected activity count as accepts, not ignores (fixes today's noise)
- **AI rerank** (`rerank.ts`): Pro only, once per weekly build, ±15 over the top 20 before `rankPlan`. Two paths:
  - In the Monday email job, it runs inside the build with today's 8 s timeout.
  - On a lazy page-triggered Pro build, it runs inline with a 5 s timeout behind the skeleton or the briefing's Suspense. On timeout it keeps the scorer's order (existing fallback).
  - Page views never rebuild, so today's bug where a refresh erased the rerank's work goes away.
  - The 7-day cache stays.
- **Why-lines** (`explain.ts`): Pro, in `after()` following the build, only for plan cards with no rerank angle (saves duplicate calls). The on-demand `radar.why.ask` stays on both plans, as a foreground op.
- **Autopilot** (`autopilot.ts`): Pro only, opt-in per kind, run once after the weekly build. It schedules at most 5 and never sends. The "Autopilot did this" strip keeps its Undo. It stops on downgrade. Copy fix: "a reminder in Orbit", not "on your calendar".
- **Schedule:** kept, with R8 fixed. If the contact already has a pending reminder, Schedule leaves it alone, marks the card accepted, and toasts "Already on your reminders for Thu". Otherwise it creates the reminder, and Undo deletes that reminder and restores the card. The sprint-C presets stay.
- **Focus mode:** kept, with one fix: a single deck-level keyboard listener. j/k move between cards. s/d/z/x go to the active card through a handler ref, so the card no longer registers its own listener (the shape of `use-triage-keys.ts`). The default is a CSS breakpoint switch (focus below md, list above), and an explicit toggle is saved in a cookie read on the server, so the hydration flash goes away. Add aria-live and `inert` on folded cards.
- **What-changed:** kept, with news gone. It now lists job moves detected since the last plan, replies received since the build, and saved posts.
- **Bell row:** kept, tier-aware through `isSurfaceLive`. It counts this week's pending plan rows, the same number as the page and the briefing.

### 5. Lifecycle (no nightly pass)

**`ensureWeeklyPlan(userId, ent, trigger)`** replaces `ensureRadarRun` and `maybeRefreshRadar`. It runs under `claimRadarLease`. A build is due when any of these is true:
- the local week changed (`radar_runs.stats.weekOf`)
- the entitled size grew (an upgrade grows the plan to 7 at once; a downgrade waits until next week)
- the user pressed Build my week on an empty week

**Pro build order:**
1. signals, circle and score
2. the model
3. the rerank
4. `rankPlan`
5. write
6. autopilot
7. in `after()`, drafts (`draftPlan`: up to 7, stops at the first credit refusal), then why-lines

**Free build:** steps 1, 2, 4 and 5 only. No AI.

**On every read**, two single-statement updates run in `after()`:
- `closePlanCardsByActivity`: outbound, or a past meeting or call, where `created_at < interaction_date <= now()` and the row is not AI-derived
- `detectRadarOutcomes`

**Delete:**
- the nightly pass: `/api/radar/run`, `runRadarPass`, `claimRadarUsers`, `releaseRadarLease`, `RADAR_PASS_*`, its ops.yml step and its #457 row, the cron-runs entry and alerts
- the feeds sweep and social polling

This also removes the claim race, so 26ff6e5b's Radar hunk becomes moot.

### 6. Free and Pro, on every path

Follow the shape of `requireOutreachUser` (`src/lib/plan-guards.ts:43-48`):

- **`plan-config.ts`**: add `radar` to `FEATURE_KEYS` and `PAID_FEATURES`; Free is false.
- **`entitlements.ts`**: `canUseRadar`, `FEATURE_DENIAL.radar`.
- **`product-event-schemas.ts`**: `GATES += 'radar'`.
- **Build:** the size comes from `entitlementsFromSettings`. Readers inherit the cap (page, dashboard, chat, MCP, bell).
- **`openRadarAi(userId, ent)`** returns null unless `canUseRadar`. That makes it the single choke point for the rerank, why-lines and drafts. Personal key first, then the managed pool's background floor.
- **Autopilot** toggles call `requireEntitlement`. `applyAutopilot` skips accounts without the entitlement. The chat tool `set_radar_autopilot` (#487) gets the same gate.
- **Digest:** `openZones` and `eligibleBatch` (`digest.ts:283-324`) add `AND (PLAN_SQL) <> 'free'`. `PLAN_SQL` is exported from `admin-roster.ts:113`. `setRadarDigest(true)` calls `requireEntitlement`; turning the email off and unsubscribing are never gated.
- **Hand-rolled live checks** become tier-aware: `dashboard/page.tsx:53`, `settings/page.tsx:141`, `app-pulse.ts:64`, and `api/extension/signals/route.ts`, which uses `isSurfaceLive` and keeps the v1 `off` error.
- **Never** write a `tiers:page.radar` rule, and never put `page.radar` in `PAGE_FEATURE`. Either would lock Free out of its taste. Record this in the RUNBOOK.
- **Copy:** `plan-comparison.tsx`, `plan-copy.ts`, `coming-soon.tsx:40-44`, and `surfaces.ts:357-362`.

### Cost envelope (estimates; Phase 10 measures them)

| | Free (weekly-active) | Pro |
|---|---|---|
| Build | ≤26 statements, once a week | same, plus 1 rerank call |
| Views | page ≤4 statements, briefing ≤3 | same |
| AI per week | 0 background | ≤1 rerank + ≤7 drafts + ≤7 why-lines ≈ $0.005 |
| Email | none | 1 a week |

At 1k accounts, Pro AI comes to under $15 a month (under 8% of the $190 pool). Scheduled Radar wakes fall from about 956 a month to about 206 (the digest only).

## Data model

**No schema change and no `SCHEMA_VERSION` bump**, so nothing collides with 182/183.

How existing columns are used:
- `recommendations` row = a plan card; `bucket = 'today'` means "in this week's plan"
- `evidence[0]` = the hook
- `draft`, `ai_delta`, `ai_angle`, `ai_note` and `autopilot` stay in use
- `radar_runs.stats` gains `{weekOf, size, qualified, circle}`
- `radar_runs.trigger` gains `'digest'` (TypeScript only)
- `recommendation_feedback.reason` carries `sent|done|detected|schedule|not_now|nothing_to_say|wrong_fact:<key>`

The first build under the new code expires each account's old pending rows.

Dead after this work, dropped at the next unrelated schema bump (184+, after a scan of every remote ref):
- `external_sources`, `external_items`, `external_item_companies`
- `user_settings.radar_next_at`
- `recommendations.base_score` stays, still used by the model

## Phases (one PR each, in order)

| # | PR | Size | Key files |
|---|---|---|---|
| 0 | **Stop the coming-soon leak.** The run route stands down on `soon.has` too, like `digest/route.ts:36`; so does the feeds sweep; false comments are fixed | S | `api/radar/run/route.ts`, `api/radar/feeds/sweep/route.ts`, `run.ts:501-506` |
| 1 | **Fence draft context.** `reminderBlock` option, fixed intents, `radarId` path, `job_change_web` | S | `follow-up-drafts.ts`, `radar/types.ts`, `radar/drafts.ts`, `actions/contacts.ts:1464`, `signals/internal.ts` |
| 2 | **Cut news and social.** Delete `feeds/*`, `signals/news.ts`, `signals/social.ts`, the sweep route and its ops/#457 rows, alerts, `smoke-radar-feeds` and its registrations | M | `src/lib/radar/feeds/*`, `run.ts:317-331`, `.github/workflows/ops.yml`, `ops-alerts` |
| 3 | **Fix the kept extras.** Focus-mode single listener and CSS default; Schedule without moving an existing reminder, plus Undo; never-Undo restores all; `status='pending'` guards; autopilot and draft-sheet copy; drafts stop at the first refusal; why-lines skip cards with an angle | M | `use-radar-keys.ts`, `radar-view.tsx`, `recommendation-card.tsx`, `actions-core.ts`, `use-recommendation-actions.ts`, `radar-settings-sheet.tsx`, `follow-up-draft-sheet.tsx`, `drafts.ts`, `explain.ts` |
| 4 | **Radar entitlement on every path** (§6) | M | `plan-config.ts`, `entitlements.ts`, `explain.ts` (`openRadarAi`), `autopilot.ts`, `digest.ts`, `admin-roster.ts`, `app-pulse.ts`, `dashboard/page.tsx`, `settings/page.tsx`, `api/extension/signals/route.ts` |
| 5 | **Circle gate** (§1) | M | `signals/internal.ts`, `constellation-eligibility.ts`, `dashboard-network.ts`, `score.ts` |
| 6 | **Hooks, decay, weekly mix and model votes** (§2–4) | M | new `radar/hooks.ts`, `score.ts`, `types.ts`, `run.ts` `scorePicks`, `store.ts` `loadSuppressions`, `model.ts`, `store.ts` `loadModelTallies` |
| 7 | **Weekly lifecycle** (§5): `ensureWeeklyPlan`, Pro AI order, detection, the new actions in #474's `defineAction` shape, deletion of the nightly pass | L | `run.ts`, `store.ts` (`listPlanWeek`), `drafts.ts` (`draftPlan`), `actions-core.ts`, `src/actions/radar.ts`, `api/radar/run/route.ts` (deleted) |
| 8 | **Weekly plan UI on every surface:** cards, lanes, teaser, cold start, tally, focus, What-changed, autopilot strip, bell copy, briefing, chat starters, the e2e preview cookie | L | `radar-view.tsx`, `recommendation-card.tsx`, `morning-briefing.tsx`, `briefing.ts`, `page-data.ts`, `notification-panel.ts`, `radar/page.tsx`, `chat-suggestions.ts`, `e2e/07-a11y.spec.ts` |
| 9 | **Monday email.** Build, then rerank, autopilot and drafts, then send; safe `emailLine` only; last week's tally; `?src=radar_email`; `consumeBucket('radarEmailDaily', 80)`; Resend bounces turn the email off | M | `digest.ts`, `digest-email.ts`, `api/webhooks/resend/route.ts`, rate-limit config |
| 10 | **Measure, then release.** `metrics.ts` with `internalAccountSql`, split by lane, hook source and plan; rerank tiles fixed ("untouched" excludes `ai_delta IS NULL`); RUNBOOK; pricing copy; dogfood → `live:page.radar` → delete `comingSoon` | M | `metrics.ts`, `admin/analytics/radar/page.tsx`, `docs/RUNBOOK.md`, `plan-comparison.tsx`, `plan-copy.ts`, `coming-soon.tsx`, `surfaces.ts:73` |
| 11 | **One "who to reach out to" system.** Delete `SuggestedOutreachCard` and `buildOutreachSuggestions` (a full contacts scan on dashboard visits); update `outreach-metrics.ts` and `pipeline-filters.tsx` first | S | `reminders.ts:46-215`, `actions/reminders.ts:138-144`, `dashboard-sections.tsx:358-374` |

Phase 0 ships alone, now. Phases 1–9 keep Radar dark (admins and the demo workspace preview it); users see a change only at Phase 10.

### Reuse (don't rewrite)

- `claimRadarLease`, `writeRunResult` (upsert on `recommendations_live_v2_uidx` keeps card ids and drafts), `recordFeedback`, `markRecommendationsSeen`, `detectRadarOutcomes`, `listPendingRecommendations` (stays pending-only for chat).
- `digest.ts` week claim, zones and `resendDeliver`; #474's signed unsubscribe token.
- `FollowUpDraftSheet`, onboarding `TriageStep`, `UnlocksWith`, `LockedFeature`, `runToastAction`.
- `requireEntitlement` (`entitlements.ts:273`), `entitlementsFromSettings` (`:212`), `isSurfaceLive` (`surface-visibility.ts:326`), `RETIRED_OPERATION_LABELS` (`ai-operations.ts:179`), `internalAccountSql` (`analytics-internal.ts:53`), `fenceUntrusted` / `guardModelOutput`.

## In-flight PRs

- **Order:** Phase 0 → **#474** (security audit: `defineAction` and the token; write every new Radar action in its shape) → **#478** (it touches `follow-up-drafts.ts`) → Phases 1–6.
- **Chat stack #468–#488:** can merge any time. Keep its Radar tools, since Schedule and autopilot stay. After Phase 4, gate `set_radar_autopilot` on the `radar` entitlement, and point `schedule_recommendation` at the fixed Schedule path. Ask #484's `releaseCheckFor` to call `isSurfaceLive`.
- **#457 (QStash):** rebase after Phase 2 and Phase 7 so only the `radar-digest` row is left. It must be live before Phase 9's first Monday. Its 10-minute non-Radar cadence (~183 CU-h/month) is a separate decision.
- **#465:** drop its edits to files this work deletes or rewrites. Archiving the 2026-09 Radar specs is welcome: this plan supersedes them.
- **#467:** exclude `src/components/radar/*`.
- **Email insights #386–#399:** parked. They are 650+ commits behind, claim dead schema 145, and need `gmail.readonly`, which awaits CASA. Close #394 and #397 as superseded. After CASA, re-cut on main as one more Moment producer.
- **26ff6e5b:** don't cherry-pick its Radar hunk (Phase 7 deletes the claim). Give its non-Radar claim sites their own PR.

## Verification

**Smokes** (each PR adds to its own):
- Phase 0: `smoke-radar-run`. The route stands down while Radar is coming soon, and no `radar_runs` row is written for a Sep-30-style account.
- Phase 1: `smoke-radar-run` asserts that hook text appears only inside the REMINDER fence, and that the intent is a fixed template.
- Phase 5: a truth table. **No card** for:
  - a 10-day-old LinkedIn connection
  - `relationship_score` 5 with no rating
  - a Bluesky handle alone
  - a 30-attendee ICS meeting
  - a recruiter InMail you never answered
  - an import-only network of 3,000 contacts

  **A card** for:
  - inbound from someone you've written to before
  - a target-company contact with a hook
  - someone captured 10 days ago
- Phase 6: no hook means no card. "96 days since you last spoke" is never produced. Decay is monotone. Lane caps hold at sizes 3 and 7. Same inputs give the same order. A `wrong_fact` key suppresses one hook only. Model votes map as in §4.
- Phase 7:
  - a second read in the same week makes no build; a new week rebuilds
  - Free writes 3 rows and makes 0 AI calls; Pro writes 7
  - an upgrade grows the plan mid-week
  - detected close fires on an outbound email but not on a future meeting
  - two concurrent builds build once
- Phase 3: focus-key reducer cases. Schedule leaves an existing reminder untouched, and Undo deletes only the reminder Schedule created.
- Phase 9 (`smoke-radar-digest`): at most once a week, Free never claimed, no hook or message text in the body, a bounce turns the email off, the daily cap still builds.
- Statement budgets (`smoke-page-budgets`): build ≤26, `/radar` ≤4, briefing ≤3.

**Each PR runs** `npx tsc --noEmit`, eslint on touched files, and `npm test`. `smoke-radar-run` has a known time-of-day flake.

**Browser** (demo-mode preview; admin preview cookie): Free, Pro and cold-start accounts at 390 px and on desktop, with a keyboard pass in focus mode. The page, briefing, bell and chat must show the same count for one account. `e2e/07-a11y.spec.ts` runs axe on the real `/radar`.

**Release gates:**
- **Dogfood bar** (2 weeks; you plus at least 3 testers, one import-only):
  - at least 8 of 10 right person
  - at least 9 of 10 true, specific reasons
  - 0 wrong facts
- **Ship bar** (4 weeks live, at least 30 non-internal weekly planners):
  - reach ≥35%
  - reply ≥20% of those reached
  - wrong person ≤10%
  - nothing to say ≤10%
  - wrong fact ≤2%
  - median Pro plan ≥4
  - Free managed Radar spend $0
  - build p95 ≤2.5 s
- **Kill switch:** hide `page.radar` in `/admin/product`; no deploy needed.
- **Rerank check:** cards it promoted vs demoted vs left alone, with untouched counted correctly. Add a randomized holdout once there are about 500 Pro accounts.

## Risks

- **Thin plans for sparse accounts.** Mitigations: cold-start triage, the M1–M4 exceptions, and honest short-week copy. Loosen freshness windows before loosening the hook rule.
- **Stale AI-extracted facts.** Every hook shows its source and date. Web-sourced moves are asked about, never asserted. "Something here is wrong" suppresses the hook. Hook text never goes in the email.
- **A lazy Pro build waits on the rerank** (≤5 s, once a week, behind the skeleton or Suspense). The Monday email job pre-builds for most Pro accounts.
- **Free and email-off Pro get no push** beyond the bell and the dashboard. Planners are measured, and a Free email can be reconsidered after Resend Pro.
- **Deleting news and social and the nightly pass** affects only admins, previewers and about one day of openers.
