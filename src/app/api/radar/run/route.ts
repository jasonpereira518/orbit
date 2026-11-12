/**
 * Radar's nightly pass: rebuild every due account's list of people to reach out to.
 *
 * Started by the tick (src/lib/schedules.ts) hourly at :30; each account is due at its own
 * local 5am, and same-day alerts go out after the pass in each person's waking hours.
 * Self-continuation posts back to this same route when a claim came back full or the budget
 * ran out, the same shape as `/api/sync/run`.
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
import { RADAR_MOMENTS_BUDGET_MS, sendRadarMoments } from "@/lib/radar/moments";
import { reportAndContinue, reportError } from "@/lib/report-error";
import { getComingSoonKeys, getHiddenSurfaceKeys } from "@/lib/surface-visibility";

export const maxDuration = 300;
/** What the pass and the alerts after it may use together, under `maxDuration`. */
const ROUTE_BUDGET_MS = 285_000;

const SURFACE_KEY = "page.radar";

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or spend AI.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
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
    // Same-day alerts (push, and at most one email a day) for Today items that won't keep. Only
    // when the pass finished inside its budget: the continuation below runs them otherwise, so
    // the two together never overrun the route's ceiling. A failure costs the alerts, not the run.
    const momentBudgetMs = Math.min(RADAR_MOMENTS_BUDGET_MS, ROUTE_BUDGET_MS - (Date.now() - startedAt));
    const moments =
      stats.budgetExhausted || stats.claimFull || momentBudgetMs < 5_000
        ? null
        : await sendRadarMoments(new Date(), { budgetMs: momentBudgetMs }).catch((err) => {
            reportError(err, { where: "job.radar.moments" });
            return null;
          });

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
      stats: { ...stats, ...(moments ? { momentPeople: moments.people, momentAlerts: moments.alerted, momentPushes: moments.pushed, momentEmails: moments.emailed, momentFailed: moments.failed } : {}) },
    });
    return NextResponse.json({ ok: true, ...stats, moments });
  } catch (err) {
    const ref = reportError(err, { where: "job.radar" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "radar run failed", ref }, { status: 500 });
  }
}
