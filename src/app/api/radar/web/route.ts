/**
 * Radar's weekly web pass: events near each person, people to meet, open programs
 * (`src/lib/radar/opportunities.ts`). Each account is due about once a week
 * (`user_settings.radar_web_next_at`); this route, driven hourly at :53 by
 * .github/workflows/ops.yml, takes the most overdue accounts until its time runs out. The
 * next hour picks up whoever is left.
 *
 * Every run first deletes finds nobody saved, 30 days after they ended (`purgeOldRadarFinds`),
 * even while Radar is dark. While `page.radar` is hidden or coming soon it then stands down, the same rule as the daily pass,
 * so no account spends web searches on a page it cannot see.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { dueRadarWebAccounts, purgeOldRadarFinds, runRadarWebForUser } from "@/lib/radar/opportunities";
import { reportError } from "@/lib/report-error";
import { getComingSoonKeys, getHiddenSurfaceKeys } from "@/lib/surface-visibility";

export const maxDuration = 300;

const SURFACE_KEY = "page.radar";
/** Accounts one run may take; each is at most three searches and a few page reads. */
const ACCOUNTS_PER_RUN = 25;
/** Stop starting accounts here, well inside the 300s ceiling. */
const BUDGET_MS = 200_000;

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or spend searches.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("radar.web");
  try {
    // Retention first, and whatever Radar's state: /privacy promises unsaved finds are gone 30
    // days after they end, and a find is still personal data while the page is dark.
    const purged = await purgeOldRadarFinds().catch((err) => {
      reportError(err, { where: "job.radar.web.purge" });
      return 0;
    });
    const [hidden, soon] = await Promise.all([getHiddenSurfaceKeys(), getComingSoonKeys()]);
    if (hidden.has(SURFACE_KEY) || soon.has(SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true, purged } });
      return NextResponse.json({ ok: true, standDown: true, purged });
    }

    const started = Date.now();
    const stats = { accounts: 0, searched: 0, written: 0, skipped: 0, failed: 0, purged, budgetExhausted: false };
    for (const userId of await dueRadarWebAccounts(new Date(), ACCOUNTS_PER_RUN)) {
      if (Date.now() - started > BUDGET_MS) {
        stats.budgetExhausted = true;
        break;
      }
      stats.accounts += 1;
      try {
        const r = await runRadarWebForUser(userId);
        stats.searched += r.searched;
        stats.written += r.written;
        if (r.skipped) stats.skipped += 1;
      } catch (err) {
        stats.failed += 1;
        reportError(err, { where: "job.radar.web", userId, level: "warning" });
      }
    }

    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.radar.web" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "radar web pass failed", ref }, { status: 500 });
  }
}
