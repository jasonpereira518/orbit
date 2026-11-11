# Orbit runbook

What to do when something is wrong, and how the routine things are done. Short on purpose.

## Where to look

| Signal | Where |
|---|---|
| Something is down | Better Stack monitor on `/api/health` → `#orbit-ops-critical` |
| Backups stopped (`backup.stale`) | Better Stack heartbeat "orbit backup" (36 h without a ping) → `#orbit-ops-critical`; then the private ops repository → Actions → `backup` |
| A known condition opened / recovered | ops sweep → `#orbit-ops` (critical also → `#orbit-ops-critical`) |
| An exception nobody anticipated | Sentry (linked from `/admin/health`) |
| What is open right now | `/admin/health` → System status strip and Open alerts |
| Deep probe | `curl -H "Authorization: Bearer $HEALTH_TOKEN" /api/health` — a wrong bearer answers 401; `?token=` is refused in production |
| Which code is live | `/api/health` → `sha` (compare with `main`) |

## Deploy

Push to `main`. CI (`typecheck · lint · build`, `smoke suite`) must be green; Vercel then
runs `npm run check:env && npm run typecheck:fast && npm run db:migrate && next build`. A missing
production variable, a type error or a failing DDL statement fails the build and the previous
deployment stays live. `typecheck:fast` is TypeScript 7 from `scripts/ts7` (installed by
`vercel.json`'s `installCommand`), and `next.config.ts` turns Next's own, slower type-check off
on Vercel only; CI still runs both. A preview build also runs the migration with `force`, because
previews share one database and a sibling branch's newer schema stamp would otherwise hide this
branch's DDL.

**Previews are skipped when nobody would open them.** Hobby allows 100 deployments a day
(cancelled and failed builds count), and every retained deployment's function bundles count
against Functions Storage. Vercel's Ignored Build Step (`vercel.json` →
`scripts/vercel-ignore-build.sh`) skips a preview for: any non-`main` branch with no pull
request, any `dependabot/*` branch (CI already builds it), and a PR push that only touches
files the app never reads (`docs/`, `.github/`, `e2e/`, `extension/`, `*.md`, smoke scripts)
since the branch's last build, and a push whose commit is only a merge (`Merge origin/main into
X`, `Merge branch 'a' into b`; any extra text in the subject builds it). Hobby runs one build at a
time, so a burst of stacked-PR merges used to queue the last preview ~40 minutes.
`node scripts/dev/vercel-build-report.mjs --project … --team …` prints queue, build time and
phase breakdowns. A branch builds once it has a
PR and gets a push. To get a preview sooner, put `[deploy]` in the commit message, or redeploy
from the dashboard. `main` and production always build.

## Roll back

Vercel → Deployments → the last good one → **Promote to Production**. Schema changes are
additive and idempotent, so old code runs fine on a newer schema. What happens next:

- `/api/health` answers **200 with `status: "degraded"`** and `schema.ahead: true` (the
  database was migrated by the newer build). The uptime monitor stays green and the `ops`
  workflow keeps running the sweep, the stalled-import job, the webhook drain and sync.
- The older code sees a recorded version at or above its own, so it does **not** re-run its
  schema sweep, and it never writes its lower number back.
- Nothing is undone: columns the newer build added stay, and old code ignores them.

Then fix forward. The next deploy from `main` carries a version at or above the recorded
one and health returns to `ok`. A **503 `schema_mismatch`** still means the database is
BEHIND the code — a build whose migration did not run — and is worth waking up for.

## The nightly job or the sweep stopped

1. `/admin/health` → "Ops sweep" tile. Quiet for over 30 min means the GitHub schedule is not
   firing — see "Scheduled workflows were disabled" below.
2. "Nightly job" tile red (it runs hourly, from `ops.yml` only): trigger it by hand —
   `curl -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/imports/process-stalled`
   A 401 means `CRON_SECRET` differs between Vercel and GitHub.

## Scheduled workflows were disabled (GitHub's 60-day rule)

GitHub disables a public repository's scheduled workflows after 60 days without repository
activity. That stops `ops` (sweep, process-stalled, drain, connector sync); the Better Stack
heartbeat goes quiet within 30 minutes. (`backup` lives in the private ops repository, which
the rule does not apply to.)

```bash
gh api repos/jasonpereira518/orbit/actions/workflows --jq '.workflows[] | [.name, .state] | @tsv'
# a disabled one reads "disabled_inactivity"
gh workflow enable ops.yml --repo jasonpereira518/orbit
gh workflow run ops.yml --repo jasonpereira518/orbit
```

Or GitHub → Actions → the workflow → **Enable workflow**, then **Run workflow**. Any push to
`main` resets the timer; a recurring calendar reminder every 45 days runs the `gh api` line
above. Vercel Pro crons remove the rule entirely.

## Alert → what to do

| Alert | Do |
|---|---|
| `webhook.invalid_streak:clerk` / `:stripe` | The signing secret rolled or a second endpoint points here. Dashboard → Webhooks → copy the endpoint's secret into Vercel → redeploy. |
| `stripe.checkout_error` | `/admin/health` → error events → the `kind` is Stripe's code. `resource_missing` = a price id from the wrong mode. |
| `stripe.unattributed` | Critical: someone paid for a checkout Orbit could not match. error_events (source `stripe.unattributed`) → `context.eventId` → Stripe Dashboard → Events → that id → the customer's email → `/admin/users` → comp the plan, or refund. Warning: an invoice/refund for a customer with no account, usually one created in the Dashboard. |
| `resend.rejected` | `/admin/health` → error events → `resend.rejected` shows Resend's message. "domain is not verified" = `RESEND_FROM_EMAIL` must be on a domain verified under Resend → Domains; fix it in Vercel and redeploy. Only Orbit's own key is counted — a user's own Resend key failing shows on their message, not here. |
| `import.wedged` / `import.failed_burst` | `/admin/health` → Failed and stalled imports → Retry. After 3 stalled resumes the job is marked failed with a message; the user re-uploads. |
| `purge.stuck` | `SELECT id, target_user_id, last_error, completed_steps FROM data_purge_runs WHERE status = 'failed';` Fix the cause `last_error` names, then requeue: `UPDATE data_purge_runs SET status = 'running', attempts = 0, last_attempt_at = now() - interval '1 hour' WHERE id = '<id>';` The next nightly run finishes it (or trigger `/api/imports/process-stalled`). |
| `cron.partial_streak` | `/admin/health` → Nightly job → the run's stats. Each housekeeping step in `src/app/api/imports/process-stalled/route.ts` is its own try/catch; the one whose counter stays at zero is failing. Sentry has the exception. |
| `drain.failed` | No outbound webhook is being retried. Run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/webhooks/outbound/drain`; a 500 means the drain throws — Sentry has it. |
| `radar.schedule_missed` | Radar's nightly pass started once and then went quiet for over 30 hours, so nobody's list is being refreshed overnight. Check the ops workflow ran the 04:17 step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/radar/run`. Pages still rebuild a list older than a day when someone opens Radar. |
| `radar.run_failed` | The last nightly pass failed or was killed at the 300 s ceiling. Read its `cron_runs` row and the `job.radar` / `job.radar.user` errors, fix, then run it by hand with the same `curl`. One account failing marks the pass `partial`, which is not an alert. |
| `radardigest.schedule_missed` | Radar's Monday email, which runs hourly through Sunday and Monday UTC, has not started for six days, so a whole Sunday passed without a run and nobody gets their weekly list. Check the ops workflow ran the `13 * * * 0,1` step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/radar/digest`. A run outside someone's Monday 06:00–09:00 sends them nothing, and the week claim means a repeated run never sends twice. |
| `radardigest.run_failed` | The last Monday-email run failed or was killed. Read its `cron_runs` row and the `job.radar.digest` error. A send Resend refused marks the run `partial`, which is not an alert: that person's claim is released and the next hour retries; the `resend.rejected` error (kind `radar.digest`) carries Resend's reason, recorded once per run. `notConfigured` in the stats means `RESEND_API_KEY` or `RESEND_FROM_EMAIL` is unset. To stop the email for everyone, hide `page.radar`; for one person, set their `radar_digest_enabled` to 0. |
| `emailintel.schedule_missed` | The email-insights sweep started once and then went quiet for over two hours (it runs every fifteen minutes), so new application updates are not being noticed. Check the ops workflow ran the `5,20,35,50 * * * *` step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/email-intel/sweep`. Never having run is not an alert: the feature is opt-in. |
| `emailintel.run_failed` | The last email-insights run failed or was killed. Read its `cron_runs` row (job `email-intel.sweep`) and the `email-intel.sweep` errors. One account failing, running out of its daily allowance, or out of time marks the run `partial`, which is not an alert. |
| `backfill.failed` | `/admin/health` → error events, source `backfill.failed`: `kind` names the backfill, `message` says why. Two or more accounts means it is not one user's key — check the provider status panel and `ai.provider_outage`. |
| `config.statement_timeout_unbounded` | Run `ALTER ROLE <app role> SET statement_timeout = '20s';` (Neon one-time settings below), then confirm `curl -H "Authorization: Bearer $HEALTH_TOKEN" /api/health` shows `config.statementTimeout: "20s"`. It clears on the next sweep. |
| `embedding.backlog` | Check `backfill.failed`, `embedding.unembeddable` and `ai.provider_outage` first. One account: usually that user's key (they already see an account alert). Several: `/admin/health` → Nightly job stats — `embeddingsGenerated` 0 with `embeddingBackfillsKicked` > 0 means every kick is failing. |
| `sync.lagging` | More connections are due than a run syncs (20 per run, 4 at a time). `sync.run` stats: `budgetExhausted` true on every run means the budget is the limit — raise `CONNECTIONS_PER_RUN` in `src/lib/sync-scheduler.ts` or schedule more often (Vercel Pro crons); many `failed` means a provider problem. |
| `embedding.unembeddable` | `SELECT error_kind, source_type, count(*) FROM embedding_failures WHERE failed_at > now() - interval '1 day' GROUP BY 1, 2;`. One kind on one provider across users is a provider change (check its status page and changelog); the rows retry once the bisect in `src/lib/embedding-backfill.ts` can embed them. |
| `ai.quota_failures` | Informational. Users with an empty provider balance already see a "top up" account alert. Many at once on Orbit's own key (`key_owner = 'orbit'`, local dev only) means topping up that account. |
| `calendar.disarmed` | `SELECT sync_error, count(*) FROM gmail_connections WHERE next_sync_at IS NULL AND sync_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;` One error string across many accounts is Google's side (API change, consent-screen or scope change, project quota in Google Cloud Console). Users reconnect from the Integrations dialog once it is fixed. |
| `avatar.source_exhausted` | Informational: that source's shared daily allowance (`RATE_LIMITS.avatarSourceShared`) is gone and photo lookups wait for tomorrow. Daily before noon means raising the budget or buying the source's paid plan (`MICROLINK_API_KEY` skips the shared Microlink budget). |
| `apollo.hosted_cap_hits` | Informational: accounts used their daily hosted Apollo allowance (`RATE_LIMITS.apolloSearch` / `apolloEnrich`). Compare with the Apollo plan's credits before raising either. |
| `billing.ledger_drift` | Live MRR and the revenue ledger disagree and nothing has landed for an hour. Likeliest causes, in order: a Stripe webhook was dropped (`/admin/health` → webhooks), an account was comped over a live subscription (the comp zeroes live MRR but the invoices keep booking), or an account was deleted before its cancellation arrived. `SELECT user_id, sum(mrr_delta_cents) FROM billing_events GROUP BY 1 HAVING sum(mrr_delta_cents) <> 0;` against `user_settings` names the account. `analytics/checks/reconciliation.sql` has the full set. |
| `billing.stripe_drift` | Critical: Stripe and the database disagree about at least one live subscription (plan, amount, or whether it is live at all). The daily job (`POST /api/ops/billing-reconcile`) returns the accounts when run by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/ops/billing-reconcile`. `in_stripe_not_in_db`: someone is paying for something they do not have, so comp the plan and find the missed webhook. `in_db_not_in_stripe`: someone has a plan they do not pay for. |
| `billing.reconcile_missed` / `billing.reconcile_failed` | The 06:23 UTC Stripe comparison has not run for 30 hours, or its last run failed. Check the ops workflow ran the step; `STRIPE_SECRET_KEY` must be set (a restricted read key is enough). Run it by hand with the `curl` above. |
| `product.signups_drop` | Sign-ups in the last 7 days are under half of the 7 before, with at least 10 in the earlier week. Check `/admin/analytics` for a traffic drop first (the beacon, a renamed route), then the waitlist and invite flow. |
| `product.activation_drop` | The week that just finished its first week activated at under 60% of the trailing rate, with at least 20 accounts in it. Read `/admin/beta` by onboarding path and wave; a change that shipped to that cohort is the usual cause. |
| `product.funnel_break` | Critical: 10 or more accounts in two days and not one capture saved by anyone. Capture is probably broken: try one yourself, then `/admin/health` → AI failures and the capture job statuses. |
| `product.checkout_break` | Critical: checkouts started in the last day and nothing paid. Stripe Dashboard → Developers → Logs, then `stripe.checkout_error` and the webhook streaks above. |
| `quality.failure_rate:capture` / `:import` / `:email` | More than 5% of that flow's attempts failed in 24 hours, with at least 20 attempts. `/admin/beta` → Failures people saw names how many accounts it touched; the flow's own status column (`capture_jobs.status`, `imports.status`, `email_sends.status`) and its `error` text name the cause. |
| `cost.heavy_user` | An account cost Orbit more in a day than its plan's ceiling (`DAILY_COST_CEILING_MICROS` in `src/lib/product-ops.ts`). `/admin/billing/costs` lists heavy accounts; for a voice-heavy free account check the speech cap, for a Lifetime or comped one decide whether to cap. |
| `tracking.silence` / `tracking.events_silence` | Critical: no page view for two hours in the daytime after a busy day before, so every traffic number is going stale. Check `ANALYTICS_SALT` is set, `/api/p/v` (or `/api/track`) answers 204, and that the beacon is in the root layout. `tracking.events_silence` is the same for `product_events`: a deploy that broke `track()` (Sentry source `analytics.track`). |
| `cron.silent:<job>` | A job that records runs (`email.drain`, `connectors.outbox`, `credits.notices`, `cloud-notes.run`) has not started for longer than its cadence allows. Check the ops workflow ran it, then run it by hand with the route's `curl`. A dead email drain means messages are queued and not sent. |
| `deploy.drift` | A build is failing. Vercel → Deployments → open the red one → fix → push. |
| `config.missing` | Vercel → Environment Variables. The alert names the variable. |
| `config.alerts_undeliverable` | Slack → your app → Incoming Webhooks → copy the URL → Vercel → Environment Variables → `SLACK_OPS_WEBHOOK_URL` (Production) → Redeploy. Until then `/admin/health` is the only place alerts appear. |
| `ai.provider_outage:*` | Not ours; it clears when the provider recovers. |
| `perf.slow_burst` | `/admin/health` → error events → `perf.slow` rows name the call and account. |
| `ai.managed_failing:*` | Orbit's own key for that provider was refused or throttled — every account on included AI without a key of its own has lost AI. Check the key and its quota (and the prepaid balance) in the provider console; replace `ORBIT_MANAGED_<PROVIDER>_API_KEY` in Vercel and redeploy. |
| `ai.managed_unconfigured` | Pro/Max accounts exist but no `ORBIT_MANAGED_*_API_KEY` is set (or `ORBIT_MANAGED_AI=off`). Set one. |
| `ai.managed_pool:<provider>` | That provider's pool (`MANAGED_AI_POOLS`) is at 75%+. Anthropic refills on the 15th and OpenAI takes over meanwhile (warning only). OpenAI spent is critical: top up, raise `MANAGED_AI_POOLS.openai.capMicros`, deploy. With every pool spent included AI refuses. |
| `ai.managed_spend_spike` / `ai.managed_runway` | Managed spend is spiking, or outrunning subscription revenue (expected while Free usage dominates — the pool alert is the one to act on). `/admin/billing/costs` → "On Orbit's AI keys". Lower `monthlyCredits` in `src/lib/plans/plan-config.ts`, pause from `/admin/billing`, or in an emergency set `ORBIT_MANAGED_AI=off` and redeploy. |
| `ai.managed_cap_hit` | Info: accounts used their whole monthly allowance. A rising count means the cap is too tight for real use. |

## Radar: switches

Radar (`src/lib/radar/`) is the "who to reach out to" list and its
Monday email. (Its news sweep and Bluesky/Mastodon polling were removed in Nov 2026; see
`docs/superpowers/specs/2026-11-10-radar-analyst-design.md`.) Every switch, smallest first:

- **One account's email:** `UPDATE user_settings SET radar_digest_enabled = 0 WHERE user_id = '<id>';`
  (the person can do it themselves from Settings, the Radar settings sheet, or the email's link).
- **One account's autopilot:** `UPDATE user_settings SET radar_autopilot = '{}' WHERE user_id = '<id>';`
  Autopilot only ever schedules a follow-up; it never sends. Every action it took shows under
  "Autopilot did this" on `/radar` with Undo.
- **One news feed:** `UPDATE external_sources SET enabled = false WHERE id = '<id>';`
- **The AI rerank, for everyone:** set `RADAR_RERANK_ENABLED` to `false` in
  `src/lib/radar/run.ts` and deploy. The deterministic order comes back on the next nightly
  run; nothing else changes. Do it if `/admin/analytics/radar` shows cards the rerank promoted
  not beating the ones it demoted after two weeks.
- **All of Radar:** hide `page.radar` in `/admin/product`. The daily pass and the Monday email
  both stand down, and no AI key is spent.
- **Coming soon or released:** Radar ships coming soon (`comingSoon: true` on `page.radar` in
  `src/lib/surfaces.ts`). Either way round can be flipped without a deploy from the coming-soon
  toggle in `/admin/product` (a `live:page.radar` or `soon:page.radar` row, which wins over the
  code), or in code by deleting or restoring that line. While it is coming soon, the scheduled
  pass and the Monday email both stand down; "Refresh now" still builds a list for an admin
  previewing it. Once released, the pass claims every account active in the last
  60 days and the email goes to active accounts with a pending card. It was released on Sep 30
  2026 (#380) and put back behind coming soon the same day.

## Email insights: switches

Email insights (`src/lib/email-intel/`) checks opted-in accounts' Gmail every fifteen minutes
for new job and hiring-process threads. Ingest reads sender, subject, participants and Gmail's
short preview. For a thread that looks like a hiring conversation, extraction then sends the
latest messages (up to four, 4,000 characters each) to the account's AI provider and keeps
only the derived notes and one short quote: no message bodies are stored. Every switch,
smallest first:

- **One account:** `UPDATE user_settings SET email_intel_enabled = 0 WHERE user_id = '<id>';`
  (the person can do it themselves in Settings). Disconnecting Gmail deletes what it recorded
  and turns it off; an insights wipe in Settings also removes `email_threads` and `email_events`.
- **Everyone:** delete the "Run the email-insights sweep" step from `.github/workflows/ops.yml`
  and its `5,20,35,50 * * * *` schedule line. The route can stay; nothing calls it.
- **Turning it on for someone** needs the recruiter plan (Pro or Lifetime) and Gmail's mail
  scope (the `email_intel` purpose). `gmail.readonly` is a restricted scope, so until the CASA
  assessment passes only listed Google test users can grant it.
- **Where it shows:** the Settings switch renders wherever Radar is live (it was added after
  Radar's release, so it is visible on merge). It is off by default per account, disabled with
  "Available on Orbit Pro and Orbit Max" on other plans, and asks for Gmail's mail scope only
  when someone presses it. To pull it from view, hide `page.radar` in `/admin/product` (which
  also stands Radar down) or remove the `EmailIntelSetting` mount in the settings page.
- **Model spend:** each extraction is one fast-tier call on the person's own key, capped at
  `RATE_LIMITS.emailIntelExtractDaily` (40 per account per UTC day). A person whose key is
  refused, out of credit, or whose model is gone has their waiting threads parked for six hours
  with nothing counted against them.
- **Where threads are:** `SELECT status, count(*) FROM email_threads GROUP BY 1;` —
  `pending_ai` is waiting, `claimed` is being read (a claim older than ten minutes is taken
  back on the next run), `failed` gave up after three counted attempts.
- **Retry a failed thread:** `UPDATE email_threads SET status = 'pending_ai', stall_resumes = 0,
  claimed_at = NULL, claim_token = NULL WHERE id = '<id>';`
- **What the last run did:** `/admin/health` → the `email-intel.sweep` run's stats. `ingest_*`
  is listing and triage; `extract_*` is model work (`keyProblems`, `budgetStops` and `released`
  are ordinary; `failed` and `errors` are worth a look; `rejected_*` counts events the
  validator dropped and is the way to tell an over-strict floor from a quiet mailbox).
- **Radar cards from mail:** for an opted-in account, Radar's nightly pass reads the last 21 days
  of `email_events`, asks `rankEventContacts` who in the network to reach for each (at most 20
  events, three people each, inside an 8-second budget) and scores the result like any other
  signal (`email_*` reason codes). Turning the account's switch off stops it; its email cards
  leave the list on the next run (a manual Refresh in Radar does it at once). The Monday email
  never carries text derived from mail (`digestLineFor`), and a draft's intent uses fixed words.
- **"From your inbox" on Radar:** for an opted-in account, `/radar` also lists up to five people the
  last 21 days of `email_events` name who are not contacts (by address or by name) and were not
  dismissed (`loadInboxPeople`, four statements, one for an account that has not opted in). Add
  creates a contact through `resolveOrCreateContact` (`source = 'email_intel'`; name, address,
  title, nothing else) and refreshes Radar once, bounded; Dismiss writes an `ignored_people` row
  with `context = 'Named in an email'`. Gmail disconnect and an insights wipe delete those rows
  (`deleteInboxDismissals`). To stop it for everyone, remove the `InboxPeople` mount in
  `radar-view.tsx`; the cards from mail are unaffected.
- **Chat search over mail:** each `email_events` row of an opted-in account becomes one
  `memory_chunks` row (`source_kind = 'email_event'`, `source_id` the event, summary + facts +
  the one quote, never an address), so `search_notes` finds it and chat cites it as `[eN]`
  "from your email". Indexing is no model call: the email sweep indexes what it just stored
  (`index_*` in its `cron_runs` stats), and the daily embedding backfill does the same plus
  re-checks who each chunk names; embeddings come from the existing passage phase.
  Turning the switch off deletes the account's mail chunks at once (`deleteEmailEventChunks`);
  a switch flipped in SQL is caught by the same prune on the next sweep (`pruneEmailEventChunks`).
  Gmail disconnect and an insights wipe delete them with the events. To stop it for everyone,
  drop the `indexEmailEventsForUser` call in `memory-backfill.ts` and the `runEmailEventIndexing`
  step in the sweep route, then `DELETE FROM memory_chunks WHERE source_kind = 'email_event';`.
  `SELECT count(*) FROM memory_chunks WHERE source_kind = 'email_event' GROUP BY user_id;`
  shows who is indexed.
  If a card built from mail looks wrong, `SELECT * FROM email_events WHERE id = '<id>'` (the id is
  in the card's evidence `ref`) shows what was extracted and the quote it came from.

## Managed AI keys (included AI, every plan)

Every plan includes a monthly AI allowance on Orbit's own provider keys, metered in credits (1 credit = $0.01 of model cost): `monthlyCredits` in `src/lib/plans/plan-config.ts` (Free 50 + a one-time 25 starter, Pro 300, Max 650, Lifetime 150). Only `src/lib/ai-access.ts` can issue a key (`scripts/smoke-ai-access.ts` fails the suite if anything else reads an AI key or builds a provider client). An account with its own key can prefer it in Settings; own-key calls never use credits.

- **Keys:** `ORBIT_MANAGED_ANTHROPIC_API_KEY` and `ORBIT_MANAGED_OPENAI_API_KEY`. No managed Gemini key in production. Orbit picks the route on its own key, whatever provider the account selected: `MANAGED_PROVIDER_ORDER` is Anthropic ($190/month pool) → OpenAI; Orbit never uses a managed Gemini key, and with both pools spent the user is told to add their own key, at `MANAGED_DEFAULT_MODELS` (Claude Haiku 5.5, sent at effort `low`; OpenAI `gpt-4o-mini`, `gpt-4.1-nano` for fast-tier work). Embeddings and Whisper run on OpenAI only — Anthropic has neither. Own-key calls keep the account's provider and model.
- **The pools:** `MANAGED_AI_POOLS` in `src/lib/managed-ai-policy.ts`, one per provider, summing Orbit-paid spend on that provider since its window opened (Deepgram excluded). Anthropic: $190 cap on the $200/month credit, the window restarts on the 15th (`monthlyResetDay`), so it refills by itself. OpenAI: $950 cap on the $1,000 prepaid credit, no reset — after a top-up raise `capMicros` and deploy. A spent pool drops its provider and the next one takes over; with every pool spent, included AI refuses ("Orbit's AI isn't available right now"). Checked in the same 30s-cached read as the admin switch. `/admin/billing` shows one line per pool; `ai.managed_pool:<provider>` warns at 75% (a spent monthly pool stays a warning, a spent prepaid pool is critical).
- **Admin switch:** `/admin/billing` → included AI on/paused (`site_settings.managed_ai_paused`). Never set reads as PAUSED on production — the reason users see "Orbit’s AI isn’t available right now" until someone turns it on.
- **Kill switch:** `ORBIT_MANAGED_AI=off`. Every account falls back to its own key, with that same notice.
- **Credits intro:** accounts created before `CREDITS_INTRO_LAUNCHED_AT` (`src/lib/credits-intro.ts`, set it to the ship date) get the full-screen "your AI credits are here" moment once, claimed atomically into `user_settings.credits_intro_shown_at`. It waits while included AI can't run. Replay for one account: `UPDATE user_settings SET credits_intro_shown_at = NULL WHERE user_id = '…';`. Dev preview: `?credits-intro=free|orbit|max|lifetime`.
- **Per-account cap:** the account's credits (`src/lib/credits/`). Bulk background work stops at half the monthly allowance.

**`next dev`** runs localhost demo accounts on the bare `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` names in `.env.local`, unmetered; `ORBIT_DEMO_MANAGED_AI=off` makes localhost behave like production.

## Deepgram (speech-to-text)

Deepgram is Orbit's own speech-to-text key — the first engine for voice notes, the chat
microphone and meetings, on every plan. `src/lib/deepgram.ts` is the only file that reads
`DEEPGRAM_API_KEY` / `DEEPGRAM_PROJECT_ID`, enforced by `scripts/smoke-ai-access.ts`. It is not
part of the BYOK/managed-AI gate above — Orbit pays for it on every plan, like hosted Apollo
enrichment.

- **Key:** `DEEPGRAM_API_KEY` in Vercel (Production and Preview). `DEEPGRAM_PROJECT_ID` is only
  needed for the nightly reconciliation job below, not for transcription itself.
- **Kill switch:** `ORBIT_DEEPGRAM=off` reverts every surface to the Whisper/Gemini chain
  (`deepgramEnabled()` in `deepgram.ts`). Use it if Deepgram is down or misbehaving; transcription
  keeps working, just on a different engine and without keyterm-boosted contact names.
- **Nightly reconciliation:** `POST /api/ops/speech-usage`, run daily by the GitHub Actions
  scheduler (`.github/workflows/ops.yml`). Meetings stream straight from the browser to Deepgram
  on Orbit's key and the browser self-reports its seconds into `speech_usage`, so this job
  compares Deepgram's own billed seconds per meeting (tag `meeting:<sessionId>`) against what was
  recorded and posts a `:warning:` to Slack (`ops-notify.ts`) for any meeting Deepgram reports
  more than 110% of. It never suspends anyone — a single divergent meeting could be a legitimate
  reconnect, not abuse — so treat an alert as "go look," not "go block." A run with
  `requestsSeen: 0` means the page-index assumption in `fetchDeepgramUsage` is wrong, not that
  nobody met; see the comment there before trusting a clean run again. The same run also
  reconciles the **chat mic**, in aggregate per account rather than per session (tag
  `shortform:<speechTagId>`): those seconds arrive only as a best-effort `sendBeacon` from a
  closing tab, so a crashed tab or a blocking extension is spend the meter never saw. It alerts only on
  a gap over both 110% and two minutes a day (`MIN_SHORTFORM_GAP_SECONDS`), because dictation is
  many tiny rounded sessions; a gap is usually a lost beacon, not abuse.
- **The two caps**, both in `src/lib/speech-limits.ts` (`SPEECH_LIMITS`), metered in audio
  seconds per calendar month (UTC) and enforced through `speechAllowance` in
  `src/lib/speech-quota.ts`:
  - `meeting` — Free: none; Pro: 5 hours (18,000 s); Lifetime: 10 hours (36,000 s). Paid-only by
    design; free accounts get `limit: 0` and never reach Deepgram for a meeting.
  - `shortform` (voice notes + chat mic) — Free: 1 hour (3,600 s); Pro and Lifetime: 5 hours
    (18,000 s) each. Generous on purpose: an abuse ceiling, not a meter anyone should watch.
  - Raising either is a one-line change to `SPEECH_LIMITS`; there is no `ORBIT_MANAGED_*`-style
    env var for it.
  - A cap is only enforced while Deepgram is the engine. With the kill switch on, transcription
    runs on the user’s own OpenAI/Gemini key and costs Orbit nothing, so a spent cap blocks
    nothing — pulling the lever during an incident does not also lock paying accounts out of
    recording.
- **What a tag contains:** a meeting is tagged with its own session uuid; everything short-form
  is tagged with `user_settings.speech_tag_id`, a random opaque per-account value minted on first
  use (`src/lib/speech-tag-id.ts`). Never the Clerk user id — tags persist in Deepgram’s usage
  records, which the zero-retention flag does not cover. The nightly job resolves a tag back to an
  account through `user_settings_speech_tag_uidx`; a tag nobody claims (the account deleted its
  data and minted a new value) is counted in `invalidTags` and warned under
  `job.speech-usage.unknown-tag`.

## Refund or chargeback

A **full** refund in Stripe, or a dispute that closes **lost**, withdraws access by itself:
Lifetime is cleared, a Pro subscription is marked canceled as of that moment (the webhook
resolves which one through the charge's payment intent). A partial refund changes nothing.
When refunding a Pro charge, **also cancel the subscription in Stripe** — otherwise its
next renewal re-grants Pro, correctly, because the customer is being charged again.
`/admin/health` → webhook deliveries shows `revoked: refund` / `revoked: dispute_lost` in
the delivery detail when it happened.

## Rotate a secret

| Secret | Then |
|---|---|
| `CRON_SECRET` | Update Vercel AND the GitHub `ops` workflow secret. |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET` | Roll in the dashboard, paste into Vercel, redeploy. |
| `ENCRYPTION_SECRET` | In Vercel (Production and Preview): set `ENCRYPTION_SECRET_PREVIOUS` to the current value and `ENCRYPTION_SECRET` to a new 32+ character one, then redeploy. Both are accepted from then on: stored keys and tokens are re-encrypted under the new secret as they are read, and unsubscribe links, OAuth states and rate-limit keys made with the old one keep verifying. Leave `ENCRYPTION_SECRET_PREVIOUS` set until rows that are rarely read have been touched (weeks, not days); removing it makes anything still under the old secret unreadable and old unsubscribe links stop working. |

## Restore the database

Daily encrypted dumps: the private ops repository → Actions → `backup` → artifacts (90 days).
They are kept out of this repository on purpose: a public repository's workflow artifacts can
be downloaded by anyone signed in to GitHub. Take a fresh one first with **Run workflow** if
the database is still readable.

You need `age` and a `pg_restore` at least as new as the `pg_dump` that wrote the file
(`PG_MAJOR` in the ops repository's `backup.yml`, 18 today — an older one stops with "unsupported version in file
header"). On a Mac: `brew install age postgresql@18`, then use
`$(brew --prefix postgresql@18)/bin/pg_restore`.

```bash
age -d -i backup-key.txt orbit-YYYY-MM-DD.pgc.age > orbit.pgc
# into a NEW Neon branch, never straight onto main:
pg_restore --clean --if-exists --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc
```

Check `select count(*) from contacts;`, point a preview at the branch, then promote the
branch in Neon (or set `DATABASE_URL` to it) once it looks right.

When Neon upgrades the project's Postgres major, raise `PG_MAJOR` in the ops repository's `backup.yml` the same
day: pg_dump refuses a server newer than itself, and the backup fails (and pages) until then.

### Restore drill log

A backup you have never restored is a hope. Run the restore above into a throwaway Neon
branch after any change to the ops repository's `backup.yml` and at least once a quarter, then delete the branch.
Check the same three counts against production each time:

```sql
SELECT (SELECT count(*) FROM contacts)      AS contacts,
       (SELECT count(*) FROM interactions)  AS interactions,
       (SELECT count(*) FROM user_settings) AS accounts;
```

| Date | Artifact | Download → restore finished | Row counts (contacts / interactions / accounts), restored vs prod | Who | Notes |
|---|---|---|---|---|---|
| _not yet run_ | | | | | |

The workflow's own steps were exercised on Sep 15 2026 in an `ubuntu:24.04` container
against a disposable Postgres 18 (guard, pinned install, pipefail, dump → encrypt → decrypt →
restore of 250 rows, Slack page). That is not a drill: it never touched production or GitHub's
runner. The first real drill needs the secrets set.

## Neon one-time settings

- `ALTER ROLE <app role> SET statement_timeout = '20s';` — bounds a runaway query; the
  HTTP driver cannot set this per session. **Verify it**: `curl -H "Authorization: Bearer $HEALTH_TOKEN" /api/health`
  reports `config.statementTimeout`. `"0"` means unbounded — the ALTER ROLE never ran, or ran
  on the wrong role.
- Verify the restore window under Project → Settings.
- **JIT off for the app role.** With Postgres's default `jit = on`, a large sequential scan
  compiles before it runs: the contacts search took 1.78 s with JIT and 0.67 s without at
  100k contacts (`PERFORMANCE_AUDIT.md` §1.3). Check and set:
  ```sql
  SHOW jit;                                  -- as the app role
  ALTER ROLE <app role> SET jit = off;       -- new connections pick it up
  ```
  The HTTP driver opens a connection per request, so this applies on the next one.

## Database performance checks (Neon)

Quarterly, or after a release that adds indexes (`SCALE_DDL` in `src/db/index.ts`).

- **Indexes nobody reads.** Every index costs every write to its table. On the production
  branch, after at least a week of traffic since the last stats reset:
  ```sql
  SELECT relname AS table, indexrelname AS index, idx_scan,
         pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes
   WHERE schemaname = 'public' AND idx_scan = 0
   ORDER BY pg_relation_size(indexrelid) DESC;
  ```
  An unused index is a candidate, not a verdict: check that it is not a unique constraint, a
  foreign-key lookup a rare delete needs, or a path only a monthly job takes. Drop it in the
  DDL (with a schema version bump), never by hand.
- **Slowest statements.** With `pg_stat_statements` enabled on the project:
  ```sql
  SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time) AS mean_ms,
         rows, left(query, 120) AS query
    FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
  ```
  Compare against the local profile (`scripts/dev/perf/`, see `docs/performance.md`); a
  statement here that the seeded profile does not show is a plan that only production data
  produces.
