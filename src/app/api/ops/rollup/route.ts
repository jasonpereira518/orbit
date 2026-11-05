import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { recentDays, rollupDays } from "@/lib/metrics-rollup";
import { reportError } from "@/lib/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Daily: recompute `metrics_daily` for today and the two UTC days before it, so writes that
 * land late (a beacon, a webhook, a backfilled import) settle into the day they belong to.
 * Idempotent — a manual re-run rewrites the same rows. See `src/lib/metrics-rollup.ts`.
 *
 * Same shared-secret gate and scheduler as `/api/ops/billing-reconcile`; the run row carries
 * `{days, rows}`.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) return new NextResponse(null, { status: 401 });

  const run = await startCronRun("metrics.rollup");
  try {
    const days = recentDays();
    const rows = await rollupDays(days);
    await finishCronRun(run, { status: "ok", stats: { days: days.length, rows } });
    return NextResponse.json({ days: days.length, rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const ref = reportError(err, { where: "job.metrics-rollup" });
    await finishCronRun(run, { status: "failed", error: err });
    return NextResponse.json({ error: "rollup failed", ref }, { status: 503 });
  }
}
