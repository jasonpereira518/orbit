# 9. Migrations run in the Vercel build, before next build

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`vercel.json` sets the build command to `npm run check:env && npm run db:migrate && next build`. `src/lib/env.ts` and `scripts/check-env.ts` say the point of `check:env` is that a misconfigured deploy fails before it is aliased and the last good deployment stays live. `scripts/migrate.ts` reconciles the schema, then runs a bounded `contact_identities` backfill (2,000 contacts per deploy) and confident duplicate merges (100 per account), both non-fatal. The `checkMigrationTarget` comment records the hazard: with `DATABASE_URL` scoped to all environments, every preview build would run those writes against production, and the only guard is `PRODUCTION_DB_HOST`, which warns rather than refuses when unset.

## Decision

The build owns the migration, so new code never serves against an unmigrated schema in the normal path. A failed DDL statement or a missing declared column fails the build. Previews run the same command and must be pointed at their own database.

## Consequences

- If `next build` fails after `db:migrate`, production keeps the old code on the new schema (health: `degraded`, `schema.ahead`). Schema changes must therefore be safe for the code in production: add first, remove the code, drop in a later deploy.
- Rollback is not schema-neutral: tables and columns have been dropped, and Vercel freezes env values per deployment, so a rolled-back deployment also restores rotated secrets (DEPLOYMENT.md, RUNBOOK).
- The build writes data (backfills, merges).
- Preview safety depends on dashboard settings that cannot be verified from the repository.

## Revisit when

If schema changes need a separate, gated step (for example a migration job that runs before promotion, or CI-owned migrations).
