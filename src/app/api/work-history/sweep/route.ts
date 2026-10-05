/**
 * The work-history sweep's entry point: re-checks contacts whose LinkedIn work history is
 * due, logs any job moves it finds. Hourly from `.github/workflows/ops.yml` at :37.
 *
 * Its own route, schedule and `cron_runs` job name for the same reasons the job-feed sweep
 * has them (see src/app/api/jobs/feed/sweep/route.ts): the ten-minute ops sweep is the
 * alerting path and must not wait on web searches, and a slow run here should delay only
 * itself.
 *
 * `POST` because it mutates.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { isInternalRequest } from "@/lib/internal-auth";
import { runWorkHistorySweep } from "@/lib/work-history-sweep";

export const maxDuration = 300;

/**
 * Stop starting new checks this far in. A searched answer can take up to two minutes
 * (`WEB_SEARCH_TIMEOUT_MS`), and the briefs below need room after it, under 300s.
 */
const START_DEADLINE_MS = 150_000;
/** Stop regenerating briefs here; anything left regenerates on its next page view. */
const BRIEF_DEADLINE_MS = 270_000;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const handle = await startCronRun("work-history.sweep");
  try {
    const stats = await runWorkHistorySweep({ deadline: started + START_DEADLINE_MS });

    // A saved history changes the search text (career line) and the brief's prompt.
    for (const [userId, ids] of Object.entries(stats.savedByUser)) {
      await kickEmbeddingBackfill(userId);
      for (const id of ids) {
        if (Date.now() >= started + BRIEF_DEADLINE_MS) break;
        await generateAndStoreContactBrief(userId, id).catch(() => null);
      }
    }

    await finishCronRun(handle, {
      // A run that had to hand claims back ran out of time, not out of work: partial.
      status: stats.released > 0 ? "partial" : "ok",
      stats: {
        users: stats.users,
        claimed: stats.claimed,
        researched: stats.researched,
        saved: stats.saved,
        released: stats.released,
        budgetSpent: stats.budgetSpent,
        noAiUsers: stats.noAiUsers,
        ...stats.outcomes,
      },
    });
    const { savedByUser: _savedByUser, ...summary } = stats;
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "work history sweep failed" }, { status: 500 });
  }
}
