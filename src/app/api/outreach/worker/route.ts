/**
 * Drains `outreach_jobs` (spec §4.4). Called by `kickOutreachWorker`, by `.github/workflows/ops.yml`
 * every 15 minutes, and by itself when work remains. Internal: CRON_SECRET via
 * `isInternalRequest`, fail-closed on Vercel. POST because it mutates.
 */
import { NextResponse, after } from "next/server";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";
import { defaultJobHandlers } from "@/lib/outreach/jobs/handlers";
import { runWorkerPass } from "@/lib/outreach/jobs/worker";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const stats = await runWorkerPass({ handlers: defaultJobHandlers() });
  if (stats.moreDue) {
    after(async () => {
      await internalFetch("/api/outreach/worker", { method: "POST" }).catch(() => null);
    });
  }
  return NextResponse.json({ ok: true, ...stats });
}
