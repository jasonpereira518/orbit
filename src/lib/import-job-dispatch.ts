import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { GOOGLE_CONTACTS_IMPORT_TYPE } from "@/lib/import-adapters/google-contacts";
import { OUTLOOK_CONTACTS_IMPORT_TYPE } from "@/lib/import-adapters/outlook-contacts";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";
import {
  CALENDAR_CSV_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
} from "@/lib/import-adapters/calendar";
import { runImportJob } from "@/lib/import-engine";
import {
  GMAIL_SCAN_IMPORT_TYPE,
  runGmailRecruiterScanJob,
} from "@/lib/gmail-scan-processor";

/**
 * Re-exported from their adapters, which is where these constants now live: the adapter
 * registry has to key on them, and importing them from here would close a cycle
 * (dispatch -> engine -> registry -> dispatch). Every existing call site keeps working.
 */
export {
  LINKEDIN_IMPORT_TYPE,
  GOOGLE_CONTACTS_IMPORT_TYPE,
  OUTLOOK_CONTACTS_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
  CALENDAR_CSV_IMPORT_TYPE,
};

/**
 * Import types that own their own server-side processing and can therefore be resumed.
 *
 * The stalled-job cron filters on this list. Anything missing here still runs, but a
 * job whose invocation dies mid-flight would sit in `processing` forever.
 *
 * As of Task 15, this is every import type Orbit has — calendar (both formats) was the last
 * client-driven kind. Nothing is left client-driven; a hypothetical future one would just be
 * absent from this list, same as `GMAIL_SCAN_IMPORT_TYPE`'s own separate processor is present
 * despite not routing through the generic engine below.
 */
export const RESUMABLE_IMPORT_TYPES = [
  LINKEDIN_IMPORT_TYPE,
  GOOGLE_CONTACTS_IMPORT_TYPE,
  OUTLOOK_CONTACTS_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
  CALENDAR_CSV_IMPORT_TYPE,
  GMAIL_SCAN_IMPORT_TYPE,
] as const;

/** Whether `type` owns its own server-side processing and can therefore be re-armed and
 *  resumed — see `RESUMABLE_IMPORT_TYPES` above. */
export function isResumableImportType(type: string): boolean {
  return (RESUMABLE_IMPORT_TYPES as readonly string[]).includes(type);
}

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
    case GOOGLE_CONTACTS_IMPORT_TYPE:
    case OUTLOOK_CONTACTS_IMPORT_TYPE:
    case LINKEDIN_MESSAGES_IMPORT_TYPE:
    case CALENDAR_ICS_IMPORT_TYPE:
    case CALENDAR_CSV_IMPORT_TYPE:
      return runImportJob(importId);
    default:
      // Import types with no server-side runner land here — none remain today.
      return;
  }
}

/**
 * Re-arm a failed or stuck import for another run: clears the error and flips the row back
 * to `processing` so `runImportJobById` (via the engine's own resumable loop) picks up where
 * it stopped rather than starting over.
 *
 * Deliberately does not run the job itself — same reasoning as the rest of this module's
 * callers: a resumed job can run far longer than the caller's own request/action, so
 * scheduling it is left to the caller via `after()`.
 */
export async function rearmImportJob(importId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(imports)
    .set({ status: "processing", errorMessage: null, updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
