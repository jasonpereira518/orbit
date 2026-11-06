/**
 * Cloud notes: every 30 minutes, check each watched Drive/OneDrive for new meeting notes.
 *
 * Driven by GitHub Actions (.github/workflows/ops.yml), the only scheduler. Self-continues
 * when a claim came back full or the budget ran out, the same shape as `/api/radar/run`. An
 * operator hiding the surface stands the pass down. While it is coming-soon only people who
 * could reach the tab hold a watched drive at all (the grant is asked for from inside it).
 */
import { NextResponse, after } from "next/server";
import { runCloudNotesPass } from "@/lib/cloud-notes/scan";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { reportAndContinue, reportError } from "@/lib/report-error";
import { CLOUD_NOTES_SURFACE_KEY } from "@/lib/surfaces";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("cloud-notes.run");
  try {
    if ((await getHiddenSurfaceKeys()).has(CLOUD_NOTES_SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }

    const stats = await runCloudNotesPass();
    if (stats.budgetExhausted || stats.claimFull) {
      after(async () => {
        await internalFetch("/api/cloud-notes/run", { method: "POST" }).catch(
          reportAndContinue({ where: "job.cloud-notes.continue" }, null),
        );
      });
    }

    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats: { ...stats } });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.cloud-notes" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "cloud notes run failed", ref }, { status: 500 });
  }
}
