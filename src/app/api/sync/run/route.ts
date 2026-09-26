/**
 * The continuous-sync scheduler's entry point.
 *
 * Driven by GitHub Actions (.github/workflows/ops.yml), the only scheduler. Self-continuation posts back to this same route rather than
 * a second path, which keeps `PUBLIC_ROUTES` small.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { runSyncPass } from "@/lib/sync-scheduler";
import { reportAndContinue, reportError } from "@/lib/report-error";

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

    // More work is waiting: this invocation ran out of budget, or a claim came back full.
    // Best-effort kick, exactly like the import engine's continuation: if it is lost, the
    // next scheduled run picks the connections up anyway, because they are still due. The
    // chain ends on its own: every claim leases what it takes, so claims shrink as the
    // backlog drains.
    if (stats.budgetExhausted || stats.claimFull) {
      after(async () => {
        await internalFetch("/api/sync/run", { method: "POST" }).catch(
          reportAndContinue({ where: "job.sync.continue" }, null)
        );
      });
    }

    await finishCronRun(handle, {
      // `partial` rather than `ok` when anything failed, so the ops sweep can tell the
      // difference between "nothing to do" and "some users are not syncing".
      status: stats.failed > 0 || stats.connectorFailed > 0 ? "partial" : "ok",
      stats: {
        claimed: stats.claimed,
        synced: stats.synced,
        failed: stats.failed,
        skippedNoScope: stats.skippedNoScope,
        eventsIngested: stats.eventsIngested,
        contactsCreated: stats.contactsCreated,
        addressBookSeen: stats.addressBookSeen,
        addressBookMatched: stats.addressBookMatched,
        interactionsLogged: stats.interactionsLogged,
        connectorClaimed: stats.connectorClaimed,
        connectorSynced: stats.connectorSynced,
        connectorFailed: stats.connectorFailed,
        budgetExhausted: stats.budgetExhausted,
        claimFull: stats.claimFull,
        oldestDueAgeMs: stats.oldestDueAgeMs ?? 0,
      },
    });

    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.sync" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "sync run failed", ref }, { status: 500 });
  }
}
