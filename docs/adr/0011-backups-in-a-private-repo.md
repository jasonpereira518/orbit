# 11. Backups run from a private repository

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

Commit `77d28a7` ("ops: keep backups and job output out of the public repo") moved `backup.yml` out. Its message: on a public repository any signed-in GitHub user can download workflow artifacts, which left the encrypted dumps protected by the age key alone. The same commit made `ops.yml` steps print only their HTTP status, keeping job bodies in `cron_runs` and Sentry.

## Decision

A daily `age`-encrypted `pg_dump` is produced by a workflow in a private ops repository (90-day artifacts); Better Stack alerts after 36 hours without a heartbeat. RUNBOOK documents the restore. The workflow is not in this repository, so its schedule and secrets cannot be checked here *(verify)*.

## Consequences

- The restore drill has never been run (RUNBOOK, Restore drill log).
- `PG_MAJOR` in the backup workflow must be raised the day Neon upgrades Postgres, or the backup fails.
- Some in-repo references to `backup.yml` are stale.

## Revisit when

If the repository becomes private, or when the first restore drill reveals a gap.
