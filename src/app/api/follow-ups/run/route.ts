/**
 * The follow-up engine's scheduled entry point.
 *
 * Driven by `.github/workflows/ops.yml` rather than Vercel Cron: Hobby allows one cron
 * and it belongs to `/api/imports/process-stalled`. Structurally identical to
 * `/api/sync/run`, including posting back to itself when the budget runs out.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { runFollowUpScheduler } from "@/lib/follow-ups/scheduler";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write. An unauthenticated probe must not be able to insert ledger rows.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("followups.run");
  try {
    const stats = await runFollowUpScheduler();

    if (stats.budgetExhausted) {
      // Best-effort continuation. If it is lost, the next scheduled run picks the
      // remaining users up anyway — their `next_pass_at` is still in the past.
      after(async () => {
        await internalFetch("/api/follow-ups/run", { method: "POST" }).catch(() => null);
      });
    }

    await finishCronRun(handle, {
      // `partial` rather than `ok` when anything failed, so the ops sweep can tell
      // "nothing to do" from "some users are not getting follow-ups".
      status: stats.failed > 0 ? "partial" : "ok",
      stats,
    });

    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "follow-up run failed" }, { status: 500 });
  }
}
