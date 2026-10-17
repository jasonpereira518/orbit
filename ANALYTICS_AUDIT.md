# Orbit analytics audit

Date: 2026-10-17. Scope: every table, event, counter, cron, alert and admin view that measures user behaviour or business health, as of commit `bf1b4ae` on `main`. Method: source reading only, plus a seeded probe (`analytics/checks/probe-known-distortions.ts`) run against a throwaway local PGlite database with fake rows. **No production or real user data was queried, and no application code was changed.** Companion documents: `TRACKING_PLAN.md` (what to measure) and `ANALYTICS_PLAN.md` (what to change, in what order).

Severity scale used below: **S1** a decision you would make this month comes out wrong; **S2** a number on a dashboard is materially off but the direction is right; **S3** a number is mislabelled, duplicated or unread; **S4** hygiene. "Reproduced" means the seeded probe demonstrates it on fake data (10 of 12 probes reproduce; the two that did not are noted).

---

## 1. Inventory: what is measured today

### 1.1 Tables that measure behaviour or money

| Table | What it records | Written by (file → function) | Retention | Read by | Excludes internal? |
|---|---|---|---|---|---|
| `page_views` | One row per rendered page view: route **pattern**, daily-salted visitor hash, per-tab session id, signed-in user id, external referrer host, UTM source/medium/campaign, Vercel geo, device class, bot flag, internal flag, dwell ms, load ms | `src/components/analytics/pageview-beacon.tsx` (root layout) → `POST /api/track` (`src/app/api/track/route.ts`) → `src/lib/page-views.ts` `recordPageView` / `recordDwell` / `recordLoad` | 180 d, 5 000 rows per 10-min sweep (`page-views.ts:102-133`) | `src/lib/admin-analytics.ts` (every `/admin/analytics/*` page), `admin-trends.ts` `viewersTrend`, `admin-user-detail` via `accountTraffic` | Yes at read (`pv()` fragment) and partly at write |
| `user_settings` (signup, onboarding, plan, attribution columns) | Account creation time, onboarding path/steps/completion, tour stamps, first-touch `signup_*`, plan/comp/lifetime/subscription mirror, `last_active_at`, `founding_eligible`, `stealth_cleared_at` | Clerk webhook (`src/app/api/webhooks/clerk/route.ts`), `src/lib/user-settings.ts`, `src/actions/onboarding.ts`, `src/actions/tour.ts`, `src/lib/attribution-capture.ts` (first `(app)` render only), `src/lib/presence.ts` | Life of the account; deleted on purge | Every admin page; `admin-metrics.ts` `loadAdminUserRows`, `admin-trends.ts`, `money-metrics.ts`, `admin-yc-metrics.ts` | **No** (only `admin-analytics.ts` filters it) |
| `usage_events` | One row per AI / transcription / embedding call: operation id, provider, model, kind, tokens, estimated or reported cost, key owner (BYOK vs managed), success, error kind, duration | `src/lib/usage-events.ts` `recordUsage` / `withUsage`, called from `src/lib/ai.ts` (10 sites), `ai-tools.ts` (one row **per tool round**), `ai-batch.ts`, `decisions/jev.ts` | 180 d hourly, except managed rows inside an open pool window (`event-prune.ts:64-71`) | Settings usage card, `admin-metrics` rollup + alerts, `admin-trends` (AI cost **and as "activity"**), `admin-health`, `admin-product-health`, `money-metrics`, `managed-ai-ops`, **the managed-pool budget itself** (`ai-access.ts:186-225`), credits settlement | No |
| `gate_events` | A refused plan gate: feature, plan at the time, unlock plan, small jsonb context | `src/lib/gate-events.ts` `recordGateHit` / `recordGateHitThrottled` from `entitlements.ts:273`, `contact-writes.ts:459,669`, `connection-limits.ts:41`, `api/auth.ts:157`, `apollo.ts:181` | **None** | `money-metrics.ts` `gateDemand` → `/admin/billing/demand` | No |
| `billing_events` | The revenue ledger: new/expansion/contraction/churn/reactivation (MRR delta), lifetime/credit_pack/payment/refund (cash), payment_failed; unique on (source, event_id) | `src/lib/stripe-event-processor.ts` → `stripe-fulfilment.ts` → `billing-stripe.ts` `decideStripeEvent`; Clerk `paymentAttempt.failed`; `scripts/backfill-billing-events.ts` | None; `user_id` nulled on purge | `billing-events.ts` `mrrMovement`, `currentMrrCents`, `mrrReconciliation`; `money-metrics.ts`; `admin-yc-metrics.ts`; `admin-analytics.ts` paid stage | No |
| `stripe_processed_events`, `webhook_deliveries` | Idempotency and delivery log for Stripe/Clerk/Resend webhooks | `stripe-event-processor.ts`, the three webhook routes | None; `webhook_deliveries` survives account deletion | `/admin/health`, ops sweep `webhook.invalid_streak` | n/a |
| `plan_upgrade_events` | Celebration queue for plan changes | `src/lib/plan-upgrade-events.ts` | None; deleted on purge | Celebration UI only | n/a |
| `credit_grants`, `credit_accounts`, `credit_holds` | Managed-AI credit balance, holds, settlements; period = Stripe billing anniversary for subscribers, UTC month for free/comped | `src/lib/credits/ledger.ts` | Life of account | Settings, `/admin/billing` credits panel, `managed-ai-ops` | No |
| `plan_meter_usage` | Monthly meter for hosted enrichment | `src/lib/plan-meters.ts` | n/a | **Nothing in production** (cap is 0 on every plan) | n/a |
| `speech_usage` | Deepgram seconds per user and kind (meeting high-water mark per session; short-form per file call or per dictation beacon) | `src/lib/speech-quota.ts`, `ai.ts:970`, `POST /api/speech/usage` | None; deleted on purge | Quota checks, Settings, nightly Deepgram reconcile (`api/ops/speech-usage`) | No; **never priced** |
| `extension_usage` | **One row per user**: rolling 60-s request and AI counters, `last_seen_at` | `src/lib/extension/http.ts` `consumeBudget` on every authenticated extension request incl. `/me` | Overwritten in place | `admin-trends.ts` `featureAdoption` ("Extension" = any row) | No |
| `api_keys.last_used_at`, `rate_limit_buckets` | Key-based API/MCP use (≤1 write/min); per-window counters | `src/lib/api/auth.ts`, `rate-limit.ts` | 2 d idle for buckets | ops `apollo.hosted_cap_hits` only | n/a |
| `interest_list_signups` | Waitlist row: email, first-touch attribution from the `orbit_attr` cookie, share token, referral slug, `referred_by_id`, pass-check counters, unsubscribe | `src/lib/interest-list-join.ts` `joinInterestListCore`; admin event paste | **None** (notice promises deletion after invite) | `admin-interest-list.ts` (growth page, interest-list page), `admin-analytics.ts` funnel stage, `broadcasts.ts` audience | Only in the Conversion funnel |
| `waitlist_poll_votes`, `broadcasts`, `broadcast_recipients` | Feature poll votes; broadcast sends with per-recipient `sent_at`/`error` | `waitlist-poll-votes.ts`, `broadcasts.ts` | None | Growth pages | No |
| `feedback`, `feedback_screenshots` | Freeform widget: text, area, category, status, context (plan, route **with query string**, UA, viewport), screenshots on public-URL Blob | `src/actions/feedback.ts` → `feedback-submission.ts` | None (purge only) | `/admin/feedback` (status filter only), Slack DM per submission | No |
| `chat_messages.feedback`, `recommendation_feedback` | Thumbs on chat answers; Radar card verdicts | `src/actions/chat.ts`, `src/lib/radar/store.ts` | With chat / purge | `/admin/feedback` (chat, no denominator); Radar: **no admin view** | No |
| `error_events` | Closed catalogue of server-side failure sources (OAuth callbacks, Stripe checkout, Resend rejections, AI security, bot check, CSP, slow calls…) with 500-char message | `src/lib/error-events.ts` from ~20 call sites | 30 d hourly | `/admin/health` (7-d counts, raw messages), ops `errors.burst` | No |
| `imports`, `import_job_rows`, `capture_jobs`, `meeting_sessions`, `email_sends` | Domain tables whose `status`/`error` columns are the only record of failed imports, captures, meetings and sends | Their runners | None (`email_sends` holds full bodies forever) | Imports: `admin-health` + ops. **Captures, meetings, email sends: no admin or ops reader of the failed state** | No |
| `cron_runs`, `ops_alert_state` | Job ledger and alert state machine | `cron-runs.ts`, `ops-sweep.ts` | **None** for `cron_runs` (≈700 rows/day) | `/admin/health`, ops sweep | n/a |
| `infra_costs`, `startup_expenses`, `cash_snapshots`, `acquisition_spend`, `fundraising_*` | Manual YC-mode inputs | Admin forms | None | `/admin/billing/costs`, `/admin/yc/*` | n/a |
| `user_settings.estimated_monthly_churn_pct` | Hand-typed churn on **the admin's own row** | `src/actions/admin-yc.ts:154-171` | | LTV | n/a |

Not a table, but measured: **Vercel Web Analytics and Speed Insights** ship on every route from the root layout (`src/app/layout.tsx:84`) with URL redaction (`analytics-redact.ts`); **Vercel BotID** initialises on every page (`instrumentation-client.ts:45`); **Sentry** loads when a DSN is set. These are third-party scripts already in production; see §5.

### 1.2 Admin views and what they read

| View | Source modules | Headline numbers | Notes |
|---|---|---|---|
| `/admin` Overview | `admin-metrics.ts` (`loadAdminUserRows`, `buildFunnel`, `buildPlanBreakdown`, `buildAlerts`), `admin-interest-list.ts` | Money tiles (subscribed, Lifetime sold, comped, BYOK AI spend); "Needs attention" triage; "Activation" mini-funnel (Signed up → Onboarded → Finished setup → First contact → First interaction → 10+ contacts); latest signups | Includes admin and showcase accounts; "First contact" counts tour examples |
| `/admin/analytics` Traffic | `admin-analytics.ts` | Views, visitor-days, sessions, median session, bounce, signed-in share, bots and internal excluded (shown), top pages with dwell, load p50/p75/p95, geo, referrers, UTM sources and campaigns, devices, most active accounts | Honest about visitor-days on screen |
| `/admin/analytics/funnel` Conversion | `admin-analytics.ts` `acquisitionFunnel` | Visitor-days → reached pricing/interest → joined interest list → created account → activated (7-day maturity) → paid (net of full refunds) | Only place internal accounts are excluded from account stages; rates withheld under 30 |
| `/admin/analytics/engagement` | `admin-analytics.ts` | Chat questions, hand merges, graph opened, reached `/upgrade`; imports by provider; captures by source; outreach sent by channel | |
| `/admin/growth` | `admin-trends.ts`, `admin-product-health.ts`, `admin-interest-list.ts` | Accounts, new accounts, DAU/WAU/MAU tiles; accounts over time; "Opened Orbit"; "Did something" (DAU/WAU/MAU); retention by signup month; actions per active account; activation by signup cohort; feature adoption; waitlist stats; workflow stages; consistency; AI cost | **No internal exclusion except "Opened Orbit"**; "active" includes background writes |
| `/admin/growth/interest-list`, `/broadcasts` | `admin-interest-list.ts`, `broadcasts.ts` | Waitlist table, position, referrals, sources (incl. `admin`), weekly trend (no gap fill), broadcast delivery | |
| `/admin/billing` + `/movement`, `/costs`, `/run-cost`, `/demand` | `billing-events.ts`, `money-metrics.ts`, `money-costs.ts`, `infra-costs.ts`, `credits/admin-credits.ts` | Live MRR, ARR = ×12, ledger drift panel, 6-month movement, cash in, contribution, costs, break-even, CAC (one of two), per-user cost distribution, credit liability, gate demand with 30-day "converted" | Credit-pack cash missing from cash tiles (§2.6) |
| `/admin/yc/*` | `admin-yc-metrics.ts`, `admin-yc-calculations.ts` | Burn, runway, growth %, CAC (the other one), LTV (constant ARPU ÷ typed churn), LTV:CAC, fundraising | Rolling 30-day windows, calendar months elsewhere |
| `/admin/health` | `admin-health.ts`, `admin-system.ts`, `admin-providers.ts` | Cron status (2 of 12 jobs), AI failure breakdown (no denominator), error event counts, wedged imports, reauth, provider status | |
| `/admin/feedback` | `admin-feedback.ts`, `admin-chat-feedback.ts` | Feedback list by status; chat thumbs up/down with no denominator | Area/category never filterable |
| `/admin/users/[id]` | `admin-user-detail.ts`, `admin-analytics.ts` `accountTraffic`, `admin-timeline.ts` | Per-account traffic, AI usage, timeline | |

### 1.3 Scheduled work and alerts

All schedules are in `.github/workflows/ops.yml` (Vercel schedules nothing). Analytics-relevant: the 10-minute ops sweep (prunes `page_views`, evaluates ~45 alert conditions in `src/lib/ops-alerts.ts`, Slack via `ops-notify.ts` with dedupe in `ops_alert_state`), the hourly `imports/process-stalled` (prunes `usage_events` 180 d and `error_events` 30 d), the daily Deepgram reconcile (`api/ops/speech-usage`, alerts on >110 % over-report, writes nothing back). There is **no weekly operator digest** and **no product-metric alert** (no sign-up, activation, or funnel condition exists; `ai.managed_spend_spike` is the only cost-spike alert and it excludes Deepgram).

---

## 2. Data-quality findings

### 2.1 Visitor identity, bots, hosts, sessions

| # | Sev | Finding | Evidence | Reproduced |
|---|---|---|---|---|
| T1 | S2 | **"Unique visitors" are visitor-days.** The hash is `sha256(dailySalt : ip : ua)` so one person over N days is N "uniques" and `avgDailyVisitors` is the only honest headcount proxy. The console labels this correctly; the risk is any *new* reader (digest, export, investor deck) relabelling it. | `src/lib/analytics-visitor.ts:53-73`; `admin-analytics.ts:17-24, 45` | A1: one person on three days → `visitorDays +3` |
| T2 | S3 | A session that crosses UTC midnight becomes two visitor-days with one session id, so the "visitor-days per session" relationship is not stable late in the US evening. | same | A2 |
| T3 | S3 | `trafficTrend` buckets with `date_trunc(grain, created_at)` in the **DB session time zone** while the headline uses `AT TIME ZONE 'UTC'`; bars could sum past the headline if the session zone were ever non-UTC. Neon defaults to UTC, so this is latent. | `admin-analytics.ts:264-270` vs `:45` | F1 not reproduced (local session is UTC) |
| T4 | S3 | Bot filtering is a UA regex plus `navigator.webdriver`. Vercel BotID runs on every page but its verdict is **not** written to `page_views.is_bot`. Prefetch and RSC fetches are already excluded because only the rendered beacon counts; `<link rel=prefetch>` of a page does not fire it. | `analytics-bots.ts`; `track/route.ts:296-301`; `instrumentation-client.ts:45` | n/a |
| T5 | S3 | **Stealth-mode and the waitlist host are handled correctly** for routes (`/` on the waitlist host is stored as `/interest`) but the beacon's session id is per-origin `sessionStorage`, so a visitor who moves waitlist host → app host is two sessions and two visitor hashes are not an issue (same day, same IP+UA) but two sessions are. | `track/route.ts:323-334`; `pageview-beacon.tsx:28-40` | n/a |
| T6 | S3 | Signed-in customers who revisit marketing pages were counted as anonymous prospects until the stale-session grace was added; that fix verifies an expired JWT up to 7 days old. Still anonymous: a customer on a second device or after sign-out. The funnel's "visitor-days" stage therefore includes some existing customers. | `track/route.ts:160-191`; `admin-analytics.ts:566-575` | n/a |
| T7 | S4 | The rate limit on `/api/track` is per lambda instance and keyed on raw IP in memory; a campus NAT at 240/min/instance drops real views silently (204). Acceptable, but it is a source of undercount with no counter. | `track/route.ts:44-83` | n/a |

### 2.2 Internal, admin, test, comped and held accounts

| # | Sev | Finding | Evidence | Reproduced |
|---|---|---|---|---|
| I1 | **S1** | **Every Growth-page number except "Opened Orbit" includes admin and showcase accounts**: totals, new accounts, DAU/WAU/MAU, retention curves, depth, workflow stages, consistency, activation by cohort, feature adoption, AI cost. At beta scale the operator's daily use is a visible share of DAU and of every retention cohort. | `admin-trends.ts` `writesSince` (:199-207) has no internal predicate; only `viewersTrend` (:277-280) filters | B1, B2 (admin counted in DAU/WAU and feature adoption) |
| I2 | **S1** | **No money or YC query excludes internal accounts.** The operator's own test subscription counts as MRR, ARR, a `new` subscriber, growth %, CAC denominator and cash-in. | grep of `internal`/`isAdmin`/`ADMIN_USER` in `billing-events.ts`, `money-metrics.ts`, `admin-yc-metrics.ts`, `admin-credits.ts`: no hits | n/a (code reading) |
| I3 | S2 | `/admin` overview funnel and triage include admin and showcase rows; `buildPlanBreakdown.paidTotal` **counts comps as paid** (the comment next to it says a merged number "would flatter itself"). | `admin-metrics.ts:257-380` (no filter), `:429-439` | B4 |
| I4 | S2 | Comped accounts are excluded from live MRR but not from conversion rates, "paid" funnel predicates or product metrics; there is no `account_kind` to say "beta tester" vs "customer" vs "internal". Stealth-held accounts (created but blocked) count in every `user_settings` total. | `billing-events.ts:281`; `site-access.ts:172-214` | n/a |
| I5 | S2 | A comp placed over a still-paying subscriber zeroes live MRR instantly while invoices keep booking `payment` cash and the ledger keeps the +MRR; the drift panel attributes the gap to "a webhook never arrived". | `user-settings.ts:464-523`, `admin-lifetime.ts:52-74`, `billing/page.tsx:138-147` | n/a |
| I6 | S3 | Waitlist stats count the operator's own test joins and `utm_source='admin'` event pastes, which also appear as an "admin" acquisition channel. | `admin-interest-list.ts:423-442, 652-655` | n/a |
| I7 | S3 | Demo seeds insert chat and meeting rows, so the showcase account "adopted" Chat and Meetings. | `demo-data/seed.ts:1087`, `seed-extended.ts:273, 591` | n/a |

### 2.3 Activation and "active" definitions

| # | Sev | Finding | Evidence | Reproduced |
|---|---|---|---|---|
| A1 | **S1** | **"Active" (DAU/WAU/MAU, retention, depth, consistency, came-back) counts machine writes.** `writesSince` unions `usage_events` (nightly Radar, recruiter scan, embedding backfills, relationship digests are `background:true` operations) and all `interactions` including calendar-sync and LinkedIn-import rows. A dormant account with a connected calendar or Radar enabled is "active" every day. | `admin-trends.ts:199-207`; `ai-operations.ts:205-207` (`BACKGROUND_AI_OPERATIONS` exists, unused here) | D1 (calendar row → DAU), D2 (cron AI row → DAU) |
| A2 | **S1** | **"Onboarded / activated" is defined five ways** and two of them disagree on the same account: `isOnboarded()` on `/admin` counts the 8 tour-example contacts as "First contact" and "Onboarded"; the Conversion page, `activationTrend`, `workflowStagesTrend` and `needsOnboarding` exclude them. Both the overview and the Conversion page say "activation" and give different answers. | `admin-metrics.ts:386-390, 394-415` (`counts.contacts` has no `source` filter, `:178-186`); `admin-analytics.ts:619-625`; `onboarding.ts:45-81` | C1, C2 |
| A3 | S2 | `onboarding_completed_at` is **silently backfilled** for any account with a non-tour contact or an import, so it means "has data", not "finished onboarding". Every chart that reads it inherits that. | `onboarding.ts:65-81` | n/a |
| A4 | S2 | "First follow-up completed" cannot be dated: `reminders` has `status='done'` but no `completed_at`; `updated_at` moves on any edit. "AI key added" cannot be dated at all: the key columns have no timestamp. | `schema.ts:1145-1220`; `user-settings` key columns | n/a |
| A5 | S2 | Feature adoption counts intent, not completion: capture jobs at **queue** time, meetings at **start**, drafts at **generation**, imports including failed ones; and `getAiOperationAdoption` counts cron recipients of `radar.*` as "users". | `admin-trends.ts:136-146, 774-797`; `admin-product-health.ts:60-91` | n/a |
| A6 | S2 | Three "active" definitions coexist: writes (`writesSince`), page views (`viewersTrend`), and `last_active_at` presence (15-min throttled stamp, no history). The Users roster uses the third. | `admin-trends.ts:194-196`; `presence.ts:40-46`; `user-settings.ts:82-110` | n/a |
| A7 | S3 | **Survivorship**: account deletion purges `user_settings`, so "Accounts over time" and every cohort retroactively shrink and churn is recorded nowhere. | `userTotalsTrend` comment `admin-trends.ts:221-226` | E1 (past "added" bars drop by one after a delete) |

### 2.4 Duplicate, missing and lost events

| # | Sev | Finding | Evidence |
|---|---|---|---|
| D1 | S2 | **Refusals leave no row**: a credit-exhausted or key-less AI attempt throws before `withUsage`, so neither `usage_events` nor `gate_events` sees the pricing-v2 money moment (`managed_limit`, background floor, speech-cap 402s). `requireEntitlement` gates write an empty `context`. | `ai.ts:573` precedes `:581`; `ai-access.ts:679-681`; `speech/token/route.ts:70-76`; `entitlements.ts:273-278` |
| D2 | S2 | Cached AI results skip `usage_events` entirely (extension parse/starters, recruiter scan, follow-up drafts, web research), so those features' use is under-counted and their failures invisible. | `ai-result-cache.ts:1-60`; `conversation-starters.ts:689-692`; `parse-profile.ts:96-97` |
| D3 | S2 | Deepgram file transcription writes **both** a `usage_events` row (null cost) and a `speech_usage` row; `aiCalls` and the ≥25 % failure alert count transcriptions as AI calls; one chat answer is N rows (per tool round) in every "calls" metric. | `ai.ts:958, 970`; `ai-tools.ts:111-130`; `admin-metrics.ts:511-520` |
| D4 | S3 | No idempotency on `usage_events`/credit settlement: a batch job re-polled after a crashed apply re-records and re-charges; concurrent meeting chunk uploads can transcribe twice. Low frequency, touches the credit ledger. | `ai-batch.ts:435-454`; `ai-batch-apply.ts:142`; `meeting-sessions.ts:527` |
| D5 | S3 | Page-view beacons are fire-and-forget with no retry and `dwell`/`load` can only update a row that landed; ad-blockers that block `/api/track` (EasyPrivacy lists generic `/api/track` patterns) silently remove whole visits. There is no counter for dropped beacons. | `pageview-beacon.tsx:113-139`; `page-views.ts:7-11` |
| D6 | S3 | Rate-limited real waitlist joins receive a plausible fake ticket and **no row**; welcome and tier emails write nothing on success. "How many welcomes went out this wave" is unanswerable. | `interest-list-join.ts:129-135, 96-109`; `interest-list-email.ts:458-510` |
| D7 | S3 | `pass_check_count` counts the join itself (the effect fires right after the ticket appears), so "came back to look" is +1 for every web joiner. | `interest-hero.tsx:146-150` vs `schema.ts:4625-4630` |
| D8 | S3 | Shares are stored only in `localStorage` (`waitlist-pass-invites`); copies are never counted. Referral is inferred from `referred_by_id` alone. | `pass-invites.ts:113, 123, 203-206` |
| D9 | S3 | **Nothing is recorded for MCP OAuth callers** (claude.ai / ChatGPT): no connection row, no tool-call log, the Clerk `clientId` is discarded. Only key-based callers touch `api_keys.last_used_at` (≤1/min). Installs, first tool call and weekly returning MCP users are not computable. | `mcp/handle.ts:118-126`; `mcp/oauth.ts:128-129, 149`; `tools/registry.ts:215-227` |
| D10 | S3 | The extension has no install event: `onInstalled` opens `/dashboard` with no marker; `extension_usage` is one overwritten row per user with no first-seen, version or site. | `extension/src/background/index.ts:25-29`; `extension/http.ts:109-156`; `schema.ts:5401-5412` |
| D11 | S3 | React StrictMode double-mounts are prevented in production by the client-generated id + `onConflictDoNothing`; locally they are routed to PGlite only. Good. The `load` beacon is first-write-wins and `dwell` is monotonic max, so retries cannot inflate. | `page-views.ts:30-37, 54-66, 83-96` |

### 2.5 Attribution gaps

| # | Sev | Finding | Evidence |
|---|---|---|---|
| U1 | **S1** | **First-touch attribution does not cross the waitlist host.** `orbit_attr` is a host-only cookie; an invited user lands on the app host with no cookie and is written as `direct`. Nothing copies `interest_list_signups.utm_*` onto `user_settings` at conversion. For an invite-wave launch, `paidSignupsByChannel` will read almost entirely "direct". | `proxy.ts:102-108` (no `domain`); `attribution.ts:73-75`; `interest-list-join.ts:181-185` |
| U2 | S2 | Attribution is written only on the first `(app)` render inside `after()`, never in the Clerk webhook; API/MCP/extension-only accounts stay `signup_attributed_at IS NULL` ("unattributed") forever. | `(app)/layout.tsx:90`; `attribution-capture.ts:112-126` |
| U3 | S2 | The proxy's first-touch capture lacks the round-trip host filter the beacon has, so an OAuth callback can become `signup_referrer = 'accounts.google.com'`. | `proxy.ts:89-97` vs `track/route.ts:132-157` |
| U4 | S2 | Waitlist → account is **email equality only**; `user_settings.email` is written by the webhook alone. A different sign-up email, a missed webhook, or an account deletion each turn a converted member back into a "Waiting" broadcast recipient. There is no `converted_at`. | `admin-interest-list.ts:151-154`; `clerk/route.ts:88-89`; `user-data.ts` (no waitlist reference) |
| U5 | S2 | **There is no Orbit-side invite ledger.** Invites live in Clerk (admin list capped at 25) plus `admin_audit_log` text rows; the account gets only `founding_eligible`. Invite → account per wave is reconstructable only by audit timestamp × email. | `site-invites.ts:117, 217-227, 393-404`; `admin/access/page.tsx:48-54` |
| U6 | S3 | Stripe checkout carries `client_reference_id` and plan metadata but no channel; paid-by-channel works only through `user_settings` first touch, which U1 breaks. | `actions/billing.ts:112-123` |
| U7 | S3 | First-touch is "first *signal*": a direct first visit sets no cookie, so a later UTM visit becomes first touch. `signup_utm_medium`, `signup_utm_campaign`, `signup_landing_path` and `channelOf()` are written and never read. | `attribution-parse.ts:223-225`; `attribution.ts:78-87` |
| U8 | S3 | Share links carry no UTM; `/waitlist/<slug>` and `?ref=` resolve referrals, but an unknown slug silently loses the referral. | `share-row.tsx:36,79,108`; `interest/page.tsx:263-273` |

### 2.6 Money, windows, backfills and definitions that differ

| # | Sev | Finding | Evidence |
|---|---|---|---|
| M1 | **S1** | **Credit-pack cash is dropped from every "cash in", "one-time", contribution and net-cash figure**: `mrrMovement`'s switch has no `credit_pack` case, while the Money, Movement and YC Revenue tiles say they include packs. Under pricing v2 packs are a primary one-time line. | `billing-events.ts:207-238` (verified: cases are new/expansion/contraction/churn/reactivation/lifetime/payment/refund/payment_failed); `billing/page.tsx:165-168`; `movement/page.tsx:77-81` |
| M2 | **S1** | **Account self-deletion leaves permanent ledger drift**: `deleteOwnAccount` cancels Stripe then purges `user_settings` immediately; when `customer.subscription.deleted` arrives there is no row, `beforeCents = 0`, no churn is booked. Ledger MRR and growth stay overstated; the drift panel blames a dropped webhook. | `account-deletion.ts:77-88` (verified order); `stripe-fulfilment.ts:78-86` |
| M3 | **S1** | **LTV is a constant** ($8.99 Pro list ÷ a churn % typed into the signed-in admin's own `user_settings` row). Ignores Max, annual, founding discounts, Lifetime, margin and observed churn. No payback period exists. | `admin-yc-metrics.ts:184-197`; `actions/admin-yc.ts:154-171` |
| M4 | S2 | **Deepgram is $0 in every money view**: usage rows carry no seconds-as-tokens so `estimated_cost_micros` is null; `managed-ai-ops` excludes Deepgram; `speech_usage.seconds` is never multiplied by the $72/M price that `ai-pricing.ts` defines. Runway and contribution omit all speech spend. | `ai.ts:951-961`; `ai-pricing.ts:102-108`; `managed-ai-ops.ts:22-26` |
| M5 | S2 | Managed-AI "burn" and the ops margin alert use different cost functions (`coalesce(cost,0)` incl. Deepgram vs `managedCostSql()` with stand-ins excl. Deepgram). | `admin-credits.ts:191-200` vs `managed-ai-ops.ts:42-48`, `ai-access.ts:528-540` |
| M6 | S2 | **CAC is computed two ways on adjacent pages** (Economics: spend by `created_at` ÷ ledger `new` rows, rolling 30 d; Costs: spend by period overlap ÷ accounts created in 30 d with any MRR row ever), and "paid" has four predicates (`paidSignupsByChannel` MRR-only, funnel incl. Lifetime net of refund, `gateDemand` 30-day MRR, `buildPlanBreakdown` incl. comps). | `admin-yc-metrics.ts:161-197`; `costs/page.tsx:44-82`; `money-metrics.ts:309-316, 411-437`; `admin-analytics.ts:627-652` |
| M7 | S2 | Acquisition spend is double-counted across adjacent calendar months (the form always writes a 30-day period ending now; `monthlyCosts` uses overlap) and omitted from Runway burn entirely. | `money-costs.ts:80-88`; `economics-forms.tsx:19-26`; `admin-yc-metrics.ts:74` |
| M8 | S2 | Runway is static and gross: cash is the last typed snapshot, never reduced by burn or increased by revenue; infra silently reuses the newest of the last 3 months. | `admin-yc-metrics.ts:55-69` |
| M9 | S2 | Lifetime intro ($25) vs standard ($75) is recoverable only from `amount_cents` (tax-inclusive); no price id or tier flag is stored; the referenced `lifetime-offer.ts` does not exist; "Lifetime sold" is a current-holder count that drops after refunds. | `billing-stripe.ts:597, 613-620`; `plan-limits.ts:36-41`; `user-settings.ts:455-462` |
| M10 | S3 | Null `subscription_monthly_cents` falls back to the legacy $5.00 in `currentMrrCents` and `billing-stripe.ts` but to a tier-aware value in `revenueAtRiskCents`; Movement copy still explains "$5/mo becomes $4.17/mo". | `billing-events.ts:57`; `billing-stripe.ts:813`; `money-metrics.ts:397`; `movement/page.tsx:106-108` |
| M11 | S3 | Backfilled MRR rows replay subscriptions at **today's** price and only as new/churn; backfilled refunds have `user_id = null`, so per-user "fully refunded" tests cannot see them. | `scripts/backfill-billing-events.ts:229, 250-254, 313-349` |
| M12 | S3 | `past_due` subscriptions count at full value in live MRR; non-USD invoices book at $0 with `detail.unconverted` that nothing reads. | `billing-events.ts:59`; `billing-stripe.ts:907-930` |
| M13 | S3 | **Window vocabularies**: Money = UTC calendar months; YC = rolling 30 days from request time; week grain in `mrrMovementSeries` = rolling 7×24h; credits = Stripe anniversary; speech and plan meters = UTC month; provider pools = vendor reset day; ops spend = rolling 30 d. Settings can show credits and minutes resetting on different dates, and "this month" on Money ≠ "30d" on YC by design. | `money-metrics.ts:51-62`; `admin-yc-metrics.ts:29`; `credits/ledger.ts:79-113`; `speech-limits.ts:57-61`; `managed-ai-policy.ts:53-56, 228` |
| M14 | S3 | Tiles use rolling `now() - interval` while charts use calendar buckets (`generate_series(date_trunc(grain, now()) …)`), so a tile and its chart never reconcile exactly; `interestListTrend` has no gap fill while every `admin-trends` chart does. | `admin-trends.ts:177-187, 352-388`; `admin-interest-list.ts:384-407` |

### 2.7 Reconciliation

| # | Sev | Finding | Evidence |
|---|---|---|---|
| R1 | S2 | The only drift check is ledger Σ`mrr_delta_cents` vs live `currentMrrCents`, rendered as a panel; **no ops alert fires on it** and no job compares Stripe's live subscriptions to `user_settings` or the ledger. `scripts/report-pricing-v2-accounts.ts` prints both sides without joining them. The launch plan's "B3 missed-webhook reconciliation" has no implementation. | `billing-events.ts:367-384`; `ops-alerts.ts` (no `mrr|ledger|billing` condition); `docs/superpowers/plans/2026-09-15-launch-p2-money-and-deletes.md:8` |
| R2 | S2 | Funnel "Paid" (`acquisitionFunnel`) and Money "Subscribed" count different populations by construction (per-account net of refund incl. Lifetime, vs live plan mirror excl. comps), so they are not expected to match and nothing says so on screen. | `admin-analytics.ts:627-652`; `admin-metrics.ts:429-439` |
| R3 | S3 | Credits reconciliation (`packsBooked === packGrants`) exists; nothing reconciles `speech_usage` to Deepgram's report beyond a Slack line; nothing reconciles `page_views` signed-in viewers to `user_settings` (orphan user ids after purge are nulled, fine). | `admin-credits.ts:182-186`; `api/ops/speech-usage/route.ts:191-233` |

`analytics/checks/reconciliation.sql` holds draft queries for R1–R3 that would alarm on drift (see `ANALYTICS_PLAN.md` phase 1).

### 2.8 Small-sample honesty

What exists: `MIN_RATE_DENOMINATOR = 30` and `formatRate()` withhold percentages under 30 observations and print "9 of 14" everywhere in the console (`src/lib/format-rate.ts`); retention curves draw only fully elapsed weeks; the Conversion page uses a 7-day maturity rule. These are good and should be kept.

Where percentages would still mislead at ~1 000 accounts:

- **Activation by channel / by path** (`TRACKING_PLAN.md` F13 cuts): most channel × week cells will have fewer than 30 accounts. Rule: compute on rolling 4-week cohorts, show the fraction, and add a Wilson 90 % interval in the tooltip once n ≥ 30; below 30 show counts only.
- **Gate → upgrade within 7 days**: converters per gate per week will be single digits for months. Rule: report cumulative since launch with the date range printed, never weekly.
- **Churn rate**: with ≤100 subscribers, one cancellation is a 1–2 point move. Rule: report count of cancellations and the trailing-90-day rate, and never a monthly rate until ≥100 subscribers at period start.
- **Chat thumbs**: has no denominator today (§2.4 of the feedback report); even with one, rated answers are a biased sample. Rule: show "rated / answered" alongside "up / rated".
- **Retention week N**: cohorts are monthly today; weekly signup cohorts (as proposed) will often be <30. Rule: keep monthly cohorts for the curve and use weekly cohorts only for the wave gate, where the whole wave is one cohort.
- **Any A/B comparison** at this scale is underpowered; see `ANALYTICS_PLAN.md` §4.

---

## 3. What is already reliable

- **The traffic pipeline is well built**: server-side route normalisation to a closed pattern list, no raw paths or ids, no query strings, external-referrer-only on the landing view, round-trip hosts (Google, Stripe, Clerk) excluded, daily-salted hash with fail-closed salt, geo at city granularity never joined to users in the UI, idempotent inserts and monotonic dwell, bots flagged not dropped, internal browsers opted out, preview deployments never record, 180-day retention, and a smoke test that asserts route coverage against the filesystem. The console labels visitor-days honestly and withholds thin percentages.
- **The ledger's idempotency** (`(source, event_id)` unique, `stripe_processed_events` written only after apply, stale-event guard, bookings-before-mirror order) is sound; annual plans normalise to monthly correctly and founding discounts are booked as expansion when they lapse; Lifetime never enters MRR.
- **`usage_events`** captures success *and* failure with a stable `error_kind`, provider, model and key owner, and is the only reason AI cost by operation is knowable.
- **The gate log** records refusals with plan and unlock plan and can be joined to upgrades by user id.
- **The feedback widget** is careful: closed `area`/`category` vocabularies, magic-byte screenshot sniffing, owner-or-admin proxying, no IP, Slack DM.
- **Retention curves** report only fully elapsed weeks; **the Conversion funnel** uses a maturity window; **both** refuse to draw a cohort that cannot have converted yet.
- **Purge coverage** is broad (`DATA_CATEGORY_META` drives both export and deletion), page views are anonymised rather than deleted, and the export strips hashes and secrets.
- **Ops alerting** has a real state machine with dedupe, reminders and recovery, and the GitHub Actions scheduler fails loudly when unconfigured.

---

## 4. Tracked but never read, read but not reliably written, computed twice

**Written, never read**: `plan_meter_usage` (whole table; caps are 0), `gate_events.context` and `unlock_plan`, `usage_events.duration_ms` and `cached_input_tokens`, `usage_events.cost_source` (never grouped), `speech_usage.request_id`, `extension_usage.ai_count`, MCP OAuth `clientId`, `agent_send_requests.client_name` (card only), `billing_events.detail.{unconverted, foundingOffCents, priceId, stripeStatus}`, `user_settings.subscription_interval` ("display only", no display), `signup_utm_medium`, `signup_utm_campaign`, `signup_landing_path`, `interest_list_signups.landing_path`, `page_views.utm_medium`, `channelOf()`, `follow_up_sent_at` (only ever reset), `feedback.context.contactOk`, `feedback.area`/`category` (no filter), `recommendation_feedback` (no admin view), `email_sends.failure_kind` (per-account bell only), `capture_jobs.status='failed'`/`error`, `meeting_sessions.digest_error`, `cron_runs` for `email.drain`, `connectors.outbox`, `credits.notices`, `cloud-notes.run` (no alert), `stripe_processed_events.event_type`, `ERROR_SOURCES.searchPgvector` (declared, no writer), the PMF/churn-reason helpers in `src/lib/feedback.ts` (no production caller, nothing writes those kinds), `LIFETIME_INTRO_SEATS`/`LIFETIME_STANDARD_PRICE`, `acquisition_spend.period_*` (always now−30d..now).

**Read, not reliably written**: `onboarding_completed_at` (backfilled), `wizard_step` (legacy), `user_settings.email` (webhook only, yet the join key for conversion and broadcast suppression), `signup_attributed_at` (first `(app)` render only), `founding_eligible` (webhook + onboarding backstop), `last_active_at` as activity, `speech_usage` short-form (beacon, no dedupe), `usage_events` for cached ops, `api_keys.last_used_at` (1/min, key callers), `infra_costs` (manual, silently reused), `cash_snapshots` (static), `estimated_monthly_churn_pct` (per admin), `billing_events.user_id` after purge or backfill (null), `countLifetimePurchases` as "sold", `payment_failed` mixing Clerk attempts, Stripe invoice failures and opened disputes, `startCronRun` returning `id:null` turning a job that ran into a "missed" alert, `usage_events` itself (fire-and-forget inside `after()`).

**Computed two or more ways**: "active" (3), "onboarded/activated" (5), "paid" (4), CAC (2), monthly cost (Runway burn vs `monthlyCosts`), managed-AI cost (3), MRR (live vs ledger, intentional, reconciled on one page), null-price fallback (2), `resolvePlan` in SQL (2) vs TS, Stripe fee estimate (2), `USAGE_EVENT_RETENTION_DAYS` (defined twice), `monthWindow` (3 copies), wedged-import and needs-reauth counts (health page vs sweep), error counting windows (3), IP extraction order (`client-ip.ts` XFF-first vs `track/route.ts` real-ip-first), referrals (live still-waiting vs all rows), "converted" waitlist predicate (3 files), feature adoption by table vs by AI operation, tiles rolling vs charts calendar.

**Stale comments that will mislead the next reader**: `ai-pricing.ts:102-107` (Deepgram seconds as tokens, not done), `process-stalled/route.ts:47` ("usage_events is write-only", Settings reads it), `gate-events.ts:28-30` (speech is not a gate feature), `schema.ts:3625-3630` and `ai-pricing.ts:9-13` (managed AI "Lifetime only", pricing v2 made it every plan), `plan-limits.ts:36` (references a deleted file), `schema.ts:4459-4462` (feedback area/category "a GROUP BY in the console", there is none), `schema.ts:4625-4630` (`passLastCheckedAt` null means never came back, false for web joins), `movement/page.tsx:106-108` ($5 → $4.17).

---

## 5. Privacy and compliance

### 5.1 Content that analytics tables hold

Verified **clean** (ids, enums, counts, hashes only): `page_views` (route pattern, host-only referrer, UTMs ≤512 chars, geo, hashed visitor), `usage_events` (no prompt/output; `error_kind` is a code), `gate_events.context` (contactLimit/bulk/refused/provider/surface/monthly at every writer), `speech_usage`, `credit_*`, `extension_usage`, `rate_limit_buckets`, `billing_events` (Stripe object ids and reason codes only; no names, emails, card data), `stripe_processed_events`.

**Holds personal or free text, and is read by analytics or ops surfaces**:

- `feedback.context.route` keeps the **query string** (`sanitizePath` strips only the fragment), so `?q=<search terms>` or `?contact=<id>` can land in feedback context (`feedback-submission.ts:174-181`); `context.userAgent` is raw.
- `error_events.message` is 500 chars of **unscrubbed** provider or system text, shown verbatim on `/admin/health` and in Slack; `sentry-scrub.ts` applies only to Sentry (`error-events.ts:178-179`; `health-live.tsx:606`).
- `webhook_deliveries.detail.recipients` holds **email addresses** for Resend events, indefinitely, and survives account deletion (`webhooks/resend/route.ts:153-158`; `user-data.ts:170-173`).
- `admin_audit_log.detail.excerpt` stores 120 chars of the user's feedback prose on every triage, never purged (`actions/admin.ts:957-961`).
- `interest_list_signups` holds email, names, referrer host and UTMs with **no retention** and is **not touched by account deletion**, contrary to the waitlist notice's "until early access opens and your invite has been sent" (`interest/privacy/page.tsx:60-62`).
- `email_sends` holds full `to/cc/bcc/subject/body` forever (user content in an ops-shaped table; no admin reader, no retention).
- `ai_result_cache.result` holds full model outputs per user (90-day prune); `agent_send_requests.body` holds agent-written text. Neither is analytics, but both sit next to it.
- `referral_slug` publishes the email local part at `/waitlist/<slug>`.

Nothing in the analytics path stores note contents, contact names, email bodies, LinkedIn data or AI prompts/outputs. Signed-in page views **are** linked to the account, and `/privacy` says so.

### 5.2 IP handling

No column stores a raw IP. `page_views.visitor_hash` uses a daily-rotating salt; rate-limit buckets use a **static** salt (`sha256("ratelimit:" + salt + ip)`), pruned after 2 idle days (`client-ip.ts:21-24`); the `/api/track` abuse map holds raw IPs in instance memory only; log tags are an HMAC prefix. Two extraction orders exist (`client-ip.ts` XFF-first vs `track/route.ts` real-ip-first); on Vercel both resolve the same, elsewhere the first is spoofable. Geo is stored at city level and never joined to users in the UI. Feedback and bot-check rows deliberately omit IP; Sentry has `sendDefaultPii:false`.

### 5.3 Cookies and "cookieless"

The traffic pipeline sets no cookie; identity is a daily hash plus a per-tab `sessionStorage` id. Two first-party cookies do exist and are disclosed: `orbit_attr` (httpOnly, 90 d, referrer host + UTMs + landing path) and `wp_voter` (httpOnly, 1 y, poll only). The proposals in `TRACKING_PLAN.md` add **no** cookie and no persistent anonymous id; they add two session-id columns that reuse the existing per-tab id. The cookieless claim holds.

### 5.4 Retention, deletion, export

Retention exists for `page_views` (180 d), `usage_events` (180 d), `error_events` (30 d), `rate_limit_buckets` (2 d), `data_purge_runs` (30 d). **None** for `gate_events`, `cron_runs` (~700 rows/day), `webhook_deliveries`, `email_sends`, `feedback`, `interest_list_signups`, `billing_events` (acceptable, financial), `plan_upgrade_events`, `speech_usage`, `admin_audit_log` (acceptable, audit).

Account deletion deletes `usage_events`, `extension_usage`, `error_events` (user-keyed), `gate_events`, `plan_upgrade_events`, `speech_usage`, `feedback` + screenshots, `email_sends`, `recommendation_feedback`; anonymises `page_views.user_id` and `billing_events.user_id`; leaves `webhook_deliveries`, `admin_audit_log`, `interest_list_signups`. Export covers the same registry plus `billing_events`, stripping hashes, tokens and blobs. The waitlist row is the one personal-data leftover with no justification.

### 5.5 Third parties actually shipping

`@vercel/analytics` and `@vercel/speed-insights` load on **every** route (marketing, app, admin, waitlist host) from the root layout, with URL redaction; admin and API events are dropped but the scripts still load. Vercel BotID initialises on every page. Sentry loads when a DSN is set (replay off, 10 % tracing, scrubbing on URL, message, exception values, string extras). The brief says "stay first-party unless there is a strong reason": these are already present and disclosed, except BotID.

### 5.6 Disclosure gaps for `/privacy`

1. **Vercel BotID** is not named anywhere (not in processors, not under analytics).
2. Retention of `usage_events` (180 d) and `error_events` (30 d) is not stated; only photos, attachments, page views and backups are.
3. "A few operational counters keyed by that same id" understates `webhook_deliveries` (recipient emails) and the audit log's feedback excerpts surviving deletion.
4. The waitlist row is not deleted by account deletion and the waitlist notice's retention promise is not implemented.
5. Slack receives feedback text snippets, not only "job status, route names and error messages".
6. Minor: feedback screenshots sit on public-access Blob URLs (unguessable); Sentry's 10 % performance tracing.
7. If the proposals are adopted: a `product_events` table (named, retention 400 d, deleted with the account), the two session-id columns, `account_kind`, and a `reminders.completed_at` column need one added sentence each; micro-surveys need a line under feedback.

---

## 6. What could not be verified, and why

- **Actual volumes and distributions** (how much of DAU is internal, how many Lifetime buyers paid $25 vs $75, how many waitlist rows are unmatched): no database was available and the brief forbids production reads. Every S1 above is a code-path fact; its *magnitude* is unknown.
- **Neon's session time zone**: assumed UTC (driver default); T3 and the `date_trunc` family are latent only if that assumption is wrong. The probe's local PGlite session is UTC.
- **Timing of Stripe's `customer.subscription.deleted` relative to the purge** in M2: the code order makes drift certain whenever the webhook arrives after `purgeUserData`, which is the normal case for an asynchronous webhook, but I could not observe a real event.
- **Ad-blocker impact on `/api/track`**: not measured; the path name matches common list patterns. A rename to a neutral path is proposed.
- **Batch re-poll double-charging** (D4): the code path exists; whether providers return "ready" again on re-poll was not exercised.
- **Whether `@vercel/analytics` is a no-op outside Vercel production**: vendor behaviour, not verified here.
- **Extension telemetry**: the extension's own API client file could not be mapped call-by-call from the repo grep; server-side evidence (`consumeBudget` on every route) is sufficient for the findings.
- The smoke suite's `npm ci` fails on this checkout (lockfile out of sync on `utf-8-validate`); dependencies were installed without touching the lockfile to run `smoke-admin-analytics` (passes) and the probe. No application file was modified.
