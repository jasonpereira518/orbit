import { NextResponse } from "next/server";
import { EMAIL_DRAIN_SURFACE_KEY } from "@/lib/surfaces";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import "@/lib/email/origin-registrations";
import { drainEmailSends } from "@/lib/email/outbox";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const handle = await startCronRun("email.drain");
  try {
    // Kill switch (/admin/product): stand down without touching anything.
    if ((await getHiddenSurfaceKeys()).has(EMAIL_DRAIN_SURFACE_KEY)) {
      await finishCronRun(handle, { status: "ok", stats: { standDown: true } });
      return NextResponse.json({ ok: true, standDown: true });
    }
    // 40s of a 60s budget, leaving room for the ledger write.
    const stats = await drainEmailSends({ budgetMs: 40_000, max: 100 });
    await finishCronRun(handle, { status: stats.failed > 0 ? "partial" : "ok", stats });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.email-drain" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "drain failed", ref }, { status: 500 });
  }
}
