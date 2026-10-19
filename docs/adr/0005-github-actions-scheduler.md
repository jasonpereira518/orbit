# 5. GitHub Actions as the scheduler, with after() self-continuation, leases and time budgets

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`.github/workflows/ops.yml` states that Vercel Hobby runs crons at most once a day, so it is the only scheduler and `vercel.json` schedules nothing; the comment says to move the jobs to Vercel when Pro lands. GitHub schedules lag 5 to 30 minutes and are disabled on a public repository after 60 days without a commit; the Better Stack heartbeat that the ops sweep pings detects both. Each schedule has its own concurrency group because a shared group once dropped the alerting sweep behind a slow sync. Internal routes are authenticated by `Authorization: Bearer $CRON_SECRET` and fail closed (`src/lib/internal-auth.ts`).

## Decision

Cron-like work is one workflow with ten schedules calling internal routes. Long work is stored as DB job rows (imports, capture jobs, relationship and radar runs, outboxes). A worker claims rows with a lease, stops at a wall-clock budget (`src/lib/time-budget.ts`), records a `cron_runs` row and, when work remains, POSTs back to itself inside `after()` via `internalFetch`. The hourly `process-stalled` job is the backstop for a lost continuation.

## Consequences

- Cadence is a floor, not a promise; nothing may assume a fixed interval.
- The repository must be kept active or the schedules stop (RUNBOOK: Scheduled workflows were disabled).
- `CRON_SECRET` and `APP_URL` must match between Vercel and GitHub; a mismatch is a 401.
- On a preview, continuations go to `getAppBaseUrl()`, which can be the production domain.
- Public Actions logs print only HTTP status, so details live in `cron_runs` and Sentry.

## Revisit when

When Vercel Pro crons are available (the workflow header says to move everything in one change).
