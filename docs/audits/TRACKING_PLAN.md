# Orbit tracking plan

Status: **implemented** (see `ANALYTICS_PLAN.md` §6 for deviations and gaps). The definitions here are the ones in code: `src/lib/activity.ts`, `src/lib/product-event-schemas.ts`. It is the metric tree, the event taxonomy, the identity model, and the ranked list of events Orbit does not record today. `ANALYTICS_AUDIT.md` is the evidence; `ANALYTICS_PLAN.md` is the order of work.

Conventions used throughout:

- **Source of truth** is a domain table wherever one exists. Events are added only where behaviour leaves no row today (an install, a refused action, a click that did not become data), or where the row's timestamp is unreliable.
- Every rate prints its fraction and is withheld below `MIN_RATE_DENOMINATOR` (30), which `src/lib/format-rate.ts` already enforces for the console. New dashboards inherit the rule.
- "Account" means a `user_settings` row that is **not internal** (see §3.4). Every metric below excludes internal accounts by default unless it says otherwise.
- Days are UTC. Weeks start Monday 00:00 UTC. A user's own timezone matters for product features, not for the operator's counts; the one exception is noted under "going cold".

---

## 1. North star and activation

### 1.1 Candidate evaluation

| Candidate | Derivable today? | Problems with it as *the* activation signal |
|---|---|---|
| First capture saved | Yes: `capture_jobs.status = 'saved'`, `created_at`. Also `note_batches`. | Measures *trying*, not value. A pasted test note counts. Misses the import-first path (LinkedIn CSV, Google contacts), which is the first act for many. |
| 10+ contacts | Yes, but polluted: `contacts` count includes the 8 tour-example people (`contacts.source = 'tour-example'`), and one LinkedIn import yields hundreds instantly. | Says "imported", not "uses". Inflated by the tour. Free cap is 500, so the number says nothing about intent to pay. |
| First follow-up completed | Weakly: `reminders.status = 'done'` exists, but there is **no `completed_at` column**; `updated_at` moves on any edit. | The best *value* signal Orbit has, but it lags by days to weeks and cannot be dated today. Wrong as a 7-day activation gate; right as a value metric once timestamped. |
| First chat answer | Yes: `chat_messages` with `role='assistant'` after a `role='user'` row. | Only meaningful once there is a network to ask about. Many habitual users (reminder-driven) may never chat. Strong for the job-seeker "who do I know at X" use case. |
| Week-2 return | Yes in shape (`workflowStagesTrend` "came back"), but today "return" includes background writes (calendar sync, nightly Radar AI calls) and internal accounts. | Lagging 14 days; a retention metric, not an activation one. Needs the "intentional action" fix in §2 before it means anything. |

### 1.2 Recommended activation definition: **"Captured and acted, within 7 days"**

An account is **activated** when, within 7 days of `user_settings.created_at`, both are true:

1. **Own network exists**: at least one contact that is not a tour example, created by a saved capture (`capture_jobs.status='saved'` or a `note_batches` row) **or** a completed import (`imports.status='completed'` with `contacts_created > 0`) **or** a hand-created contact.
2. **One deliberate act on it**: any one of
   - a follow-up set by the user (`reminders` where `created_by = 'user'` or origin explicit, or `scheduleContactFollowUpForUser`), or
   - a chat question asked (`chat_messages.role='user'`), or
   - a second saved capture on a later UTC day than the first.

Rationale:

- Both halves are instant, intentional, and already stored, so the number is available on day 1 of the beta with no new tables. Only the "not tour example" and "user-created" filters need adding to the existing queries.
- The product thesis is capture → nudge. Half 1 is "they gave Orbit their network"; half 2 is "they used Orbit *on* it". Capture alone activates people who paste a test note and leave; the second act is the earliest evidence the loop closed.
- Seven days matches `FUNNEL_MATURITY_DAYS` in `src/lib/admin-analytics.ts`, so the Conversion page and the new definition age accounts identically.
- It is neutral between the two onboarding paths (capture-first and import-first), which the current `isOnboarded` predicate is not.

What it is **not**: a measure of value delivered. That is the follow-up-completed metric in §2.5, which needs a `completed_at` timestamp first.

### 1.3 Recommended north star: **Weekly Active Networkers (WAN)**

**Definition.** Distinct non-internal accounts with at least one *intentional network action* in the trailing 7 days, measured at Monday 00:00 UTC and also as a rolling daily series.

**Intentional network actions** (the closed list; one fragment in SQL, shared by every retention query):

| Action | Table / predicate |
|---|---|
| Capture saved | `capture_jobs.status='saved'` (by `created_at`) |
| Note logged by hand | `interactions` where `note_batch_id IS NULL AND external_id IS NULL AND source IS DISTINCT FROM 'tour-example'` |
| Contact created by hand | `contacts.source IS NULL or 'manual'`, not tour example, not import |
| Follow-up set or completed | `reminders` created with `created_by='user'`; completion needs the new `completed_at` (§4) |
| Chat question | `chat_messages.role='user'` |
| Outreach / email sent | `outreach_messages.sent_at`, `email_sends` user-initiated |
| Import started by the user | `imports` (one per job) |
| MCP tool call from an assistant session | new `mcp_tool_called` event (§4) |
| Extension action (save a person, open a profile) | `extension_usage` rows that are user actions, not background resolves |

**Explicitly excluded**: `usage_events` (AI calls are a consequence, and cron-driven Radar and brief refreshes write them), calendar-sync and LinkedIn-import interactions (`external_id IS NOT NULL`), suggested reminders Orbit generated, page views alone.

Why WAN and not "follow-ups completed per week": at roughly a thousand accounts the weekly completion count will be small, lumpy, and sensitive to one person bulk-clearing a list. WAN is the denominator every other beta question needs (activation rate, retention, conversion, cost per active user), it is robust to a single heavy user, and it already has an honest proxy in `rollingActiveTrend` once the write set is narrowed and internal accounts are excluded. Follow-ups completed per week is kept as the **value metric** directly beneath it.

**Decision it informs**: whether the next invite wave goes out (§6 of `ANALYTICS_PLAN.md` sets the threshold as WAN / accounts invited ≥ 2 weeks ago).

---

## 2. The metric tree

Each row: definition, numerator / denominator, window, cuts, source of truth, and the decision it informs. Cuts marked ★ are the default view; others are available but not on a dashboard.

### 2.1 Funnel, end to end

Stages are counted as **cohorts by the day the person entered the stage**, never as cross-stage attribution of anonymous visitors (the visitor hash rotates daily; see `ANALYTICS_AUDIT.md` §2.1). From "waitlist join" onward every stage has a durable key and conversion between adjacent stages *is* per-person.

| # | Stage | Definition | Num / Den | Window | Cuts | Source | Decision |
|---|---|---|---|---|---|---|---|
| F1 | Visitor-days | Distinct (visitor_hash, UTC day), anonymous, not bot, not internal | count | daily, 7/30/90d | ★route group (landing / pricing / interest), country, device, utm_source | `page_views` | Is top-of-funnel moving at all; which channel to repeat |
| F2 | Intent | Visitor-days that reached `/pricing` or `/interest` | F2 / F1 | same | utm_source, referrer | `page_views` | Landing page copy and CTA changes |
| F3 | Waitlist join | `interest_list_signups` created | F3 / F1 (visitor-days, labelled as such) | daily | ★source (`/interest` form, referral slug, poll), utm | `interest_list_signups` | Whether to keep stealth on |
| F4 | Referral / share | A signup whose `referred_by` is set; shares = distinct referrers with ≥1 referred signup | referred / F3; sharers / F3 | weekly | position band | `interest_list_signups` | Whether the referral loop is worth more product work |
| F5 | Invite sent | Invite created (today: a Clerk invitation plus an `admin_audit_log` row; proposed: a `site_invites` table, per wave) | count; F5 / open waitlist | per wave | ★wave id, source (waitlist / manual) | new `site_invites` | Wave sizing |
| F6 | Invite accepted | Invite claimed by an account (`claimSiteInviteGrant`; today only `founding_eligible` is set) | F6 / F5 | 7 and 14 days after send | wave | new `site_invites` → `user_settings` | Whether invite email / timing works |
| F7 | Account created | `user_settings` created, not internal | F7 / F6 for invited; F7 / F3 for waitlist overall | daily/weekly | ★wave, channel (first-touch), invited vs organic | `user_settings` | Wave pacing |
| F8 | AI ready | Account has either a personal key (`*_api_key_encrypted IS NOT NULL`) **or** managed credits available for its plan | F8 / F7 within 24h and 7d | cohort week | plan, onboarding path | `user_settings`, credit tables | Is bring-your-own-key the first cliff; whether to default more plans to managed AI |
| F9 | First capture or import | §1.2 half 1 | F9 / F7 within 24h, 7d | cohort week | ★onboarding path (capture / import / tour), channel | `capture_jobs`, `imports`, `contacts` | Onboarding redesign |
| F10 | First follow-up set | First `reminders` row with `created_by='user'` | F10 / F9 within 7d | cohort week | path | `reminders` | Whether nudging is discovered |
| F11 | First follow-up completed | First `reminders.completed_at` (new column) | F11 / F10 within 30d | cohort month | path | `reminders` | Whether reminders are actionable or ignored |
| F12 | First chat | First `chat_messages.role='user'` | F12 / F9 within 7d | cohort week | path | `chat_messages` | Whether chat is a core or niche surface |
| F13 | **Activated** | §1.2 | F13 / F7, accounts ≥7 days old only | cohort week | ★channel, path, wave, plan | derived | Go / no-go for next wave |
| F14 | Habit | Account in WAN in ≥3 of the 4 weeks following activation | F14 / F13, accounts ≥35 days old | cohort month | channel, path | derived (`consistentUsersTrend` narrowed) | Launch readiness |
| F15 | Paid | First `billing_events` with `kind in ('new','lifetime')` net of full refund, excluding comps | F15 / F13 (activated), **and** F15 / F7 | 30 and 90 days from signup | ★plan (Pro monthly / annual / Max / Lifetime), channel, last gate hit | `billing_events` | Pricing and paywall placement |

Notes on honesty:

- F3 / F1 and F7 / F1 are *ratios of different populations over the same days*. They are labelled "per visitor-day" on screen and never "conversion rate".
- F6 → F7 is the first truly per-person step. Today it is only knowable by email match; §3 adds the invite claim link.
- F15 excludes comped plans (`comped_plan IS NOT NULL`) from both numerator and denominator by default, with a toggle to include them labelled "incl. comped".

### 2.2 Acquisition by channel

**Channel** is the first-touch tuple on `user_settings` (`signup_utm_source`, `signup_utm_medium`, `signup_referrer`, `signup_landing_path`), collapsed by `channelOf()` in `src/lib/attribution.ts` into a short closed list (direct, referral-link, search, social, newsletter, product-hunt, extension, mcp, other).

| Metric | Definition | Num / Den | Window | Cuts | Source | Decision |
|---|---|---|---|---|---|---|
| Signups by channel | F7 grouped by channel | count | weekly | channel | `user_settings` | Where to spend the next hour of marketing |
| Activation by channel | F13 by channel | activated / signups ≥7d old | cohort month | channel | derived | Which channel brings people who stick, not just people |
| Paid by channel | F15 by channel | paid / signups ≥30d old | cohort month | channel | `billing_events` + `user_settings` | CAC by channel in YC mode |
| **MCP connector** | | | | | | |
| MCP connected | Distinct accounts that completed an MCP OAuth grant or created an API key (today nothing is stored for OAuth callers) | count, and / F7 | weekly | assistant (Claude / ChatGPT / other, from the Clerk OAuth client id) | new `mcp_connected` event; `api_keys` | Whether the free connector is a channel or a feature |
| MCP first tool call | First `mcp_tool_called` per account | / MCP connected, within 7d | weekly | assistant, tool | new event | Whether connection converts to use |
| MCP weekly return | Accounts with an `mcp_tool_called` in the week and in the prior week | / accounts with any call | weekly | assistant | new event | Whether to invest in more tools |
| MCP-led signups | Accounts whose first touch is the MCP OAuth consent flow or `/connect` | count | weekly | | `user_settings` first touch (`signup_landing_path = '/connect'`) | Whether the connector acquires |
| **Chrome extension** (once released) | | | | | | |
| Extension installs | `extension_installed` event (new; today `onInstalled` opens `/dashboard` with no marker) | count | daily | browser | new event | Store listing effectiveness |
| Extension first use | First user action through `/api/extension/*` | / installs within 7d | weekly | action kind | `extension_usage` (needs action kind) | Onboarding inside the panel |
| Extension weekly return | Accounts with an extension action this week and last | / weekly extension users | weekly | | `extension_usage` | Whether the extension is a habit surface |
| Extension-led signups | Accounts whose first `page_views` or first touch carries `utm_source=extension` | count | weekly | | `user_settings` | Whether to lead with the extension at launch |
| **Referrals** | F4 above, plus referral → account: referred signups that become accounts | / referred signups | 30d | | `interest_list_signups` → `user_settings` via invite claim | Referral rewards |
| **UTM** | F1, F3, F7 by `utm_source` / `utm_campaign` | counts | per campaign | | `page_views`, `user_settings` | Which posts to repeat |

### 2.3 Engagement and retention

| Metric | Definition | Num / Den | Window | Cuts | Source | Decision |
|---|---|---|---|---|---|---|
| **WAN** (north star) | §1.3 | count | trailing 7d, daily series; Monday snapshot | ★plan, channel, cohort month | intentional-action fragment | Wave go/no-go; launch readiness |
| DAN / MAN | Same action set over trailing 1 / 30 days; DAN ≤ WAN ≤ MAN asserted | counts | daily | plan | same | Stickiness = WAN / MAN, printed as fraction |
| Opened Orbit (viewers) | Distinct signed-in accounts with a page view, not internal, not bot | count | weekly | plan | `page_views` | Reading-only users invisible to WAN |
| Cohort retention curve | For each signup week W, share of the cohort in WAN in weeks +1 … +12 after signup; only fully elapsed weeks drawn | active / cohort size | weekly cohorts, 12 weeks | ★channel, path, invited vs organic | derived (`retentionCurves` with weekly cohorts and the narrowed action set) | Whether retention is improving release over release |
| Week-2 return | Cohort retention at week +2 specifically (the one number to put on the wave gate) | / cohort | per cohort week | wave | derived | Wave gate |
| Resurrection | Accounts in WAN this week that were **not** in WAN in any of the prior 4 weeks but had been before | count, / dormant pool | weekly | trigger (Radar digest week, broadcast, release) | derived | Whether digests and broadcasts bring people back |
| Going cold (seasonal) | Accounts whose last intentional action is 21 to 60 days ago **and** whose stated use is job search (`career_profile` or goals), reported as a pool size with the share that resurrect within 90 days | count | monthly | goal type, plan | derived + `user_goals` | Whether to build a "season over" pause instead of treating it as churn; what the Radar digest should say |
| Dormant pool | Last intentional action > 60 days ago | count | monthly | plan | derived | Lifetime-buyer cost exposure; win-back emails |

Timezone note for "going cold": the operator's counts stay in UTC, but the *user-facing* nudge that would act on it should use `user_settings.radar_digest_tz` or the `tz` cookie, since "went quiet for three weeks" is a calendar judgment in their week, not ours.

### 2.4 Feature adoption and depth

For each **released** surface (`app_surface_flags` decides released; coming-soon surfaces are excluded from the chart automatically rather than by hand):

| Surface | Adopted (ever) | Used this week | Depth | Source | Decision |
|---|---|---|---|---|---|
| Capture (text / voice / photo / file / meeting) | ≥1 `capture_jobs.status='saved'` | distinct accounts with a save in week | saves per active account; people saved per capture (`result.saved.created`) | `capture_jobs` | Which input kinds to polish |
| Imports (by provider) | ≥1 `imports.status='completed'` | same | contacts created per import; **failed imports / started** | `imports` | Which importers break |
| Reminders / follow-ups | ≥1 user-created reminder | distinct accounts setting or completing | set per week; completed per week; **completed / due** | `reminders` (+ `completed_at`) | Whether nudges are actionable |
| Chat | ≥1 user message | distinct accounts asking | questions per asker; thumbs up/down share (`chat_messages.feedback`) | `chat_messages` | Chat quality investment |
| Constellation (graph) | ≥1 `/graph` page view | same | views per viewer | `page_views` | Keep or cut |
| Knowledge, Radar, Events, Recruiters, Outreach | per surface: a row in its table | same | per-surface depth | respective tables | Keep or cut |
| Calendar | subscription or source connected | | | `calendar_subscriptions`, `calendar_sources` | |
| MCP / API | §2.2 | | tool calls per account per week | new event / `api_keys` | |
| Extension | §2.2 | | actions per account per week | `extension_usage` | |
| **AI usage per account** | | | | | |
| AI calls per active account, by operation | `usage_events` grouped by `operation` mapped to feature (capture / chat / drafts / brief / radar / embeddings) | calls / WAN | weekly | ★key owner (BYOK vs managed), plan, model | `usage_events` | Credit allowance tuning |
| AI failure rate by operation | `success = 0` / calls, with `error_kind` | | weekly | provider, key owner | `usage_events` | Which provider path is broken |
| **Voice (Deepgram)** | | | | | |
| Voice adopters | accounts with ≥1 `speech_usage` row (or `usage_events.kind='transcription'`) | / WAN | weekly | plan | `speech_usage` | Whether voice earns its cost |
| Minutes per voice user | sum seconds / adopters | | monthly | plan | `speech_usage` | Cap tuning |
| Voice cap hits | `gate_events` with the voice kind | / voice adopters | monthly | plan | `gate_events` | Whether the free hour is right |

### 2.5 Value delivered (beneath the north star)

| Metric | Definition | Source | Decision |
|---|---|---|---|
| Follow-ups completed per week | `reminders.completed_at` in week, user-created or accepted suggestion | `reminders` (new column) | Is Orbit keeping relationships warm, or just listing them |
| Completed / due | completed in week / due in week (`due_date` in week, status any) | `reminders` | Whether the nudge is actionable |
| Suggested reminders accepted | `scheduleFromSuggestion` / suggestions shown | `suggested_reminders` + new `suggestion_shown` counter | Whether AI suggestions are trusted |
| Drafts sent | outreach / email / agent sends approved | `outreach_messages`, `email_sends`, `agent_send_requests` | Whether drafting leads to contact |

### 2.6 Monetization

| Metric | Definition | Num / Den | Window | Cuts | Source | Decision |
|---|---|---|---|---|---|---|
| Free → Pro conversion | Accounts whose first paid event is a subscription | / activated accounts ≥30d old; also / all accounts ≥30d | cohort month | ★channel, path, plan interval | `billing_events`, `user_settings` | Price and paywall |
| Free → Lifetime conversion | First paid event `kind='lifetime'` | same denominators | cohort month | price tier (intro / standard) | `billing_events` | Whether to keep Lifetime open |
| Time to convert | Days from `user_settings.created_at` to first paid event; median and p75 | | rolling 90d | plan | same | When to show the upgrade prompt |
| Last gate before paying | For each converter, the most recent `gate_events` row in the 7 days before the paid event, by gate kind | share of converters per gate | rolling 90d | plan bought | `gate_events` ⋈ `billing_events` | Which limit actually sells |
| Gate hit → upgrade within 7d | Accounts with a gate hit who pay within 7 days | / accounts with a gate hit | weekly | gate kind | same | Which gates are friction vs. conversion |
| Reached `/upgrade` → paid | `page_views.route='/upgrade'` accounts who pay within 7d | / reached | weekly | | `page_views` + `billing_events` | Checkout friction |
| Churn (logo) | Subscriptions that ended (`kind in ('canceled','expired')` net of resume) | / subscriptions active at start of month | monthly | plan, interval, tenure | `billing_events` | Retention offers |
| Churn (revenue) | MRR lost from churn + downgrades | / MRR at start of month | monthly | | `billing_events` | |
| Annual vs monthly mix | Active subscriptions by `subscription_interval` | share | monthly snapshot | plan | `user_settings` / ledger | Annual discount |
| Lifetime intro → standard step | Lifetime purchases by price paid, and conversion rate per week before vs after the step | per tier | event window | | `billing_events.amount_cents` + price id | Whether the step suppressed demand |
| MRR, ARR, net new MRR | From the ledger as today, with comps excluded and Lifetime reported as a separate cash line, never in MRR | | monthly | plan | `billing_events` | YC mode |
| Reconciliation | Ledger MRR vs Stripe live subscriptions vs `user_settings` plan columns; alarm on any drift | | daily | | all three | Trust in every number above |

### 2.7 Unit economics

| Metric | Definition | Source | Cuts | Decision |
|---|---|---|---|---|
| Cost per active account per month | (AI managed cost + Deepgram + Apollo + email/SMS + infra share) / MAN | `usage_events.estimated_cost_micros` (key_owner='orbit'), `speech_usage`, Apollo calls, `email_sends`, Twilio, `infra_costs` | ★plan (Free / Pro / Max / Lifetime / comped) | Credit allowances, Lifetime price |
| Gross margin per plan | Revenue per plan − attributable cost per plan | ledger + above | plan | Which plan loses money |
| Heavy-user list | Accounts whose attributable cost this month exceeds their monthly revenue (Lifetime amortised over 36 months; Free = 0) | same | | Caps and nudges; this is the "visible heavy Lifetime or free user" the brief asks for |
| Cost per capture / per chat / per voice minute | cost by operation / count | `usage_events` by `operation`, `speech_usage` | model | Model routing |
| CAC, LTV, payback | As YC mode, but with comps and internal accounts excluded and Lifetime treated as one-time cash | `acquisition_spend`, ledger | channel | Fundraising narrative |

Costs that are manual entry today (`infra_costs`, `startup_expenses`, `acquisition_spend`) stay manual; the plan proposes a monthly reminder rather than automation.

### 2.8 Quality and trust

| Metric | Definition | Source | Decision |
|---|---|---|---|
| User-visible failure rate, by flow | failed / attempted for capture, import, sync, voice, AI call, email send, checkout | `capture_jobs.status='failed'`, `imports.status='failed'`, `error_events` by kind, `usage_events.success=0`, `email_sends` status, new `checkout_failed` | What to fix before the next wave |
| Accounts affected by a failure this week | distinct accounts with ≥1 failure | same | Whether a bug is one person or everyone |
| Error rate per 1k signed-in page views | `error_events` / signed-in views | `error_events`, `page_views` | Release health |
| Feedback volume and themes | `feedback` rows per week, by category and sentiment (new fields) | `feedback` | Roadmap |
| Chat answer quality | thumbs down / rated | `chat_messages.feedback` | Chat investment |
| Radar card quality | `recommendation_feedback` by verdict | `recommendation_feedback` | Radar tuning |
| Support-type events | feedback rows of category `bug` or `question`, contact-form sends | `feedback`, `email_sends` | Support load forecast |

---

## 3. Identity model

### 3.1 Principle

Stay cookieless for anonymous traffic. Do **not** introduce a persistent anonymous identifier in a cookie or `localStorage`: it would be a tracking identifier under ePrivacy whatever the storage, it would require a consent banner, and it would undo the strongest line in `/privacy`. Instead, **join at the moments a person identifies themselves**, using identifiers that already exist and live for one step.

### 3.2 The chain

```
visitor_hash (daily, derived)            page_views
  └─ session_id (per tab, 30 min idle)   page_views.session_id
       │
       ├─► waitlist join ──────────────► interest_list_signups.id
       │     carries: join_session_id (new), utm/referrer (exists), share_token (exists)
       │
       ├─► invite ────────────────────► site_invites.id (new table; today Clerk + audit log)
       │     carries: interest_list_signup_id (new link), wave_id (new)
       │
       └─► account created ───────────► user_settings.user_id (Clerk id)
             carries: signup_* first touch (exists, from orbit_attr cookie),
                      signup_session_id (new, from sessionStorage pv_sid on first app load),
                      invite_id (new, from claimSiteInviteGrant)
                        │
                        ├─► Stripe customer ── user_settings.stripe_customer_id (exists)
                        │     + client_reference_id = user_id on every checkout session
                        ├─► MCP grant ──────── mcp_connected event keyed by user_id (new; today nothing stored)
                        └─► extension ──────── requests authenticated as user_id (exists)
```

What each new link costs in privacy terms: nothing new is stored about an anonymous person. `join_session_id` and `signup_session_id` are the same random per-tab UUID the beacon already sends; they let the operator say "this account's signup session landed on `/pricing` from Reddit", not "this is who the visitor was on Tuesday".

### 3.3 Rules

1. **Anonymous rows never gain a user id retroactively.** The session that signed up is linked forward from `user_settings.signup_session_id`; `page_views.user_id` for pre-signup rows stays NULL.
2. **One identifier per layer**: `visitor_hash` for day-level traffic, `session_id` for a visit, `interest_list_signups.id` for a waitlist person, `site_invites.id` for an invitation, `user_id` for an account. Email is a *fallback* join, never the key.
3. **Deletion**: an account deletion deletes or nullifies every row keyed by its `user_id` in analytics tables (`page_views.user_id → NULL`, `gate_events`, `usage_events`, `extension_usage`, new `product_events`) and nulls `interest_list_signups.user_id`. Aggregates already computed are unaffected, which is the point of aggregates.
4. **Internal flag travels with the identity**: `is_internal` is computed at write time from `ADMIN_USER_IDS`, `DEMO_ACCOUNT_USER_ID`, a new `user_settings.account_kind` (`customer | internal | tester | comped`), and the browser opt-out, and is also re-applied at read time, as `page_views` already does.

### 3.4 Account kinds

A new nullable column `user_settings.account_kind` with values:

| kind | meaning | default in product metrics | default in revenue metrics |
|---|---|---|---|
| `customer` (NULL) | a real user | included | included |
| `internal` | operator, teammates, showcase account | excluded | excluded |
| `tester` | beta testers who were asked to test, not to use | excluded, toggle to include | excluded |
| `comped` | invited Pro / Max via `setCompedPlan` (derived: `comped_plan IS NOT NULL`) | **included** in product metrics (they are real users) | excluded from MRR, conversion, LTV; shown as a separate "comped" line |

Set from the admin user page; seeded for existing admin ids by a one-off script. `internalAccountSql()` becomes `excludedAccountSql(kind set)` and every aggregate uses it.

---

## 4. Event taxonomy

### 4.1 Where events live

A new table `product_events`, append-only:

| column | type | notes |
|---|---|---|
| `id` | uuid | client- or server-generated; the **dedupe key** |
| `name` | text | `object_action`, from the closed list below |
| `version` | smallint | schema version of `properties` for this name; starts at 1 |
| `occurred_at` | timestamptz | when it happened (client clock is never trusted: server stamps, client may pass an offset ≤ 5 min for offline queues) |
| `user_id` | text, nullable | Clerk id; NULL for anonymous events |
| `session_id` | uuid, nullable | the beacon's `pv_sid`; NULL for server / cron |
| `surface` | enum | `web`, `extension`, `mcp`, `api`, `cron`, `webhook` |
| `actor` | enum | `user`, `system` — the single most important column for WAN |
| `is_internal` | boolean | computed at write |
| `properties` | jsonb | validated against the event's zod schema; **ids, enums, counts, booleans, durations only** |
| `created_at` | timestamptz | insert time |

Indexes: `(name, occurred_at)`, `(user_id, occurred_at)`, `(session_id)`. Retention: 400 days, pruned by the existing ops sweep like `page_views`. Not exported to the user data export as rows (it is operational telemetry), but **listed in `/privacy` and deleted with the account**.

Domain tables remain the source of truth for anything they already record. `product_events` exists for actions that leave no row, for failures, and for exact timestamps the domain row loses.

### 4.2 Naming and property rules

- `object_action`, lower snake, past tense for completed things (`capture_saved`), present for attempts (`checkout_started`). No synonyms: one name per fact.
- **Required on every event**: `surface`, `actor`, and for user events `user_id`. The helper fills them; call sites cannot omit them.
- **Forbidden in `properties`**: free text, names, emails, URLs with query strings, note or message content, prompts, outputs, transcripts, file names. The zod schemas only admit `z.string().uuid()`, enums, numbers, booleans. A `z.string()` without a format is a lint error in `analytics/schema`.
- **Versioning**: changing a property's meaning bumps `version` and keeps the old schema file; dashboards select on `(name, version)` or map explicitly. Adding an optional property does not bump.
- **Ownership doc**: `analytics/events/README.md` (proposed) holds one section per event: owner (you), definition, when it fires, when it must not fire, properties, the dashboard(s) that read it, and the date it was added. The zod file is generated from, or asserted against, that doc by a smoke test so they cannot drift.

### 4.3 Typed helper (shape only; no code change in phase 1)

```ts
// analytics/schema/events.ts (draft; see analytics/ directory)
export const events = {
  capture_saved: z.object({
    capture_job_id: z.string().uuid(),
    source_kind: z.enum(["text", "voice", "photo", "file", "meeting", "paste", "drive"]),
    people_created: z.number().int().min(0),
    people_updated: z.number().int().min(0),
    duration_ms: z.number().int().min(0).optional(),
  }),
  // ...
} as const;

track("capture_saved", { ... }) // compile error on a missing or extra property
```

Behaviour: in `NODE_ENV=development` and in the smoke suite a schema failure **throws**; in production it drops the event and calls `reportError(err, { where: "analytics.track" })`, throttled like `/api/track` already does. A property that fails the "no free text" lint fails `npm run lint`.

### 4.4 Event catalogue

Events marked **(exists)** already have a row somewhere and need no new write; they are listed so the taxonomy is complete and so dashboards name them consistently.

**Acquisition and access**

| event | actor | fires at (file / function) | key properties |
|---|---|---|---|
| `page_viewed` (exists as `page_views`) | user | `src/app/api/track/route.ts` POST | route, session |
| `waitlist_joined` (exists as row) | user | `src/lib/interest-list-join.ts` `joinInterestListCore` | signup_id, source (`form`, `referral`, `poll`), has_referrer, **session_id (new column)** |
| `waitlist_shared` | user | the share / copy / ticket-download handlers in `src/components/interest/*` | signup_id, channel (`copy`, `x`, `linkedin`, `ticket`) |
| `invite_sent` | system/user | `src/lib/site-invites.ts` `inviteToSite` (today: Clerk invitation + `admin_audit_log` only) | invite_id, wave_id (new), source |
| `invite_accepted` | user | `src/lib/site-invites.ts` `claimSiteInviteGrant` | invite_id, user_id, days_since_sent |
| `account_created` (exists as row) | user | `src/app/api/webhooks/clerk/route.ts` user.created, and `ensureUserSettings` | user_id, invite_id, channel |
| `first_app_load` | user | `src/lib/attribution-capture.ts` `captureAttribution` (first signed-in render) | session_id, landing_route |

**Setup and activation**

| event | actor | fires at | key properties |
|---|---|---|---|
| `terms_accepted` (exists as column) | user | `src/actions/onboarding.ts` `acceptTerms` | version |
| `onboarding_path_chosen` | user | `src/actions/onboarding.ts` `startOnboardingPath` | path (`capture`, `import`, `tour`) |
| `onboarding_step_completed` | user | `saveOnboardingStep`, `saveTourStop` | path, step |
| `onboarding_completed` (exists as column) | user | `completeOnboarding`, `finishTour` | path, seconds_since_signup |
| `ai_key_added` | user | `src/lib/ai-settings-write.ts` `applyAiKeyChange` (only when a key goes from absent to present) | provider, plan, seconds_since_signup |
| `ai_key_check_failed` | system | `src/lib/ai-key-check.ts` | provider, error_kind |
| `ai_managed_used_first` | system | first `usage_events` with `key_owner='orbit'` per account (derivable; no new write) | |
| `capture_saved` (exists as `capture_jobs`) | user | `src/actions/capture-jobs.ts` `saveCaptureJob` → `note-batch-save.ts` `saveNoteBatch` | see §4.3 |
| `capture_failed` | system | `src/lib/capture-job-runner.ts` `runCaptureJobById` failure branch | capture_job_id, source_kind, error_kind, stage |
| `capture_discarded` | user | `discardCaptureJob`, `discardCaptureBatch` | capture_job_id, people_proposed |
| `import_started` / `import_completed` (exist as `imports`) | user / system | `src/lib/import-engine.ts` `runImportJob` | import_id, provider, contacts_created |
| `import_failed` | system | `src/lib/import-engine.ts` `failImport` | import_id, provider, error_kind, rows_failed |
| `contact_created` (exists) | user | `src/lib/contact-writes.ts` | contact_id, origin (`manual`, `capture`, `import`, `extension`, `mcp`) |
| `followup_set` | user | `src/lib/reminder-writes.ts` `createReminderForUser`, `scheduleContactFollowUpForUser`; `src/actions/reminders.ts` `scheduleFromSuggestion` | reminder_id, origin (`manual`, `suggestion`, `capture`), has_due_date |
| `followup_completed` | user | `src/actions/reminders.ts` `markReminderDone`, `completeFollowUpWithTouch`, `bulkReminderAction` (per reminder) | reminder_id, days_late, via (`list`, `dashboard`, `touch`, `bulk`) — **and** a `reminders.completed_at` column |
| `followup_snoozed` / `followup_dismissed` | user | `snoozeReminderAction`, `dismissSuggestion` | reminder_id |
| `chat_question_asked` (exists as row) | user | `src/app/api/chat/route.ts` POST | thread_id, message_id, has_attachments |
| `chat_answer_landed` | system | `src/lib/chat-persist.ts` `persistAssistantTurn` | message_id, duration_ms, tools_used (count), evidence_count |
| `chat_answer_failed` | system | the stream error branch in `src/app/api/chat/route.ts` | thread_id, error_kind |
| `chat_feedback_given` (exists as column) | user | the thumbs handler in `src/actions/chat-actions.ts` | message_id, verdict |

**Habit surfaces**

| event | actor | fires at | key properties |
|---|---|---|---|
| `mcp_connected` | user | OAuth grant completion in `src/lib/mcp/oauth.ts` | client (`claude`, `chatgpt`, `other`), grant_id |
| `mcp_tool_called` | user | the handler wrapper in `src/lib/mcp/handle.ts` around each `server.registerTool` | tool, client, duration_ms, ok, result_count |
| `mcp_disconnected` | user | token revoke | client |
| `extension_installed` | user | `extension/src/background/index.ts` `onInstalled` → open `/dashboard?utm_source=extension&utm_medium=install&utm_campaign=<version>`; the beacon records it; a server event is written on the first authenticated `/api/extension/me` with `install: true` | version, browser |
| `extension_action` | user | each `src/app/api/extension/*` route that performs a user action (save person, log interaction, event roster) | action, site (`linkedin`, `gmail`, `luma`, `other`), ok |
| `extension_uninstalled` | user | `chrome.runtime.setUninstallURL` → `/api/extension/uninstalled?v=` (unauthenticated, counts only) | version |
| `radar_digest_sent` / `radar_digest_opened` | system / user | `src/app/api/radar/digest/route.ts`; Resend webhook `opened` | run_id |
| `voice_recorded` (exists as `speech_usage`) | user | `src/app/api/speech/usage/route.ts` | seconds, surface (`note`, `meeting`) |

**Monetization**

| event | actor | fires at | key properties |
|---|---|---|---|
| `gate_hit` (exists as `gate_events`) | system | `src/lib/gate-events.ts` `recordGateHit` | gate, plan, surface |
| `upgrade_page_viewed` (exists as page view) | user | beacon | from_gate (new: `/upgrade?gate=`) |
| `checkout_started` | user | `src/actions/billing.ts` `startSubscriptionCheckout`, `startCreditPackCheckout`, Lifetime start | plan, interval, price_id, from_gate |
| `checkout_completed` (exists as ledger) | system | `src/lib/stripe-event-processor.ts` | plan, interval, amount_cents, price_tier |
| `checkout_abandoned` | system | derived: `checkout_started` with no `checkout_completed` in 24h | plan |
| `subscription_canceled` (exists as ledger) | user | `src/actions/billing.ts` `cancelSubscription` | reason (new survey), tenure_days |
| `credit_pack_bought` (exists) | user | ledger | |

**Quality and trust**

| event | actor | fires at | key properties |
|---|---|---|---|
| `error_shown` | system | `src/lib/report-error.ts` client branch, when a toast or error state is rendered to the user | where, error_kind |
| `sync_failed` | system | connector sync runners (`src/lib/sync-*.ts`, `calendar-sync.ts`, `gmail-scan-processor.ts`) | provider, error_kind |
| `email_send_failed` | system | `src/lib/email/*` providers | provider, kind |
| `feedback_submitted` (exists as row) | user | `src/lib/feedback-submission.ts` `createFeedbackSubmission` | feedback_id, category (new), sentiment (new), page route |
| `survey_answered` | user | new micro-survey component | survey_id, question_id, answer (enum or 1–5), moment |
| `account_deleted` | user | `src/lib/account-deletion.ts` `deleteOwnAccount` | tenure_days, plan, reason (new survey), **written before the user id is removed, with `user_id` nulled** |

### 4.5 Missing events, ranked by decision value

Rank is by how much the first invite wave's go/no-go and the launch pricing decision depend on it, weighed against instrumentation effort.

| rank | event / column | why it matters now | instrumentation point | effort |
|---|---|---|---|---|
| 1 | `reminders.completed_at` + `followup_completed` | The only value signal in the metric tree that cannot be dated today; without it F11 and the value metric do not exist. | `markReminderDone`, `completeFollowUpWithTouch`, `bulkReminderAction` in `src/actions/reminders.ts`; a nullable column plus a backfill of `updated_at` for rows already `done` (flagged as approximate) | S |
| 2 | `ai_key_added` + first managed use | Bring-your-own-key is the suspected first cliff (F8). Today only presence booleans exist, with no timestamp. | `applyAiKeyChange` in `src/lib/ai-settings-write.ts` | S |
| 3 | `checkout_started` (+ `from_gate`) | Without it, "reached `/upgrade`" is the only intent signal and abandonment is invisible; the gate → upgrade link in §2.6 needs it. | `src/actions/billing.ts` three start functions; pass `?gate=` from the paywall copy into `/upgrade` | S |
| 4 | `invite_accepted` + `site_invites.interest_list_signup_id` + `wave_id` | Wave pacing is the first decision of the beta and today invite → account is an email string match. | `claimSiteInviteGrant`, `inviteToSite` in `src/lib/site-invites.ts` | S |
| 5 | `mcp_connected` / `mcp_tool_called` | The free connector is a channel bet with zero measurement. | `src/lib/mcp/oauth.ts`, `src/lib/mcp/handle.ts` | M |
| 6 | `capture_failed`, `import_failed`, `chat_answer_failed` as countable events | The brief's "failed captures/imports seen by users" has no numerator today beyond status columns that overwrite. | `runCaptureJobById`, `failImport`, chat route error branch | S |
| 7 | `extension_installed` / `extension_action` / `extension_uninstalled` | Must exist before the extension ships or launch week is unmeasured. | `extension/src/background/index.ts`, `/api/extension/*` | M |
| 8 | `onboarding_path_chosen` / `onboarding_step_completed` | Activation by path is the main onboarding lever; today only completion is stamped. | `src/actions/onboarding.ts`, `src/actions/tour.ts` | S |
| 9 | `signup_session_id` on `user_settings` and `join_session_id` on `interest_list_signups` | Closes the identity chain without a cookie. | `captureAttribution`, `joinInterestListCore` | S |
| 10 | `feedback.category` / `sentiment`, `survey_answered`, cancellation reason | The qualitative loop in `ANALYTICS_PLAN.md` phase 4. | `createFeedbackSubmission`, new component, `cancelSubscription` | M |
| 11 | `account_deleted` with reason | Churn is invisible today: deleted accounts vanish from history. | `deleteOwnAccount` | S |
| 12 | `waitlist_shared` | Referral loop measurement is inferred from `referred_by` only. | share handlers in `src/components/interest/*` | S |

---

## 5. Definitions that must agree everywhere

A short list of definitions that exist in two places today and must become one shared fragment (see `ANALYTICS_AUDIT.md` §4 for the evidence):

| concept | today | proposed single home |
|---|---|---|
| "Onboarded / activated" | `isOnboarded()` in `admin-metrics.ts` (counts tour examples), the SQL in `acquisitionFunnel` (excludes them), `activationTrend` and `workflowStagesTrend` (exclude them), `needsOnboarding` (excludes them) | one SQL fragment `activatedSql()` + its JS twin, both asserted equal by a smoke test |
| "Active" | `writesSince()` (5 tables, includes system writes, includes internal) vs `viewersTrend` (page views, excludes internal) vs `last_active_at` presence | `intentionalActionSql()` for WAN; `viewersTrend` kept as the "opened" measure; `last_active_at` for the admin roster only |
| "Internal" | `internalAccountSql()` applied in traffic and the Conversion funnel only | `excludedAccountSql()` applied in every aggregate, with `account_kind` |
| "Paid" | `acquisitionFunnel` (MRR delta > 0 or lifetime, net of refund) vs `buildPlanBreakdown` (plan source) vs YC revenue | one `paidAccountSql()` in `billing-events.ts`, parameterised on whether comps count |
| Day boundary | `AT TIME ZONE 'UTC'` in `trafficTotals`, session timezone in `trafficTrend`, `series()`, `retentionCurves` | every `date_trunc` in the admin read side takes `AT TIME ZONE 'UTC'` |
