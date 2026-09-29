import { lt, count, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, rowsOf } from "@/db";
import { adminMetricSnapshots } from "@/db/schema";
import {
  finishCronRun,
  startCronRun,
  type CronRunStatus,
} from "@/lib/cron-runs";

export const maxDuration = 60;

/**
 * How long a snapshot's history is worth keeping. Matches the 90-day trend window every
 * chart that reads `snapshotTrend()` requests — nothing on the console ever asks for more.
 */
const SNAPSHOT_RETENTION_DAYS = 90;

/**
 * Vercel Cron target: takes one daily reading of the console metrics that have no other
 * historical record — see `src/lib/admin-trends.ts` for why most metrics don't need this
 * and read straight from event ledgers instead. Runs an hour offset from
 * `imports/process-stalled` (`0 1 * * *` vs `0 0 * * *`) so the two daily jobs don't
 * compete for the same connection.
 *
 * Standalone rather than folded into `process-stalled`: a failure here (a bad metric
 * query) must not block that job's import-resumption backstop, and vice versa.
 */
export async function GET(request: Request) {
  // Auth first, before any write — same reasoning as process-stalled/route.ts.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const run = await startCronRun("admin.metrics-snapshot");

  let status: CronRunStatus = "ok";
  let error: unknown = null;
  const stats = { metricsRecorded: 0, snapshotsPruned: 0 };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const db = await getDb();

    const { getSystemIssueCount } = await import("@/lib/admin-system");

    // Independent reads — a failure in one must not take the other's metric down with it.
    // `active7d` is the same one-statement shape `overviewValues()` in admin-live.ts
    // uses, not the full `getAdminOverview()` roster scan — this cron needs one integer,
    // not six queries' worth of roster detail.
    const [systemIssues, active7d] = await Promise.all([
      getSystemIssueCount().catch(() => null),
      db
        .execute(
          sql`SELECT count(*)::int AS n FROM user_settings
              WHERE last_active_at > now() - interval '7 days'`
        )
        .then((r) => rowsOf<{ n: number }>(r)[0]?.n ?? null)
        .catch(() => null),
    ]);

    const values: Array<{ metric: string; value: number }> = [];
    if (systemIssues !== null) {
      values.push({ metric: "health.system_issues", value: systemIssues });
    }
    if (active7d !== null) {
      values.push({ metric: "users.active_7d", value: active7d });
    }

    if (values.length > 0) {
      await db
        .insert(adminMetricSnapshots)
        .values(values.map((v) => ({ ...v, capturedAt: today })))
        // A retried invocation (the same cron firing twice) must not double the day's
        // reading — the unique index on (metric, captured_at) makes the retry a no-op.
        .onConflictDoNothing();
      stats.metricsRecorded = values.length;
    }
    if (values.length < 2) status = "partial";

    const cutoff = new Date(
      Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);
    const [before] = await db
      .select({ value: count() })
      .from(adminMetricSnapshots)
      .where(lt(adminMetricSnapshots.capturedAt, cutoff));
    await db
      .delete(adminMetricSnapshots)
      .where(lt(adminMetricSnapshots.capturedAt, cutoff));
    stats.snapshotsPruned = before?.value ?? 0;
  } catch (err) {
    status = "failed";
    error = err;
  } finally {
    await finishCronRun(run, { status, stats, error });
  }

  return NextResponse.json(
    { runId: run.id, status, ...stats },
    { status: status === "failed" ? 500 : 200 }
  );
}
