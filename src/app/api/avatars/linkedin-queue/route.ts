/**
 * One tick of the LinkedIn photo queue (`src/lib/linkedin-photo-queue.ts`). Kicked by the
 * admin Start button, by the previous tick, and by the hourly process-stalled backstop.
 * Answers at once; the tick runs in `after()` and kicks the next one itself.
 */
import { NextResponse, after } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { runLinkedInPhotoQueueTick } from "@/lib/linkedin-photo-queue";
import { reportError } from "@/lib/report-error";

export const dynamic = "force-dynamic";
// Reuses an existing value: a new one would be a new function (Hobby caps a deploy at 12).
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { runId?: unknown } | null;
  const runId = typeof body?.runId === "string" ? body.runId : null;
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  after(async () => {
    try {
      await runLinkedInPhotoQueueTick(runId);
    } catch (err) {
      reportError(err, { where: "job.linkedin-photo-queue", level: "warning" });
    }
  });
  return NextResponse.json({ ok: true });
}
