# Orbit runbook

What to do when something is wrong, and how the routine things are done. Short on purpose.

## Where to look

| Signal | Where |
|---|---|
| Something is down | Better Stack monitor on `/api/health` → `#orbit-ops-critical` |
| A known condition opened / recovered | ops sweep → `#orbit-ops` (critical also → `#orbit-ops-critical`) |
| An exception nobody anticipated | Sentry (linked from `/admin/health`) |
| What is open right now | `/admin/health` → System status strip and Open alerts |
| Deep probe | `GET /api/health?token=$HEALTH_TOKEN` |
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

1. `/admin/health` → "Ops sweep" tile. Quiet for over 30 min means the GitHub schedule is
   not firing: Actions → `ops` → is the workflow disabled (60 idle days on a public repo)?
   Re-enable it, or run it with **Run workflow**.
2. "Nightly job" tile red: trigger it by hand —
   `curl -H "Authorization: Bearer $CRON_SECRET" https://orbit.jasonpereira.live/api/imports/process-stalled`
   A 401 means `CRON_SECRET` differs between Vercel and GitHub.

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
| `deploy.drift` | A build is failing. Vercel → Deployments → open the red one → fix → push. |
| `config.missing` | Vercel → Environment Variables. The alert names the variable. |
| `config.alerts_undeliverable` | Slack → your app → Incoming Webhooks → copy the URL → Vercel → Environment Variables → `SLACK_OPS_WEBHOOK_URL` (Production) → Redeploy. Until then `/admin/health` is the only place alerts appear. |
| `ai.provider_outage:*` | Not ours; it clears when the provider recovers. |
| `perf.slow_burst` | `/admin/health` → error events → `perf.slow` rows name the call and account. |

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
