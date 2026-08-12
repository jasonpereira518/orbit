import { and, eq, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { runLinkedInImportJob } from "@/lib/import-job-processor";

export const maxDuration = 300;

const STALL_THRESHOLD_MS = 3 * 60 * 1000;

/** Vercel Cron target: resumes server-owned import jobs whose invocation died mid-run. */
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

  return NextResponse.json({ resumed: stalled.length });
}
