/**
 * The email-insights sweep's entry point: reads new career-relevant Gmail threads for each
 * opted-in account. Every fifteen minutes from `.github/workflows/ops.yml` at :05/:20/:35/:50.
 *
 * Its own route, schedule and `cron_runs` job name, like the work-history sweep: it makes
 * network calls per account, and the ten-minute ops sweep is the alerting path and must
 * never wait on it. `POST` because it mutates.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { runEmailIntelSweep } from "@/lib/email-intel/sweep";
import { isInternalRequest } from "@/lib/internal-auth";

export const maxDuration = 300;

/** Stop starting accounts this far in, leaving room to settle leases under 300s. */
const START_DEADLINE_MS = 240_000;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const handle = await startCronRun("email-intel.sweep");
  try {
    const stats = await runEmailIntelSweep({ deadline: started + START_DEADLINE_MS });
    await finishCronRun(handle, {
      // Out of time or out of daily budget is the ordinary partial shape, not a failure.
      status: stats.partial > 0 || stats.exhausted > 0 || stats.errors > 0 ? "partial" : "ok",
      stats: { ...stats },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "email intel sweep failed" }, { status: 500 });
  }
}
