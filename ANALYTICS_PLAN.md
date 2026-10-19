# Orbit analytics plan

Status: **implemented on branch `claude/sweet-maxwell-bu2l9z` (phases 1 to 4); see §6 for what shipped, what was assumed and what is left.** The text below is the original proposal. Evidence for every item is in `ANALYTICS_AUDIT.md` (finding ids like I1, M2 refer to it); definitions are in `TRACKING_PLAN.md`. Check scripts live under `analytics/`; the event schemas moved into `src/lib/product-event-schemas.ts`.

Effort: **S** under half a day, **M** one to two days, **L** three days or more, all for one person who knows the codebase. Regression risk is about the product, not the dashboard: a change that can alter what a user sees or is charged is marked accordingly.

---

## 0. Do this before the first invite wave

Ordered by value per hour. Everything here is phase 1 or the top of phase 2.

1. **Exclude internal accounts everywhere** (I1, I2, I3). Add `account_kind` to `user_settings`, seed it for `ADMIN_USER_IDS` and `DEMO_ACCOUNT_USER_ID`, and route every aggregate in `admin-trends.ts`, `admin-metrics.ts`, `money-metrics.ts`, `admin-yc-metrics.ts`, `admin-interest-list.ts` through one `excludedAccountSql()`. Until that lands, the simplest stopgap is applying the existing `internalAccountSql()` inside `writesSince()` and `loadAdminUserRows()`.
2. **Narrow "active" to intentional actions** (A1). Replace `writesSince()` with the action set in `TRACKING_PLAN.md` §1.3: drop `usage_events`, drop interactions with `external_id`, drop tour examples.
3. **One activation definition** (A2). Replace `isOnboarded()`'s `counts.contacts > 0` with a non-tour count and adopt "Captured and acted, within 7 days" on both the overview and the Conversion page.
4. **Add `reminders.completed_at`** and stamp it in `markReminderDone`, `completeFollowUpWithTouch`, `bulkReminderAction` (A4). Backfill `done` rows from `updated_at` flagged approximate.
5. **Add `ai_key_added_at`** on `user_settings`, set in `applyAiKeyChange` when a key appears (A4, U2).
6. **Invite ledger**: a `site_invites` table (email, interest_list_signup_id, wave_id, clerk_invitation_id, sent_at, accepted_user_id, accepted_at) written by `inviteToSite` and `claimSiteInviteGrant` (U5), and `user_settings.invite_id`.
7. **Carry attribution across the waitlist host** (U1): at `claimSiteInviteGrant` or first `(app)` load, if `signup_attributed_at IS NULL` and a waitlist row matches the invite, copy its `utm_*`, `referrer`, `landing_path` into `signup_*` with `signup_attribution_source = 'waitlist'`.
8. **Fix `mrrMovement` credit packs** (M1): add `case "credit_pack"` into one-time cash. One line plus a smoke assertion.
9. **Book churn on self-deletion** (M2): in `deleteOwnAccount`, before `purgeUserData`, book a `churn` row for any active subscription (`kind: 'churn', mrr_delta = -before, event_id: 'del:<userId>:<subId>'`), so the later Stripe event no-ops on the unique index.
10. **Turn the ledger-drift panel into an alert** (R1): add `billing.ledger_drift` to `ops-alerts.ts` (warning when |Σ ledger − live| > 0 for more than 24 h) and a daily Stripe-vs-`user_settings` subscription compare.
11. **Log MCP tool calls and the OAuth client** (D9): persist `clientId` from `verifyOAuthCaller` and write one `product_events` row per `runTool` (tool, client, ok, duration). This is the cheapest way to see whether "the funnel" is a funnel.
12. **Record pricing-v2 refusals in `gate_events`** (D1): managed-credit exhaustion, background floor, speech cap, with a `surface`/`route` in `context`.
13. **Rename `/api/track`** to a neutral path (D5) and add a `blocked` counter: a `<noscript>`-free way to estimate ad-blocker loss is to compare `viewersTrend` (needs the beacon) with signed-in `last_active_at` days per account.
14. **Privacy page**: add BotID, the 180 d / 30 d retentions, the Slack feedback snippet, and the waitlist leftover (§5.6 of the audit). S.

Items 1 to 5, 8 and 14 are each S and carry no product-facing risk; 9 touches billing and needs the Stripe smoke.

---

## 1. Phase 1: correctness and exclusions

Goal: every number on an existing page means what its label says, before anyone outside looks at it.

| # | Change | Approach | Files | Effort | Regression risk | How to verify the numbers |
|---|---|---|---|---|---|---|
| 1.1 | `account_kind` + `excludedAccountSql()` | New nullable column (`internal`, `tester`, `comped` derived, NULL = customer); admin toggle on `/admin/users/[id]`; one-off seed from `ADMIN_USER_IDS` and `DEMO_ACCOUNT_USER_ID`; `analytics-internal.ts` becomes the single predicate used by `admin-trends.ts`, `admin-metrics.ts` (`loadAdminUserRows` gains an `includeInternal` flag for the roster), `money-metrics.ts`, `admin-yc-metrics.ts`, `admin-credits.ts`, `admin-interest-list.ts` (email-match exclusion as the funnel already does) | `src/db/schema.ts`, `src/lib/analytics-internal.ts`, the six modules above, `src/actions/admin.ts`, `scripts/migrate.ts` | M | None user-facing; admin roster must still list internal accounts | Probe B1/B2/B4 flip to "not seen"; extend `smoke-growth-trends.ts` with an `ADMIN_USER_IDS` account that must not move DAU; `smoke-admin-aggregates` asserts MRR unchanged by an internal subscription |
| 1.2 | Intentional-action fragment | `writesSince()` → `intentionalActionsSince()` per `TRACKING_PLAN.md` §1.3; keep a `systemActivitySince()` for a separate "touched by sync/AI" line if wanted | `src/lib/admin-trends.ts` (all callers), `src/lib/admin-metrics.ts` `lastWriteAt` | S | None | Probe D1/D2 flip; `smoke-growth-trends.ts:114` (the `external_id` row) must stop counting toward DAU |
| 1.3 | One activation predicate | `activatedSql(userId)` + JS twin; overview funnel reads it; Conversion page reads it; remove the five variants | `admin-metrics.ts:386-415`, `admin-analytics.ts:619-625`, `admin-trends.ts` (`activationTrend`, `workflowStagesTrend`) | S | None | Probe C1/C2 agree; new smoke seeds a tour-only account and asserts 0 on both pages |
| 1.4 | `reminders.completed_at` | Column + three write sites + backfill script (`analytics/` draft) | `schema.ts`, `src/actions/reminders.ts`, `src/lib/reminder-writes.ts` | S | Low: additive column | Smoke: mark done → `completed_at` set; reopen → nulled |
| 1.5 | `ai_key_added_at`, `onboarding_path_chosen_at` | Columns stamped in `applyAiKeyChange`, `startOnboardingPath` | `ai-settings-write.ts`, `actions/onboarding.ts` | S | None | Smoke-ai-settings asserts timestamp on first add only |
| 1.6 | Credit-pack cash in `mrrMovement` | Add the case to `oneTimeCents` and `cashInCents` | `src/lib/billing-events.ts:207-238` | S | None (read side) | New assertion in `smoke-instrumentation-streams.ts`: a `credit_pack` row raises `cashInCents` |
| 1.7 | Churn booked on self-deletion | Book before purge with a deterministic `event_id`; same for admin-initiated deletion | `src/lib/account-deletion.ts`, `src/lib/billing-events.ts` | M | **Medium**: billing path; must not block deletion if the booking fails (swallow + `reportError`) | `smoke-account-deletion.ts` asserts a churn row and Σ ledger == live after delete; drift panel 0 |
| 1.8 | Ledger drift alert + Stripe compare | `billing.ledger_drift` condition; daily job lists Stripe active subscriptions and diffs against `user_settings` (plan, interval, monthly cents, status), posting counts only | `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, new `src/app/api/ops/billing-reconcile/route.ts`, `.github/workflows/ops.yml` | M | None user-facing; needs a Stripe read key in the job | Smoke-ops asserts the condition opens on a seeded drift; `analytics/checks/reconciliation.sql` queries agree with the panel |
| 1.9 | Internal exclusion in comps and "paid" | One `paidAccountSql({ includeComped })` used by funnel, `paidSignupsByChannel`, `gateDemand`, `buildPlanBreakdown` (rename `paidTotal` → `paidOrComped`, add `paid`) | `billing-events.ts`, `money-metrics.ts`, `admin-analytics.ts`, `admin-metrics.ts` | S | None | Smoke seeds a comped, a Lifetime, a subscriber and a refunded buyer; all four readers agree |
| 1.10 | Deepgram priced | Write `inputTokens = seconds` on Deepgram usage rows (as `ai-pricing.ts` already expects) **or** price `speech_usage` in `money-metrics` at $72/M-seconds; include in burn and per-user cost | `src/lib/ai.ts:951-961`, `money-metrics.ts`, `admin-credits.ts:191-200` | S | **Check**: must not enter the managed-credit settlement (`ledger.ts:478` already skips Deepgram; keep it that way) | Smoke: a 600-second row prices at 43 200 micros; credits balance unchanged |
| 1.11 | One managed-AI cost function | `managedCostSql()` used by burn, ops margin, trends; Deepgram handled explicitly | `admin-credits.ts`, `managed-ai-ops.ts`, `admin-trends.ts:667,695` | S | None | Three readers return the same 30-day figure on the smoke fixture |
| 1.12 | One CAC, one window note | Economics and Costs pages share `cacFor(window)`; acquisition spend form takes a month, not "now−30d"; `monthlyCosts` uses `created_at` month | `admin-yc-metrics.ts`, `costs/page.tsx`, `money-costs.ts:80-88`, `economics-forms.tsx` | S | None | Same CAC on both pages for the fixture; a spend row appears in one month only |
| 1.13 | LTV from data | `LTV = ARPA (trailing 90 d, from ledger, per plan mix) × gross margin ÷ observed logo churn (trailing 90 d, min 100 subscriber-months before display)`; keep the typed churn as a labelled override; add payback = CAC ÷ (ARPA × margin) | `admin-yc-metrics.ts`, `admin-yc-calculations.ts`, `yc/economics/page.tsx` | M | None | Pure-function smoke with a seeded ledger |
| 1.14 | Day boundary | Every `date_trunc` in `admin-analytics.ts`, `admin-trends.ts`, `money-metrics.ts` takes `AT TIME ZONE 'UTC'`; `series()` likewise | those files | S | None | Probe F1 under `SET TIME ZONE 'America/Los_Angeles'` stays "not seen" |
| 1.15 | Lifetime tier recorded | Store `price_id` and `tier` in the `lifetime` booking detail; a one-off histogram of `amount_cents` for existing rows; "Lifetime sold" = ledger count net of refunds, "Lifetime holders" separate | `billing-stripe.ts:613-620`, `user-settings.ts:455-462`, `billing/page.tsx` | S | None | Smoke-stripe-webhook asserts tier in detail |
| 1.16 | Dead and stale | Remove `plan_meter_usage` writes or the table; fix the eight stale comments; remove `follow_up_sent_at`, `wizard_step` readers | per audit §4 | S | None | tsc + smoke |
| 1.17 | `error_events.message` scrub | Run `scrubText` before insert and before Slack | `error-events.ts:178`, `request-errors.ts:40` | S | None | `smoke-sentry-scrub` extended |
| 1.18 | Retention for unbounded tables | `cron_runs` 90 d, `webhook_deliveries` 90 d (anonymise Resend recipients at 30 d), `gate_events` 400 d, `email_sends` bodies cleared 90 d after settle (keep status), `interest_list_signups` purged 30 d after invite accepted or on account deletion | `event-prune.ts`, `process-stalled/route.ts`, `user-data.ts` | M | Low; `email_sends` body clearing must keep the thread view working: check `src/components/email/*` reads | `smoke-housekeeping-sweeps` extended per table |

Phase 1 exit test: `analytics/checks/probe-known-distortions.ts` reports 0 of its claims reproduced except A1/A2 (visitor-days are a design property, not a bug), and `analytics/checks/reconciliation.sql` returns zero drift rows on the smoke fixture.

---

## 2. Phase 2: missing activation and funnel events

Goal: the funnel in `TRACKING_PLAN.md` §2.1 is measurable end to end for the first wave.

| # | Change | Approach | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|---|
| 2.1 | `product_events` table + `track()` helper + zod schemas | Schema per `TRACKING_PLAN.md` §4.1; helper in `src/lib/product-events.ts` modelled on `recordUsage` (fire-and-forget via `after()`, swallow, throttle `reportError`); schemas from `analytics/schema/events.ts`; dev/smoke throw on invalid; lint rule forbids bare `z.string()`; prune at 400 d in the ops sweep; purge and `/privacy` entries | `schema.ts`, new `src/lib/product-events.ts`, `analytics/schema/events.ts` → `src/lib/product-event-schemas.ts`, `event-prune.ts`, `user-data.ts`, `data-categories.ts`, privacy page | M | None user-facing | Smoke: invalid property throws in dev; valid row lands with `is_internal` computed; purge removes rows |
| 2.2 | Identity links | `interest_list_signups.join_session_id`, `user_id`, `converted_at`; `user_settings.signup_session_id`, `invite_id`; set in `joinInterestListCore`, `captureAttribution` (read `pv_sid` via a tiny client post on first app load, or accept it as a header from the beacon's first signed-in view), `claimSiteInviteGrant`; Clerk invitation `publicMetadata` carries `interestSignupId` | `interest-list-join.ts`, `attribution-capture.ts`, `site-invites.ts`, `clerk/route.ts` | M | Low | Smoke: join → invite → account chain resolves by ids, not email |
| 2.3 | Activation events | `ai_key_added`, `onboarding_path_chosen`, `onboarding_step_completed`, `capture_saved` (with people counts), `capture_failed`, `capture_discarded`, `followup_set`, `followup_completed`, `chat_question_asked`, `chat_answer_landed`, `chat_answer_failed` | per `TRACKING_PLAN.md` §4.4 | M | None | Each call site has a smoke asserting exactly one row per action (StrictMode and retries covered by deterministic ids where the client originates the event) |
| 2.4 | Monetization events | `checkout_started` with `from_gate` (paywall copy passes `?gate=<feature>` to `/upgrade`), `checkout_abandoned` derived, `subscription_canceled` with reason | `actions/billing.ts`, paywall components, `/upgrade` page | S | Low: query param only | Gate → `/upgrade` → `checkout_started` chain in smoke |
| 2.5 | Gate coverage | Record managed-credit exhaustion, background floor and speech caps as `gate_events` with `context.surface` and route; fill `context` in `requireEntitlement` | `ai-access.ts:679-681`, `speech/token/route.ts`, `stream-token/route.ts`, `entitlements.ts:273` | S | None | `smoke-admin-gate` asserts the three new kinds |
| 2.6 | MCP | `mcp_connected` on first OAuth-verified request per (user, client) and on key creation; `mcp_tool_called` per `runTool`; `client` from Clerk `clientId` / `initialize.clientInfo.name` mapped to a closed enum | `mcp/handle.ts`, `mcp/oauth.ts`, `tools/registry.ts` | M | Low: wrapper around existing handler; must not change tool results | `smoke-mcp-server` asserts one row per call incl. refused |
| 2.7 | Extension | `onInstalled` opens `/dashboard?utm_source=extension&utm_medium=install&utm_campaign=<version>`; `setUninstallURL`; `extension_usage` gains `first_seen_at`, `version`; each action route writes `extension_action` with `site` from the page adapter | `extension/src/background/index.ts`, `src/lib/extension/http.ts`, `/api/extension/*` | M | Low | Smoke: first `/me` sets `first_seen_at` once |
| 2.8 | Failures as events | `import_failed`, `sync_failed`, `email_send_failed`, `error_shown` (client toast of a server failure) | `import-engine.ts` `failImport`, sync runners, `email/outbox.ts`, `report-error.ts` client branch | S | None | Smoke per site |
| 2.9 | Waitlist | `waitlist_shared` from share handlers; count limiter-dropped joins (`interest.join.limited` counter row, no email); welcome send success recorded as a count per day | `components/interest/*`, `interest-list-join.ts`, `interest-list-email.ts` | S | None | Smoke |
| 2.10 | Account deletion event | `account_deleted` with tenure, plan, reason enum; written with `user_id` null before purge | `account-deletion.ts` | S | None | `smoke-account-deletion` |

Phase 2 exit test: a smoke script walks one fake person through join → share → invite → account → key → capture → follow-up set → chat → gate → checkout and asserts every `TRACKING_PLAN.md` §2.1 stage increments by exactly one.

---

## 3. Phase 3: dashboards, digests, alerts

### 3.1 Minimum dashboards per phase

The existing console already has more pages than a solo founder reads. The proposal is **one page per phase**, each with at most eight numbers, built from the definitions in `TRACKING_PLAN.md`, and the existing pages kept as drill-downs.

**Private beta: `/admin/beta` (invite waves and activation)**

| Tile | Definition | Why |
|---|---|---|
| Wave table | per wave: invited, accepted (7 d), accounts, AI-ready (24 h), captured (7 d), **activated (7 d)**, week-2 return, as counts with fractions | the go/no-go table |
| Activation by path | capture-first vs import-first vs tour, rolling 4 weeks | the onboarding lever |
| First cliff | share of accounts ≥24 h old with no AI key and no managed credit use | bring-your-own-key friction |
| Failures touching users this week | distinct accounts with a capture, import, sync, voice or AI failure | fix list |
| Feedback this week | count by category, with the three newest `bug` rows | qualitative pulse |
| WAN | this week vs last, with the DAU/WAN line | north star |

**Launch: `/admin/launch` (acquisition and conversion)**

| Tile | Definition |
|---|---|
| Signups by channel | last 7 and 28 days, first-touch channel, invited vs organic |
| Activation by channel | rolling 4 weeks, fractions |
| MCP and extension | connected / first call / weekly return; installs / first action / weekly return |
| Gate hits → upgrade | cumulative since launch by gate, with "reached `/upgrade`" and `checkout_started` → completed |
| Free → paid | activated accounts ≥30 d old who paid, by plan; median time to convert |
| Cost per active account | by plan, this month |
| Error rate | failures per 1k signed-in views, this week vs last |

**Steady state: `/admin/retain` (retention and unit economics)**

| Tile | Definition |
|---|---|
| Retention curves | monthly cohorts, week 1–12, WAN definition |
| Resurrection and going-cold pools | counts, with job-seeker cut |
| Churn | logo count and trailing-90-day rate once ≥100 subscriber-months |
| Gross margin by plan | revenue − attributable cost |
| Heavy-user list | accounts whose month's cost exceeds their revenue |
| LTV, CAC, payback | from phase 1.13 |

Effort: M each, built on the shared fragments from phase 1. Risk none. Verify: each tile has a smoke fixture with a hand-computed expected value, in the style of `smoke-admin-analytics.ts`.

### 3.2 Wave and stealth criteria (measurable thresholds)

Proposed; the numbers are starting points for you to set, not findings.

| Gate | Threshold (all excluding internal/tester accounts) | Minimum sample before the rate counts |
|---|---|---|
| Send the next wave | activated (7 d) ≥ 40 % of the previous wave's accounts **and** accounts affected by a failure this week ≤ 10 % of WAN **and** no open S1 bug in feedback | previous wave ≥ 30 accounts ≥7 d old; otherwise go by counts and judgement, and say so in the wave note |
| Double the wave size | week-2 return ≥ 30 % of activated **and** cost per active account ≤ 50 % of Pro monthly price for free users | ≥ 30 activated accounts in the cohort |
| Turn stealth off | three consecutive waves pass the gate above **and** invite → account ≥ 50 % within 14 d **and** AI-ready within 24 h ≥ 70 % **and** no failure class above 2 % of attempts for two weeks | ≥ 100 accounts total |
| Open paid self-serve publicly | gate → upgrade signal exists (≥ 10 converters) **and** ledger drift alert quiet for 30 d **and** churn booked on deletion verified | ≥ 10 paying accounts |

### 3.3 Digests and alerts

**Weekly digest** (Monday 09:00 in your timezone, posted to `SLACK_OPS_WEBHOOK_URL`, one message, counts with fractions, no percentages under 30): WAN and DAN/WAN; new accounts by channel; activation (7 d) for the cohort that matured; week-2 return for the cohort that matured; failures touching users; gate hits and conversions; MRR, cash in (incl. packs), churn count; cost per active account and the top 3 heavy users by id; feedback count by category with links; the three alerts that opened most. Implementation: `src/app/api/ops/weekly-digest/route.ts` behind `CRON_SECRET`, scheduled in `ops.yml`, recorded in `cron_runs`, reusing the dashboard fragments. Effort M.

**Anomaly alerts**, added to `ops-alerts.ts` so they inherit dedupe, reminders and recovery. Each compares a trailing window with the same window one period earlier and fires on an absolute floor **and** a relative drop, so a quiet Sunday does not page:

| Condition | Rule | Severity |
|---|---|---|
| `product.signups_drop` | 7-day signups < 50 % of prior 7 days and prior ≥ 10 | warning |
| `product.activation_drop` | activation (7 d) for the latest matured weekly cohort < 60 % of the trailing 4-cohort mean and cohort ≥ 20 | warning |
| `product.funnel_break` | a stage with zero events in 48 h while its upstream stage had ≥ 10 (e.g. captures saved = 0 with ≥ 10 accounts created; `checkout_started` > 0 and completed = 0 for 24 h) | critical |
| `cost.ai_spike` | managed AI + Deepgram cost in 24 h > 3× the trailing 7-day daily mean and > $5 | critical (exists for managed AI only: extend to Deepgram) |
| `cost.heavy_user` | one account's 24 h attributable cost > $2 on Free or > its plan's daily revenue × 5 | warning |
| `billing.ledger_drift` | phase 1.8 | warning |
| `quality.failure_rate` | any flow's failures / attempts > 5 % over 24 h with ≥ 20 attempts | warning |
| `tracking.silence` | zero `product_events` or zero page views for 2 h during 08:00–24:00 UTC | critical (catches a broken beacon or a renamed route) |

Routing: warnings to the ops webhook, criticals also to the critical webhook, both already in env. Effort M total. Verify with `smoke-ops-alerts` fixtures per condition.

---

## 4. Phase 4: qualitative loop and experiment practice

### 4.1 Micro-surveys

One component, one table (`survey_answers`: id, user_id, survey_id, question_id, answer enum or 1–5, free text ≤ 280 chars **stored in `feedback`, not in analytics**, shown_at, answered_at, dismissed), one event `survey_answered`, and a per-user rule of at most one prompt per 14 days.

| Moment | Trigger | Question (closed answers) | Ties to |
|---|---|---|---|
| Post-first-capture | first `capture_saved` with ≥1 person, after the review card closes | "Did Orbit get the people right?" yes / mostly / no, plus optional note | activation by path; capture quality |
| Day 7 | first session on day 6–9 for accounts not yet activated | "What stopped you adding your network?" no time / don't have notes / import failed / not sure it's for me / other | activation; onboarding changes |
| First follow-up completed | `followup_completed` | "Was this reminder useful?" yes / too early / too late / wrong person | value metric; nudge timing |
| PMF | day 21–28, activated accounts only, once | "How would you feel if you could no longer use Orbit?" very / somewhat / not disappointed (the existing dead `kind='pmf'` path can be revived for this) | launch readiness |
| Cancellation | `cancelSubscription` and `deleteOwnAccount` | reason: too expensive / not using it / missing feature / privacy / season over / other | churn by reason; the "going cold" pause idea |
| Feedback widget | existing | add `sentiment` (👍 / 👎 / neutral) alongside `category`; make area and category filterable in the console | themes |

Cohort tie: every answer row carries `user_id`, and the dashboard joins to `user_settings` for channel, path, wave, plan and signup week, so "day-7 non-activators who said *import failed*, by wave" is one query. Effort M. Risk low; the prompt must never block a save.

### 4.2 Experiments at this user count

Underpowered A/B tests will produce confident noise. The proposal:

1. **Sequential rollouts by wave** are the default experiment. Each wave is a cohort with a known entry date; compare activation and week-2 return across waves with the change date marked, and expect confounds (different invite sources) to be named in the wave note.
2. **Product-flag holdouts** for features with a plausible retention effect (Radar digest, suggested reminders): `app_surface_flags` already gates surfaces; add a per-account deterministic bucket (`hash(user_id + flag) mod 100`) so a 20 % holdout is stable and reportable. Report counts with the Wilson interval and refuse to call a winner below 50 activated accounts per arm.
3. **Before/after** for pricing and paywall copy, with the caveat printed on the dashboard: trailing 4 weeks vs the 4 weeks before, same channel mix shown next to it.
4. **Qualitative first**: five conversations with day-7 non-activators beat any test at this scale; the day-7 survey above is the recruiting list.
5. **No concurrent experiments on the same funnel stage**, and every experiment gets a one-paragraph entry in `analytics/events/README.md` with start date, flag, hypothesis, and the metric and minimum sample agreed in advance.

---

## 5. Decisions you need to make

1. **Activation definition**: accept "Captured and acted, within 7 days" (`TRACKING_PLAN.md` §1.2), or pick "first capture saved" alone for simplicity. The former is recommended.
2. **North star**: Weekly Active Networkers (recommended) vs follow-ups completed per week.
3. **Account kinds**: who counts as `internal` and `tester` for the beta, and whether comped Pro users count in product metrics (recommended: yes) and revenue metrics (recommended: no).
4. **`product_events` table**: approve adding one append-only telemetry table (400-day retention, deleted with the account, disclosed in `/privacy`), or restrict phase 2 to timestamp columns on existing tables. The table is recommended; the columns alone cannot record refusals, MCP calls or extension installs.
5. **Identity links without a cookie**: approve storing the existing per-tab session id on the waitlist row and the account at the moment of join and first app load.
6. **Booking churn on self-deletion** (1.7): approve a billing-path change, or accept permanent ledger drift and silence the panel.
7. **Deepgram pricing** in burn and per-user cost (1.10): which of the two implementations.
8. **LTV**: replace the typed churn with the trailing-90-day observed rate behind a minimum-sample rule (recommended), or keep the manual input.
9. **Retention periods** for `cron_runs`, `webhook_deliveries`, `email_sends` bodies, `interest_list_signups` after conversion (proposed 90 / 90 / 90 / 30 days).
10. **Third-party scripts**: keep Vercel Web Analytics and Speed Insights (already shipping, disclosed, redacted) or drop Web Analytics now that first-party traffic exists; add BotID to `/privacy` either way.
11. **Wave thresholds** in §3.2: confirm or adjust the starting numbers.
12. **Alert routing**: which of the §3.3 alerts go to the critical webhook.
13. **`/api/track` rename** to reduce ad-blocker loss, and whether to measure the loss first.
14. **Micro-survey cadence**: one prompt per 14 days per user, and whether the PMF question runs in the beta or only at launch.

---

## 6. Implementation status (2026-10-19)

Everything in §0 to §4 is built except the items under "Not done". Schema is at version 171. Run `npx tsx scripts/run-smoke.ts --ci` for the full check; `analytics/checks/probe-known-distortions.ts` is now a regression guard (12 probes, 0 regressions).

### What shipped

- **Phase 1, correctness.** One definition of "active" (`intentionalActionsSince`) and one of "activated" (`activatedSql`) in `src/lib/activity.ts`. Internal, tester, showcase and admin accounts excluded everywhere through `internalAccountSql`. Admin charts bucket by UTC. Feature adoption counts completed use only. Credit packs, refunds, comped accounts and lifetime plans are handled in the ledger; churn is booked when an account is deleted (in-app and on the Clerk `user.deleted` webhook); CAC has one implementation; LTV uses the observed churn rate behind a minimum sample; Deepgram is in burn and per-user cost.
- **Phase 2, events.** Append-only `product_events` (48 events, zod-validated, ids/enums/counts/booleans only, owners listed in `analytics/events/README.md`). Invite ledger (`site_invites`), waitlist-to-account link, signup attribution carried from first visit, tab id saved at join and first app load, MCP and extension telemetry, plan-gate log with `/upgrade?gate=`, reminder `completed_at`.
- **Phase 3, ops.** Alerts for silent jobs, billing drift, error spikes, cost ceiling, and activation or signup drops (`product-alerts.ts`, wired into `ops-alerts.ts`), a daily Stripe reconcile job, retention pruning, scrubbed error text, a weekly digest (Monday cron), and three admin pages: Beta (`/admin/beta`), Launch (`/admin/launch`), Retain (`/admin/retain`). RUNBOOK rows exist for each alert.
- **Phase 4, qualitative.** One-tap micro-surveys (one prompt per 14 days per user, answers stored as events), optional cancellation reason, feedback facets and themes in the admin feedback page, and a holdout helper for experiments.
- **Privacy.** `/privacy` and `/interest/privacy` updated (BotID, retention periods, the saved tab id, product events, Slack feedback excerpt). `TERMS_VERSION` is now `2026-10-19`.

### Assumptions for the 14 decisions (all recommended defaults)

1. Activation = captured and acted within 7 days. 2. North star = Weekly Active Networkers. 3. Account kinds `internal`/`tester`; comped users count in product metrics, not revenue. 4. `product_events` table approved. 5. Tab id stored at waitlist join and first app load. 6. Churn booked on self-deletion. 7. Deepgram in burn and per-user cost. 8. Observed churn behind a sample minimum. 9. Retention 90/90/90/30 days (usage 180, errors 30, product events 400). 10. Vercel Web Analytics and Speed Insights kept, BotID disclosed. 11. Wave thresholds as in §3.2. 12. All new alerts go to the existing Slack ops webhook. 13. Beacon renamed to `/api/p/v`, `/api/track` kept as an alias; loss not measured. 14. Survey cadence 14 days; PMF question runs in the beta.

### Deviations from the plan

- No backfill of `reminders.completed_at`; history before deploy is invisible to completion metrics.
- Feedback sentiment is derived from category rather than classified.
- Surveys store answers as `product_events`, not a table.
- `email_sends` bodies are not pruned.
- On full account purge the waitlist row is anonymised (`email = 'deleted-<id>'`) or deleted rather than kept for 30 days.
- No `onboarding_path_chosen_at` column; the `onboarding_path_chosen` event covers it.
- The typed LTV churn override is per first admin.
- No job-seeker cut of the funnel.

### Not done / known gaps

- Client-side `error_shown` has no hook (it needs an ingest endpoint for browser errors; Sentry already holds them). Calendar subscriptions (`/imports` ICS URLs) have no terminal state, so they cannot record `sync_failed`; the recruiter inbox scans do not either.
- (Closed 2026-10-19: bulk capture now records `capture_saved`; Luma, Eventbrite and event iCal feeds record `sync_failed`; plan guards and API-key and webhook actions pass a `route` to the gate log.)
- `signup_session_id` is accepted only within two days of signup.
- Operator actions: set `STRIPE_SECRET_KEY` for the reconcile job; set `account_kind` for yourself and testers (`scripts/seed-account-kind.ts` or the admin control). Deploying forces every user to re-accept the terms because the version changed.
