/**
 * Radar's Monday email (`src/lib/radar/digest.ts`).
 *
 * Driven by GitHub Actions (.github/workflows/ops.yml) at :13 every hour of Sunday and Monday
 * UTC, which covers every zone's Monday 06:00–09:00. Each run sends to the people whose
 * Monday morning it is now; the week claim makes a second run in the same window a no-op for
 * everyone already sent. A run that runs out of time posts back to itself once more; anyone
 * left after that is picked up by the next hour's run, still inside their window.
 *
 * Stands down while `page.radar` is hidden or still coming soon, so an unreleased Radar sends
 * nobody anything, and while Resend is not configured, before claiming anyone, so no week is
 * spent on an email that could not go out.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { radarDigestConfigured, sendRadarDigests } from "@/lib/radar/digest";
import { reportAndContinue, reportError } from "@/lib/report-error";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { COMING_SOON_KEYS } from "@/lib/surfaces";

export const maxDuration = 300;

const SURFACE_KEY = "page.radar";

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or send mail.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("radar.digest");
  try {
    const hidden = await getHiddenSurfaceKeys();
    if (hidden.has(SURFACE_KEY) || COMING_SOON_KEYS.has(SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }
    if (!radarDigestConfigured()) {
      await finishCronRun(handle, { status: "ok", stats: { notConfigured: true } });
      return NextResponse.json({ ok: true, notConfigured: true });
    }

    const stats = await sendRadarDigests();

    // More people are waiting in this window. Best-effort: the next hour's run is the backstop.
    if (stats.budgetExhausted) {
      after(async () => {
        await internalFetch("/api/radar/digest", { method: "POST" }).catch(
          reportAndContinue({ where: "job.radar.digest.continue" }, null)
        );
      });
    }

    await finishCronRun(handle, {
      status: stats.failed > 0 ? "partial" : "ok",
      stats: { ...stats },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.radar.digest" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "radar digest failed", ref }, { status: 500 });
  }
}
