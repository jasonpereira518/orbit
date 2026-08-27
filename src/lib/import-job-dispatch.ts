import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { runImportJob } from "@/lib/import-engine";
import {
  GMAIL_SCAN_IMPORT_TYPE,
  runGmailRecruiterScanJob,
} from "@/lib/gmail-scan-processor";

/**
 * Re-exported from the LinkedIn adapter, which is where the constant now lives: the adapter
 * registry has to key on it, and importing it from here would close a cycle
 * (dispatch -> engine -> registry -> dispatch). Every existing call site keeps working.
 */
export { LINKEDIN_IMPORT_TYPE };

/**
 * Import types that own their own server-side processing and can therefore be resumed.
 *
 * The stalled-job cron filters on this list. Anything missing here still runs, but a
 * job whose invocation dies mid-flight would sit in `processing` forever.
 */
export const RESUMABLE_IMPORT_TYPES = [
  LINKEDIN_IMPORT_TYPE,
  GMAIL_SCAN_IMPORT_TYPE,
] as const;

/**
 * Single entry point for resuming any server-owned import job.
 *
 * The continuation route and the cron backstop both used to call the LinkedIn runner
 * directly; with more than one job kind sharing the `imports` table that would silently
 * run the wrong processor, so the type lives in the row and the dispatch lives here.
 */
export async function runImportJobById(importId: string): Promise<void> {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
    columns: { importType: true },
  });
  if (!row) return;

  switch (row.importType) {
    case GMAIL_SCAN_IMPORT_TYPE:
      return runGmailRecruiterScanJob(importId);
    case LINKEDIN_IMPORT_TYPE:
      return runImportJob(importId);
    default:
      // Client-driven kinds (e.g. the LinkedIn messages import) have no server runner.
      return;
  }
}
