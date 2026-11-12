# Deployment

How code reaches production, what runs on a schedule, and how to back out. Incident steps are in
[RUNBOOK.md](RUNBOOK.md), variables in [ENVIRONMENT.md](ENVIRONMENT.md).

## The path to production

1. **Merge to `main`.** Vercel's Git integration builds every push to `main` as Production *(verify in
   Vercel)*. CI (`.github/workflows/ci.yml`: typecheck + lint + build, 3 smoke shards, Playwright) runs at
   the same time. `ci.yml` itself says `main` has no required status checks (branch protection only blocks
   deletion and force-pushes) *(verify in GitHub)*, so **a red CI does not block the deploy: check CI before
   merging.** CI skips docs-only changes via `paths-ignore` (`docs/RUNBOOK.md` is re-included because
   `scripts/smoke-schedules.ts` parses it).
2. **Ignored Build Step** (`scripts/vercel-ignore-build.sh`). Production always builds. Other
   branches build previews, except `claude/*` branches without a PR (push again after opening the
   PR, or put `[deploy]` in the commit message).
3. **Build command** (`vercel.json`): `npm run check:env && npm run db:migrate && next build`.
   - `check:env` refuses a production build that is missing a required variable or has a malformed
     one.
   - `db:migrate` (`scripts/migrate.ts`):
     1. Refuses on Vercel without `DATABASE_URL`.
     2. Refuses on a preview if the host equals `PRODUCTION_DB_HOST`.
     3. Takes the `schema_migration_lock` lease (`BUILD_MIGRATION_LOCK_WAIT_MS`: waits 3 minutes, then sweeps
        anyway) and applies the idempotent DDL sweep.
     4. Stamps `schema_migrations` (never lowering it).
     5. Fails the build on any failed statement or a column or index that `schema.ts` declares but the DDL never
        created.
     6. **Writes data**: a bounded `contact_identities` backfill (2,000 per deploy) and confident
        duplicate merges (100 per account). Both are non-fatal.
   - `next build`: Sentry uploads source maps when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
     `SENTRY_PROJECT` are set.
4. **Alias.** Only a green build is promoted. A failed build leaves the previous deployment live,
   and the ops sweep raises `deploy.drift` once `main` has been ahead for a while (the `ops` workflow
   tells the sweep where `main` is).
5. **Verify.** `GET /api/health` should show `sha` equal to main's head, `status: "ok"`, and
   `schema.recorded == schema.expected` (`src/lib/health.ts`).

> **The migration runs before `next build`.** If the build fails, the database is already on the
> new schema while the old code serves (health: `degraded`, `schema.ahead`). Every schema change
> must therefore be safe for the code currently in production: **add first; remove the code; drop
> only in a later deploy.**

## Schema changes

Follow the checklist in [ARCHITECTURE.md](ARCHITECTURE.md#how-the-schema-is-applied) and
[CONTRIBUTING.md](../CONTRIBUTING.md). `npm run db:check` fails when DDL changed without a `SCHEMA_VERSION`
bump. Apply schema changes with `npm run db:migrate`; `drizzle-kit` is no longer a dependency.

## Preview deployments

Previews run the same build command, so **they migrate whatever database they're given**. The
required setup *(verify in Vercel)*:
- `DATABASE_URL` scoped to Production only, with previews on a Neon branch;
- `PRODUCTION_DB_HOST` on all environments;
- test-mode Clerk and Stripe keys on Preview.

Known limits:
- Previews don't record analytics.
- Internal job continuations go to `APP_BASE_URL`, or the production domain when that is unset, so
  long imports stall on a preview.

## Scheduled jobs

`vercel.json` has no crons. `.github/workflows/ops.yml` is the only scheduler (ten `cron:` lines, plus manual
`workflow_dispatch`). Each step needs the `APP_URL` and `CRON_SECRET` repository secrets and a 200 from
`/api/health`; the workflow fails loudly if either secret is missing, and pages
`SLACK_OPS_CRITICAL_WEBHOOK_URL` if health is down. Each schedule has its own concurrency group.

| Schedule (UTC) | Route | Job |
|---|---|---|
| every 10 min | `POST /api/ops/sweep`, `/api/webhooks/outbound/drain`, `/api/connectors/outbox/drain`, `/api/email/drain`, `/api/credits/notices` | ops sweep and alerts, outbound webhooks, connector write-back, email outbox, credit emails |
| every 15 min | `POST /api/sync/run` | provider sync (calendars, contacts, mailbox activity, events) |
| :07 hourly | `GET /api/imports/process-stalled` | stalled import and capture-job backstop, resume of stranded account purges, expired-hold and orphan sweeps (Clerk orphans, avatars, staging, attachments) |
| :23 hourly | `POST /api/jobs/feed/sweep` | job-postings feed |
| :37 hourly | `POST /api/work-history/sweep` | work-history research |
| :53 hourly | `POST /api/radar/feeds/sweep` | Radar news feeds |
| :29 and :59 | `POST /api/cloud-notes/run` | cloud notes scan |
| :13 every hour, Sunday and Monday (`13 * * * 0,1`) | `POST /api/radar/digest` | Radar Monday email (sends to people whose own Monday morning it is) |
| 04:17 daily | `POST /api/radar/run` | Radar nightly pass |
| 05:41 daily | `POST /api/ops/speech-usage` | Deepgram usage reconciliation |

GitHub schedules can lag 5–30 minutes. On a public repo they are **disabled after 60 days without a
commit**. Better Stack's heartbeat (pinged by the sweep) catches that; see RUNBOOK → Scheduled
workflows were disabled.

## Backups

A daily `age`-encrypted `pg_dump` runs from the **private ops repository** (90-day artifacts; Better Stack
alerts after 36 hours without a heartbeat) *(verify: the workflow isn't in this repository; commit `77d28a7`
moved it out because a public repository's artifacts are downloadable)*. Restore steps are in RUNBOOK →
Restore the database. Take a manual backup before any risky migration. **The restore drill has never been
run; record it in RUNBOOK → Restore drill log.**

## Rolling back

Vercel → Deployments → last good → **Promote to Production**. Before you do:

- **Schema changes are not all additive.** Pick a deployment newer than the last dropped table or column. Old
  code selects every column in its own `schema.ts`, and the sweep has dropped the `guest_profiles` table
  (v170) and columns `user_settings.wispr_api_key_encrypted` and `user_settings.radar_apollo_cursor`
  (`src/db/index.ts`, search for `DROP`). It also drops and re-adds the generated `contacts.linkedin_slug` and
  `search_tsv` columns when their expression changes.
- **Rotated secrets roll back too.** Vercel freezes env values per deployment, so promoting an old one restores
  the values it was built with. Re-check `CRON_SECRET` (it must match the GitHub secret), the webhook secrets and
  the managed AI keys if any were rotated since.
- Data written by the newer build's migration (the identity backfill, duplicate merges) stays.

Afterwards health reads `degraded` / `schema.ahead`, and `deploy.drift` stays open until you fix
forward. A 503 `schema_mismatch` means the database is **behind** the code; investigate that
immediately.

## Sentry

Server and edge: `release = VERCEL_GIT_COMMIT_SHA`, `environment = VERCEL_ENV`. Browser
(`src/lib/sentry-browser.ts`): the environment comes from `NEXT_PUBLIC_VERCEL_ENV`, which needs Vercel's
"Automatically expose System Environment Variables" setting *(verify)*. Source maps upload during the Vercel build; CI disables the upload.

## Browser extension

The extension isn't deployed by Vercel (`.vercelignore`). CI (`extension.yml`) only typechecks and
builds it. To release:
1. Bump `extension/package.json` `version`.
2. `npm run ext:zip` builds `extension/release/orbit-<version>.zip` from `extension/.env.production`.
3. Upload it to the Chrome Web Store by hand (`extension/scripts/zip.mjs` refuses dev-named or localhost builds).
4. Make sure Vercel Production has `EXTENSION_ORIGIN=chrome-extension://<pinned id>`.

## Where secrets live

| Store | Holds |
|---|---|
| Vercel (Production / Preview) | app runtime and build variables |
| GitHub, this repo | `APP_URL`, `CRON_SECRET`, `SLACK_OPS_CRITICAL_WEBHOOK_URL` |
| GitHub, private ops repo | backup `DATABASE_URL`, `BACKUP_AGE_PUBLIC_KEY`, Slack and Better Stack URLs |
| Password manager | the age private key |

Rotating `CRON_SECRET` means updating Vercel **and** GitHub, then redeploying (RUNBOOK → Rotate a
secret).

## Related

- Variable reference: [ENVIRONMENT.md](ENVIRONMENT.md).
- REST API spec: `GET /api/v1/openapi.json`; MCP and chat tools: [MCP.md](MCP.md).

## Not verifiable from the repository

Vercel env scoping and the preview database wiring; branch protection; the Vercel Node and install
settings; system env var exposure; the private ops repo; Better Stack monitors; Sentry alert rules;
Neon `statement_timeout` and the PITR window; the Clerk `orbit:*` scopes; and the state of
`MCP_OAUTH_REQUIRE_SCOPES` and `CSP_ENFORCE`.
