import { and, eq, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { imports, usageEvents } from "@/db/schema";
import { runLinkedInImportJob } from "@/lib/import-job-processor";

export const maxDuration = 300;

const STALL_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * `usage_events` is write-only and nothing user-facing reads it, so without a sweep it
 * quietly becomes the largest table in the database. Six months is well past the window
 * any admin view looks at.
 */
const USAGE_EVENT_RETENTION_DAYS = 180;

/**
 * Vercel Cron target: resumes server-owned import jobs whose invocation died
 * mid-run. Runs once/day (Hobby plan's minimum cron interval) — the primary
 * resumption path is still the processor's own self-continuation via the
 * `[id]/continue` route; this is only a last-resort backstop.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const db = await getDb();
  const staleBefore = new Date(Date.now() - STALL_THRESHOLD_MS);
  const stalled = await db.query.imports.findMany({
    where: and(
      eq(imports.importType, "linkedin_connections"),
      eq(imports.status, "processing"),
      lt(imports.updatedAt, staleBefore)
    ),
  });

  for (const job of stalled) {
    await runLinkedInImportJob(job.id).catch(() => {});
  }

  // Housekeeping rides along on the only scheduled invocation Orbit has.
  let usageEventsPruned = false;
  try {
    const cutoff = new Date(
      Date.now() - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    await db.delete(usageEvents).where(lt(usageEvents.createdAt, cutoff));
    usageEventsPruned = true;
  } catch {
    // Never let housekeeping fail the job-resumption backstop this route exists for.
  }

  return NextResponse.json({ resumed: stalled.length, usageEventsPruned });
}
