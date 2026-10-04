/**
 * Radar's hourly news sweep: read the public feeds into the global news tables.
 *
 * Ingest only (`runNewsSweep`): no account is read here and nothing is matched. Which
 * headline matters to whom is decided per account by the nightly run, against these rows.
 * Its own route and its own cron line, for the job feed's reason: a slow publisher must
 * never make the alerting path's cadence hostage to it.
 *
 * Stands down when an operator has hidden `page.radar`, and while nobody has opened Radar
 * yet (during coming-soon that is everyone but the previewing admins), so the sweep costs
 * nothing until someone can see what it finds.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { runNewsSweep } from "@/lib/radar/feeds/sweep";
import { reportError } from "@/lib/report-error";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";

export const maxDuration = 300;

const SURFACE_KEY = "page.radar";

async function anyoneUsesRadar(): Promise<boolean> {
  const db = await getDb();
  const [row] = rowsOf<{ found: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM user_settings WHERE radar_last_run_at IS NOT NULL) AS found`)
  );
  return Boolean(row?.found);
}

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or make us fetch.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("radar.feeds");
  try {
    const hidden = await getHiddenSurfaceKeys();
    if (hidden.has(SURFACE_KEY) || !(await anyoneUsesRadar())) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }
    const stats = await runNewsSweep();
    await finishCronRun(handle, {
      status: stats.failed > 0 || stats.budgetExhausted ? "partial" : "ok",
      stats: { ...stats },
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.radar.feeds" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "radar news sweep failed", ref }, { status: 500 });
  }
}
