/**
 * The credit emails at 80% and 100% of the monthly AI credits (`src/lib/credits/notices.ts`).
 *
 * Started every other hour by the tick (src/lib/schedules.ts), so a notice goes out
 * within a couple of hours of an account crossing a level. Each send is
 * claimed first, so a run that overlaps the last one sends nothing twice.
 *
 * Stands down while Resend is not configured, before claiming anyone, so no notice is spent
 * on an email that could not go out.
 *
 * `POST` because it mutates. Route Handlers are uncached by default and `POST` can never be
 * cached, so no cache configuration is needed here.
 */
import { NextResponse } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { creditEmailConfigured, loadCreditNoticeCandidates, sendCreditNotices } from "@/lib/credits/notices";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or send mail.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Idle runs (no mail configured, or nobody past 80%) write no ledger rows.
  if (!creditEmailConfigured()) return NextResponse.json({ ok: true, notConfigured: true });
  // A failed read falls through: the run below reloads, and records the failure in the ledger.
  const candidates = await loadCreditNoticeCandidates(new Date()).catch(() => undefined);
  if (candidates?.length === 0) return NextResponse.json({ ok: true, idle: true });
  const handle = await startCronRun("credits.notices");
  try {
    const stats = await sendCreditNotices({ candidates });
    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats: { ...stats } });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.credits.notices" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "credit notices failed", ref }, { status: 500 });
  }
}
