/**
 * The one scheduled call Orbit needs: every five minutes, start whichever jobs are due
 * (`src/lib/schedules.ts`). One outside schedule instead of twenty keeps the scheduler on a
 * free tier (288 calls a day).
 *
 * Answers at once and starts the jobs after the response (`after()`), so a scheduler with a
 * short request timeout (cron-job.org's is about 30 seconds) is fine. Each job is its own
 * request with its own `maxDuration`; a job keeps running when this route stops waiting on
 * it, the same way the routes' own self-continuation kicks already rely on.
 *
 * Shared-secret auth (`isInternalRequest`), fail-closed. `POST` because it starts work.
 */
import { NextResponse, after } from "next/server";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { dueJobs, tickWindow } from "@/lib/schedules";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const due = dueJobs(now);
  after(async () => {
    await Promise.allSettled(
      due.map((job) =>
        internalFetch(job.path, { method: job.method }).catch((err: unknown) => {
          // A timeout means the job is running and only the wait was cut short; anything else
          // is a failed start, which the job's own staleness alert will also catch.
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return;
          reportError(err, { where: "job.cron.tick", level: "warning", extra: { job: job.id } });
        })
      )
    );
  });
  return NextResponse.json({ ok: true, window: tickWindow(now), started: due.map((j) => j.id) });
}
