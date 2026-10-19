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
| Deep probe | `GET /api/health?token=$HEALTH_TOKEN` — a wrong token answers 401 |
| Which code is live | `/api/health` → `sha` (compare with `main`) |

## Deploy

Push to `main`. CI (`typecheck · lint · build`, `smoke suite`) must be green; Vercel then
runs `npm run check:env && npm run db:migrate && next build`. A missing production
variable or a failing DDL statement fails the build and the previous deployment stays live.

**A `claude/*` branch with no pull request does not build a preview.** Vercel's Ignored Build
Step (`vercel.json` → `scripts/vercel-ignore-build.sh`) skips it, because every retained
deployment's function bundles count against Functions Storage. It builds once the branch has a
PR and gets a push. To get a preview sooner, put `[deploy]` in the commit message, or redeploy
from the dashboard. Everything else (main, other branches, production) always builds.

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
| `billing.cancel_stuck` | A deleted account's Stripe subscription would not cancel, three times running. `SELECT stripe_customer_id, attempts, last_error FROM billing_cancellation_queue;` Cancel each subscription in Stripe → Customers → that id (refund the period if it charged after the deletion), then `DELETE FROM billing_cancellation_queue WHERE stripe_customer_id = '<id>';`. The person has no account left to do it from. |
| `purge.stuck` | `SELECT id, target_user_id, last_error, completed_steps FROM data_purge_runs WHERE status = 'failed';` Fix the cause `last_error` names, then requeue: `UPDATE data_purge_runs SET status = 'running', attempts = 0, last_attempt_at = now() - interval '1 hour' WHERE id = '<id>';` The next nightly run finishes it (or trigger `/api/imports/process-stalled`). |
| `cron.partial_streak` | `/admin/health` → Nightly job → the run's stats. Each housekeeping step in `src/app/api/imports/process-stalled/route.ts` is its own try/catch; the one whose counter stays at zero is failing. Sentry has the exception. |
| `drain.failed` | No outbound webhook is being retried. Run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/webhooks/outbound/drain`; a 500 means the drain throws — Sentry has it. |
| `radar.schedule_missed` | Radar's nightly pass started once and then went quiet for over 30 hours, so nobody's list is being refreshed overnight. Check the ops workflow ran the 04:17 step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/radar/run`. Pages still rebuild a list older than a day when someone opens Radar. |
| `radar.run_failed` | The last nightly pass failed or was killed at the 300 s ceiling. Read its `cron_runs` row and the `job.radar` / `job.radar.user` errors, fix, then run it by hand with the same `curl`. One account failing marks the pass `partial`, which is not an alert. |
| `radarfeeds.schedule_missed` | Radar's hourly news sweep started once and then went quiet for over six hours, so headlines about people's companies stop arriving (cards still come from everything else). Check the ops workflow ran the :53 step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/radar/feeds/sweep`. |
| `radarfeeds.run_failed` | The last news sweep failed or was killed. Read its `cron_runs` row and the `job.radar.feeds` error. One feed being down marks the sweep `partial`, which is not an alert; `external_sources.consecutive_failures` says which feed and for how long. To turn a feed off, set its `enabled` to false. |
| `radardigest.schedule_missed` | Radar's Monday email, which runs hourly through Sunday and Monday UTC, has not started for six days, so a whole Sunday passed without a run and nobody gets their weekly list. Check the ops workflow ran the `13 * * * 0,1` step, then run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://myorbitnetwork.com/api/radar/digest`. A run outside someone's Monday 06:00–09:00 sends them nothing, and the week claim means a repeated run never sends twice. |
| `radardigest.run_failed` | The last Monday-email run failed or was killed. Read its `cron_runs` row and the `job.radar.digest` error. A send Resend refused marks the run `partial`, which is not an alert: that person's claim is released and the next hour retries; the `resend.rejected` error (kind `radar.digest`) carries Resend's reason, recorded once per run. `notConfigured` in the stats means `RESEND_API_KEY` or `RESEND_FROM_EMAIL` is unset. To stop the email for everyone, hide `page.radar`; for one person, set their `radar_digest_enabled` to 0. |
| `backfill.failed` | `/admin/health` → error events, source `backfill.failed`: `kind` names the backfill, `message` says why. Two or more accounts means it is not one user's key — check the provider status panel and `ai.provider_outage`. |
| `config.statement_timeout_unbounded` | Run `ALTER ROLE <app role> SET statement_timeout = '20s';` (Neon one-time settings below), then confirm `GET /api/health?token=$HEALTH_TOKEN` shows `config.statementTimeout: "20s"`. It clears on the next sweep. |
| `embedding.backlog` | Check `backfill.failed`, `embedding.unembeddable` and `ai.provider_outage` first. One account: usually that user's key (they already see an account alert). Several: `/admin/health` → Nightly job stats — `embeddingsGenerated` 0 with `embeddingBackfillsKicked` > 0 means every kick is failing. |
| `sync.lagging` | More connections are due than a run syncs (20 per run, 4 at a time). `sync.run` stats: `budgetExhausted` true on every run means the budget is the limit — raise `CONNECTIONS_PER_RUN` in `src/lib/sync-scheduler.ts` or schedule more often (Vercel Pro crons); many `failed` means a provider problem. |
| `embedding.unembeddable` | `SELECT error_kind, source_type, count(*) FROM embedding_failures WHERE failed_at > now() - interval '1 day' GROUP BY 1, 2;`. One kind on one provider across users is a provider change (check its status page and changelog); the rows retry once the bisect in `src/lib/embedding-backfill.ts` can embed them. |
| `ai.quota_failures` | Informational. Users with an empty provider balance already see a "top up" account alert. Many at once on Orbit's own key (`key_owner = 'orbit'`, local dev only) means topping up that account. |
| `calendar.disarmed` | `SELECT sync_error, count(*) FROM gmail_connections WHERE next_sync_at IS NULL AND sync_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;` One error string across many accounts is Google's side (API change, consent-screen or scope change, project quota in Google Cloud Console). Users reconnect from the Integrations dialog once it is fixed. |
| `avatar.source_exhausted` | Informational: that source's shared daily allowance (`RATE_LIMITS.avatarSourceShared`) is gone and photo lookups wait for tomorrow. Daily before noon means raising the budget or buying the source's paid plan (`MICROLINK_API_KEY` skips the shared Microlink budget). |
| `apollo.hosted_cap_hits` | Informational: accounts used their daily hosted Apollo allowance (`RATE_LIMITS.apolloSearch` / `apolloEnrich`). Compare with the Apollo plan's credits before raising either. |
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

Radar (`src/lib/radar/`) is the nightly "who to reach out to" list, with its news sweep and
Monday email. Every switch, smallest first:

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
- **All of Radar:** hide `page.radar` in `/admin/product`. The nightly pass, the news sweep and
  the Monday email all stand down, and no AI key is spent.
- **Coming soon or released:** Radar ships coming soon (`comingSoon: true` on `page.radar` in
  `src/lib/surfaces.ts`). Either way round can be flipped without a deploy from the coming-soon
  toggle in `/admin/product` (a `live:page.radar` or `soon:page.radar` row, which wins over the
  code), or in code by deleting or restoring that line. While it is coming soon, the nightly
  pass runs only for accounts that have opened Radar (admins previewing it, plus anyone who
  opened it while it was out), the news sweep runs only once one of them has had a pass, and the
  Monday email sends nothing. Once released, the pass claims every account active in the last
  60 days and the email goes to active accounts with a pending card. It was released on Sep 30
  2026 (#380) and put back behind coming soon the same day.

## Managed AI keys (included AI, every plan)

Every plan includes a monthly AI allowance on Orbit's own provider keys, metered in credits (1 credit = $0.01 of model cost): `monthlyCredits` in `src/lib/plans/plan-config.ts` (Free 50 + a one-time 25 starter, Pro 300, Max 650, Lifetime 150). Only `src/lib/ai-access.ts` can issue a key (`scripts/smoke-ai-access.ts` fails the suite if anything else reads an AI key or builds a provider client). An account with its own key can prefer it in Settings; own-key calls never use credits.

- **Keys:** `ORBIT_MANAGED_ANTHROPIC_API_KEY` and `ORBIT_MANAGED_OPENAI_API_KEY`. No managed Gemini key in production. Orbit picks the route on its own key, whatever provider the account selected: `MANAGED_PROVIDER_ORDER` is Anthropic → OpenAI → Gemini, at `MANAGED_DEFAULT_MODELS` (Claude Haiku 5.5, sent at effort `low`; OpenAI `gpt-4o-mini`, `gpt-4.1-nano` for fast-tier work). Embeddings and Whisper run on OpenAI only — Anthropic has neither. Own-key calls keep the account's provider and model.
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

## A privacy request from someone who is not a user

People in users' networks never signed up, but they can ask what Orbit holds about them or
ask to be removed. Users answer for their own records (Terms: they are the controller), but
Orbit controls the waitlist, the shared recruiter directory and the shared LinkedIn photo
cache, and is the only one who can see across accounts.

1. **Log it** (date, who, what they asked) before doing anything. Deadlines vary by law; aim to
   answer within 30 days.
2. **Confirm it is them**: reply from the address they gave, or ask them to, before
   disclosing anything.
3. **Look them up**, from a machine with production's `DATABASE_URL`:
   `npx tsx scripts/privacy-lookup.ts --email <address>` and/or `--linkedin <profile url>`.
   It reports which kinds of record hold them and which accounts, never what the records say.
   Do not open those accounts' contact records to read them.
4. **Tell them** which kinds of record exist and how many accounts hold them. Do not name the
   account holders.
5. **If they ask to be removed**:
   - Data Orbit controls: delete their waitlist row from `/admin/interest-list` and their
     `linkedin_avatars` entry. In the shared directory, clear the pooled contact fields
     (`UPDATE recruiters SET email = NULL, email_normalized = NULL, phone = NULL,
     linkedin_url = NULL WHERE id = '<id>';`) — do **not** delete the row: `user_recruiter_links`
     and `recruiter_messages` cascade from it, and those are users' own records.
   - Users' own records: tell each account holder (from the lookup) that this person asked to be
     removed, and ask them to delete the contact. Whether Orbit may or must delete those
     records itself is an open legal question (PRIVACY_PLAN.md §6, Q3); until it is answered,
     do not.
6. **Close the log** with what was done and when.

## Rotate a secret

| Secret | Then |
|---|---|
| `CRON_SECRET` | Update Vercel AND the GitHub `ops` workflow secret. |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET` | Roll in the dashboard, paste into Vercel, redeploy. |
| `ENCRYPTION_SECRET` | Do not rotate casually: it decrypts every user's BYOK key and OAuth token. Rotation means re-encrypting them all. |

## Restore the database

Daily encrypted dumps: the private ops repository → Actions → `backup` → artifacts (90 days).
They are kept out of this repository on purpose: a public repository's workflow artifacts can
be downloaded by anyone signed in to GitHub. Take a fresh one first with **Run workflow** if
the database is still readable.

You need `age` and a `pg_restore` at least as new as the `pg_dump` that wrote the file
(`PG_MAJOR` in `backup.yml`, 18 today — an older one stops with "unsupported version in file
header"). On a Mac: `brew install age postgresql@18`, then use
`$(brew --prefix postgresql@18)/bin/pg_restore`.

```bash
age -d -i backup-key.txt orbit-YYYY-MM-DD.pgc.age > orbit.pgc
# into a NEW Neon branch, never straight onto main:
pg_restore --clean --if-exists --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc
```

Check `select count(*) from contacts;`.

**Before promoting, re-apply every deletion made after the dump was taken.** The dump predates
them, so every account deleted since is back in the restored copy. Production's
`deletion_tombstones` (keyed hashes, kept 120 days) records them:

```bash
# DRY RUN first: lists what it would purge. --since = when the dump was taken (artifact time).
DATABASE_URL="$BRANCH_URL" TOMBSTONE_SOURCE_URL="$PRODUCTION_URL" ENCRYPTION_SECRET="<production's>" \
  npx tsx scripts/replay-deletions.ts --since 2026-10-01T03:00:00Z
# then the same command with --apply
```

It must run with production's `ENCRYPTION_SECRET` (the hashes are keyed by it). It also
re-queues the Stripe cancel for each purged account. If production itself is unreadable (the
reason for the restore), replay from the newest tombstones you can read — an older dump of
production carries the table too — and note the gap in the drill log.

Then point a preview at the branch, and promote it in Neon (or set `DATABASE_URL` to it) once
it looks right.

When Neon upgrades the project's Postgres major, raise `PG_MAJOR` in `backup.yml` the same
day: pg_dump refuses a server newer than itself, and the backup fails (and pages) until then.

### Restore drill log

A backup you have never restored is a hope. Run the restore above into a throwaway Neon
branch after any change to `backup.yml` and at least once a quarter, then delete the branch.
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
  HTTP driver cannot set this per session. **Verify it**: `GET /api/health?token=$HEALTH_TOKEN`
  reports `config.statementTimeout`. `"0"` means unbounded — the ALTER ROLE never ran, or ran
  on the wrong role.
- Verify the restore window under Project → Settings.
