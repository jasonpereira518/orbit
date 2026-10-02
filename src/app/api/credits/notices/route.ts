/**
 * The credit emails at 80% and 100% of the monthly AI credits (`src/lib/credits/notices.ts`).
 *
 * Driven by GitHub Actions (.github/workflows/ops.yml) on the ten-minute schedule, so a
 * notice goes out within about ten minutes of an account crossing a level. Each send is
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
import { creditEmailConfigured, sendCreditNotices } from "@/lib/credits/notices";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write: an unauthenticated probe must not insert ledger rows or send mail.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("credits.notices");
  try {
    if (!creditEmailConfigured()) {
      await finishCronRun(handle, { status: "ok", stats: { notConfigured: true } });
      return NextResponse.json({ ok: true, notConfigured: true });
    }
    const stats = await sendCreditNotices();
    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats: { ...stats } });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.credits.notices" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "credit notices failed", ref }, { status: 500 });
  }
}
