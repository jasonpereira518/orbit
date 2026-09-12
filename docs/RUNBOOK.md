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
additive and idempotent, so old code runs fine on a newer schema. Then fix forward.

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
| `import.wedged` / `import.failed_burst` | `/admin/health` → Failed and stalled imports → Retry. After 3 stalled resumes the job is marked failed with a message; the user re-uploads. |
| `deploy.drift` | A build is failing. Vercel → Deployments → open the red one → fix → push. |
| `config.missing` | Vercel → Environment Variables. The alert names the variable. |
| `ai.provider_outage:*` | Not ours; it clears when the provider recovers. |
| `perf.slow_burst` | `/admin/health` → error events → `perf.slow` rows name the call and account. |

## Rotate a secret

| Secret | Then |
|---|---|
| `CRON_SECRET` | Update Vercel AND the GitHub `ops` workflow secret. |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET` | Roll in the dashboard, paste into Vercel, redeploy. |
| `ENCRYPTION_SECRET` | Do not rotate casually: it decrypts every user's BYOK key and OAuth token. Rotation means re-encrypting them all. |

## Restore the database

Weekly encrypted dumps: GitHub → Actions → `backup` → artifacts (90 days). Take a fresh one
first with **Run workflow** if the database is still readable.

```bash
age -d -i backup-key.txt orbit-YYYY-MM-DD.pgc.age > orbit.pgc
# into a NEW Neon branch, never straight onto main:
pg_restore --clean --if-exists --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc
```

Check `select count(*) from contacts;`, point a preview at the branch, then promote the
branch in Neon (or set `DATABASE_URL` to it) once it looks right.

## Neon one-time settings

- `ALTER ROLE <app role> SET statement_timeout = '20s';` — bounds a runaway query; the
  HTTP driver cannot set this per session.
- Verify the restore window under Project → Settings.
