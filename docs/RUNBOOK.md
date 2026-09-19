# Orbit runbook

What to do when something is wrong, and how the routine things are done. Short on purpose.

## Where to look

| Signal | Where |
|---|---|
| Something is down | Better Stack monitor on `/api/health` → `#orbit-ops-critical` |
| Backups stopped (`backup.stale`) | Better Stack heartbeat "orbit backup" (36 h without a ping) → `#orbit-ops-critical`; then GitHub → Actions → `backup` |
| A known condition opened / recovered | ops sweep → `#orbit-ops` (critical also → `#orbit-ops-critical`) |
| An exception nobody anticipated | Sentry (linked from `/admin/health`) |
| What is open right now | `/admin/health` → System status strip and Open alerts |
| Deep probe | `GET /api/health?token=$HEALTH_TOKEN` — a wrong token answers 401 |
| Which code is live | `/api/health` → `sha` (compare with `main`) |

## Deploy

Push to `main`. CI (`typecheck · lint · build`, `smoke suite`) must be green; Vercel then
runs `npm run check:env && npm run db:migrate && next build`. A missing production
variable or a failing DDL statement fails the build and the previous deployment stays live.

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
   `curl -H "Authorization: Bearer $CRON_SECRET" https://orbit.jasonpereira.live/api/imports/process-stalled`
   A 401 means `CRON_SECRET` differs between Vercel and GitHub.

## Scheduled workflows were disabled (GitHub's 60-day rule)

GitHub disables a public repository's scheduled workflows after 60 days without repository
activity. That stops `ops` (sweep, process-stalled, drain, connector sync) and `backup` at once;
the Better Stack heartbeat goes quiet within 30 minutes.

```bash
gh api repos/jasonpereira518/orbit/actions/workflows --jq '.workflows[] | [.name, .state] | @tsv'
# a disabled one reads "disabled_inactivity"
gh workflow enable ops.yml --repo jasonpereira518/orbit
gh workflow enable backup.yml --repo jasonpereira518/orbit
gh workflow run ops.yml --repo jasonpereira518/orbit
gh workflow run backup.yml --repo jasonpereira518/orbit
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
| `drain.failed` | No outbound webhook is being retried. Run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://orbit.jasonpereira.live/api/webhooks/outbound/drain`; a 500 means the drain throws — Sentry has it. |
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
| `ai.managed_failing:*` | Orbit's own key for that provider was refused or throttled — every Lifetime account without a key of its own has lost AI. Check the key and its quota in the provider console; replace `ORBIT_MANAGED_<PROVIDER>_API_KEY` in Vercel and redeploy. |
| `ai.managed_unconfigured` | Lifetime accounts exist but no `ORBIT_MANAGED_*_API_KEY` is set (or `ORBIT_MANAGED_AI=off`). Set one, or accept that Lifetime is BYOK until you do. |
| `ai.managed_spend_spike` / `ai.managed_runway` | Managed spend is outrunning what Lifetime brought in. `/admin/billing/costs` → "On Orbit's AI keys". Lower `MANAGED_AI_BUDGET` in `src/lib/managed-ai-policy.ts`, or in an emergency set `ORBIT_MANAGED_AI=off` and redeploy. |
| `ai.managed_cap_hit` | Info: accounts used their whole monthly allowance. A rising count means the cap is too tight for real use. |

## Managed AI keys (Orbit Lifetime) — NOT SHIPPED

**Currently off.** `MANAGED_AI_ENABLED = false` in `src/lib/managed-ai-policy.ts`: AI is bring-your-own-key on every deployed plan, Lifetime included, and no `ORBIT_MANAGED_*` variable is read anywhere. Setting one does nothing. Turning managed AI on is that flag plus the public copy (pricing, `/privacy`, `/terms`, which bumps `TERMS_VERSION`). The rest of this section describes the dormant path.

**The one exception is `next dev`**, which runs AI on the bare `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `WISPR_API_KEY` names in the developer's `.env.local` (`localDevAiEnabled` in `ai-access.ts`: managed AI off, `VERCEL` unset, `NODE_ENV=development` — a deployment is none of these). A key saved in Settings still wins, and `ORBIT_DEMO_MANAGED_AI=off` turns it off to see the production BYOK states.

AI is bring-your-own-key on every plan except Lifetime. A Lifetime account with no key of its own runs on Orbit's managed keys, and only `src/lib/ai-access.ts` can issue one (`scripts/smoke-ai-access.ts` fails the suite if anything else reads an AI key or builds a provider client).

- **Keys:** `ORBIT_MANAGED_GEMINI_API_KEY` (cheapest, preferred), `ORBIT_MANAGED_OPENAI_API_KEY`, `ORBIT_MANAGED_ANTHROPIC_API_KEY`, `ORBIT_MANAGED_WISPR_API_KEY`. Production only reads these names; the bare `GEMINI_API_KEY`-style names work off Vercel only.
- **Kill switch:** `ORBIT_MANAGED_AI=off`. Every Lifetime account falls back to BYOK, with the notice "Orbit’s AI isn’t available right now — add your own API key".
- **Cap:** `MANAGED_AI_BUDGET` in `src/lib/managed-ai-policy.ts`, per account per calendar month (UTC), metered from `usage_events` where `key_owner = 'orbit'`. Bulk background work stops at half.
- **Revocation:** anything that takes Lifetime away takes managed AI away on the account's next AI call — there is no cache to clear. Today that is removing a comp in `/admin`; a full refund or a lost dispute does it once the launch plan's P0 revocation (`revokeLifetimePurchase`) lands. Until then, refund a Lifetime purchase AND clear `lifetime_purchased_at` by hand.

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
| `ENCRYPTION_SECRET` | Do not rotate casually: it decrypts every user's BYOK key and OAuth token. Rotation means re-encrypting them all. |

## Restore the database

Daily encrypted dumps: GitHub → Actions → `backup` → artifacts (90 days). Take a fresh one
first with **Run workflow** if the database is still readable.

You need `age` and a `pg_restore` at least as new as the `pg_dump` that wrote the file
(`PG_MAJOR` in `backup.yml`, 18 today — an older one stops with "unsupported version in file
header"). On a Mac: `brew install age postgresql@18`, then use
`$(brew --prefix postgresql@18)/bin/pg_restore`.

```bash
age -d -i backup-key.txt orbit-YYYY-MM-DD.pgc.age > orbit.pgc
# into a NEW Neon branch, never straight onto main:
pg_restore --clean --if-exists --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc
```

Check `select count(*) from contacts;`, point a preview at the branch, then promote the
branch in Neon (or set `DATABASE_URL` to it) once it looks right.

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
