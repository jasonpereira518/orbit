/**
 * The job-feed sweep's entry point.
 *
 * ## Why this is its own route and its own schedule
 *
 * NOT `/api/ops/sweep`: that route is `maxDuration = 60` and it is the ALERTING path.
 * Putting a 10 MB download behind it would make the alert cadence hostage to GitHub's CDN —
 * the identical argument `.github/workflows/ops.yml` already makes for the connector sync.
 *
 * NOT `/api/imports/process-stalled`: its own header says housekeeping must never endanger
 * the job resumption it exists for, and sharing it would make its `cron_runs` `partial`
 * ambiguous between "GitHub 5xx'd" and "imports are stuck".
 *
 * So: its own path, its own `cron_runs` job name, its own cron line, and a 300s ceiling that
 * `runJobFeedSweep` budgets against.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { runJobFeedSweep, sweepRunStatus } from "@/lib/jobs/feed-sweep";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write. An unauthenticated probe must not be able to insert ledger rows, and
  // must certainly not be able to make us pull 10 MB from GitHub on demand.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("jobs.feed-sweep");
  try {
    const stats = await runJobFeedSweep();
    await finishCronRun(handle, {
      status: sweepRunStatus(stats),
      stats: {
        feeds: stats.feeds,
        fetched: stats.fetched,
        notModified: stats.notModified,
        failed: stats.failed,
        upserted: stats.upserted,
        truncated: stats.truncated,
        watchedCompanies: stats.match.watchedCompanies,
        candidatePostings: stats.match.candidatePostings,
        matchesCreated: stats.match.matchesCreated,
        suggestionsCreated: stats.match.suggestionsCreated,
        suppressed: stats.match.suppressed,
        usersNotified: stats.match.usersNotified,
      },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "job feed sweep failed" }, { status: 500 });
  }
}
