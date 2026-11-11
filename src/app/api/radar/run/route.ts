/**
 * Radar's nightly pass: rebuild every due account's list of people to reach out to.
 *
 * Driven by GitHub Actions (.github/workflows/ops.yml) hourly at :17; each account is due at
 * its own local 5am. Self-continuation posts back to this same route when a claim came back
 * full or the budget ran out, the same shape as `/api/sync/run`.
 *
 * While `page.radar` is hidden or coming soon the whole pass stands down, so nobody's AI key
 * is spent on a page they cannot see.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { runRadarPass } from "@/lib/radar/run";
import { reportAndContinue, reportError } from "@/lib/report-error";
import { getComingSoonKeys, getHiddenSurfaceKeys } from "@/lib/surface-visibility";

export const maxDuration = 300;

const SURFACE_KEY = "page.radar";

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or spend AI.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("radar.run");
  try {
    const [hidden, soon] = await Promise.all([getHiddenSurfaceKeys(), getComingSoonKeys()]);
    if (hidden.has(SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }

    // Coming soon: no scheduled pass at all, the digest route's rule. Nobody's AI key or Orbit's
    // credits are spent on a page users cannot see; "Refresh now" still builds for previewers.
    if (soon.has(SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true, comingSoon: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }

    const stats = await runRadarPass({ includeUnopened: true });

    // More accounts are waiting. Best-effort: a lost kick is picked up by tomorrow's pass,
    // and the page rebuilds any list older than a day on its own.
    if (stats.budgetExhausted || stats.claimFull) {
      after(async () => {
        await internalFetch("/api/radar/run", { method: "POST" }).catch(
          reportAndContinue({ where: "job.radar.continue" }, null)
        );
      });
    }

    await finishCronRun(handle, {
      status: stats.failed > 0 ? "partial" : "ok",
      stats: { ...stats },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.radar" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "radar run failed", ref }, { status: 500 });
  }
}
