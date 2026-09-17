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
| `ai.managed_failing:*` | Orbit's own key for that provider was refused or throttled — every Lifetime account without a key of its own has lost AI. Check the key and its quota in the provider console; replace `ORBIT_MANAGED_<PROVIDER>_API_KEY` in Vercel and redeploy. |
| `ai.managed_unconfigured` | Lifetime accounts exist but no `ORBIT_MANAGED_*_API_KEY` is set (or `ORBIT_MANAGED_AI=off`). Set one, or accept that Lifetime is BYOK until you do. |
| `ai.managed_spend_spike` / `ai.managed_runway` | Managed spend is outrunning what Lifetime brought in. `/admin/billing/costs` → "On Orbit's AI keys". Lower `MANAGED_AI_BUDGET` in `src/lib/managed-ai-policy.ts`, or in an emergency set `ORBIT_MANAGED_AI=off` and redeploy. |
| `ai.managed_cap_hit` | Info: accounts used their whole monthly allowance. A rising count means the cap is too tight for real use. |

## Managed AI keys (Orbit Lifetime)

AI is bring-your-own-key on every plan except Lifetime. A Lifetime account with no key of its own runs on Orbit's managed keys, and only `src/lib/ai-access.ts` can issue one (`scripts/smoke-ai-access.ts` fails the suite if anything else reads an AI key or builds a provider client).

- **Keys:** `ORBIT_MANAGED_GEMINI_API_KEY` (cheapest, preferred), `ORBIT_MANAGED_OPENAI_API_KEY`, `ORBIT_MANAGED_ANTHROPIC_API_KEY`, `ORBIT_MANAGED_WISPR_API_KEY`. Production only reads these names; the bare `GEMINI_API_KEY`-style names work off Vercel only.
- **Kill switch:** `ORBIT_MANAGED_AI=off`. Every Lifetime account falls back to BYOK, with the notice "Orbit’s AI isn’t available right now — add your own API key".
- **Cap:** `MANAGED_AI_BUDGET` in `src/lib/managed-ai-policy.ts`, per account per calendar month (UTC), metered from `usage_events` where `key_owner = 'orbit'`. Bulk background work stops at half.
- **Revocation:** anything that takes Lifetime away takes managed AI away on the account's next AI call — there is no cache to clear. Today that is removing a comp in `/admin`; a full refund or a lost dispute does it once the launch plan's P0 revocation (`revokeLifetimePurchase`) lands. Until then, refund a Lifetime purchase AND clear `lifetime_purchased_at` by hand.

## Rotate a secret

| Secret | Then |
|---|---|
| `CRON_SECRET` | Update Vercel AND the GitHub `ops` workflow secret. |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET` | Roll in the dashboard, paste into Vercel, redeploy. |
| `ENCRYPTION_SECRET` | Do not rotate casually: it decrypts every user's BYOK key and OAuth token. Rotation means re-encrypting them all. |

## Restore the database

Daily encrypted dumps: GitHub → Actions → `backup` → artifacts (90 days). Take a fresh one
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
  HTTP driver cannot set this per session. **Verify it**: `GET /api/health?token=$HEALTH_TOKEN`
  reports `config.statementTimeout`. `"0"` means unbounded — the ALTER ROLE never ran, or ran
  on the wrong role.
- Verify the restore window under Project → Settings.
