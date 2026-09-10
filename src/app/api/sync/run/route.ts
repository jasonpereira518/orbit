/**
 * The continuous-sync scheduler's entry point.
 *
 * Driven by GitHub Actions rather than Vercel Cron: Hobby allows one cron and it belongs to
 * `/api/imports/process-stalled`, so `.github/workflows/ops.yml` is already the real
 * scheduler for everything else. Self-continuation posts back to this same route rather than
 * a second path, which keeps `PUBLIC_ROUTES` small.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { runSyncPass } from "@/lib/sync-scheduler";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write. An unauthenticated probe must not be able to insert ledger rows —
  // the same rule `process-stalled` states for its own handler.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("sync.run");
  try {
    const stats = await runSyncPass();

    // More work is waiting and this invocation is out of budget. Best-effort kick, exactly
    // like the import engine's continuation: if it is lost, the next scheduled run picks the
    // connections up anyway, because they were left immediately due.
    if (stats.budgetExhausted) {
      after(async () => {
        await internalFetch("/api/sync/run", { method: "POST" }).catch(() => null);
      });
    }

    await finishCronRun(handle, {
      // `partial` rather than `ok` when anything failed, so the ops sweep can tell the
      // difference between "nothing to do" and "some users are not syncing".
      status: stats.failed > 0 ? "partial" : "ok",
      stats: {
        claimed: stats.claimed,
        synced: stats.synced,
        failed: stats.failed,
        skippedNoScope: stats.skippedNoScope,
        eventsIngested: stats.eventsIngested,
        contactsCreated: stats.contactsCreated,
        interactionsLogged: stats.interactionsLogged,
        budgetExhausted: stats.budgetExhausted,
      },
    });

    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "sync run failed" }, { status: 500 });
  }
}
