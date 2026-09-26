import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { imports } from "@/db/schema";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { GOOGLE_CONTACTS_IMPORT_TYPE } from "@/lib/import-adapters/google-contacts";
import { OUTLOOK_CONTACTS_IMPORT_TYPE } from "@/lib/import-adapters/outlook-contacts";
import { CONTACTS_FILE_IMPORT_TYPE } from "@/lib/import-adapters/contacts-file";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";
import {
  CALENDAR_CSV_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
} from "@/lib/import-adapters/calendar";
import { runImportJob } from "@/lib/import-engine";
import { GMAIL_SCAN_IMPORT_TYPE } from "@/lib/gmail-scan-type";
// Value-only, used inside a function: this module and the processor are in an import cycle,
// so the constant above must come from a module that is never mid-initialisation.
import { runGmailRecruiterScanJob } from "@/lib/gmail-scan-processor";
import { OUTLOOK_SCAN_IMPORT_TYPE } from "@/lib/outlook-scan-type";
import { runOutlookRecruiterScanJob } from "@/lib/outlook-scan-processor";
import { DRIVE_IMPORT_TYPE } from "@/lib/drive-import-type";
import { runDriveImportJob } from "@/lib/drive-import-processor";

/**
 * Re-exported from their adapters, which is where these constants now live: the adapter
 * registry has to key on them, and importing them from here would close a cycle
 * (dispatch -> engine -> registry -> dispatch). Every existing call site keeps working.
 */
export {
  LINKEDIN_IMPORT_TYPE,
  GOOGLE_CONTACTS_IMPORT_TYPE,
  OUTLOOK_CONTACTS_IMPORT_TYPE,
  CONTACTS_FILE_IMPORT_TYPE,
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
  CONTACTS_FILE_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  CALENDAR_ICS_IMPORT_TYPE,
  CALENDAR_CSV_IMPORT_TYPE,
  GMAIL_SCAN_IMPORT_TYPE,
  OUTLOOK_SCAN_IMPORT_TYPE,
  DRIVE_IMPORT_TYPE,
] as const;

/**
 * Single entry point for resuming any server-owned import job.
 *
 * The continuation route and the cron backstop both used to call the LinkedIn runner
 * directly; with more than one job kind sharing the `imports` table that would silently
 * run the wrong processor, so the type lives in the row and the dispatch lives here.
 */
/**
 * How long one runner holds an import. Longer than any invocation can live (maxDuration
 * 300s), so a live runner never loses it mid-chunk, and short enough that a runner that died
 * frees the job well before the hourly stall backstop comes looking.
 */
export const IMPORT_LEASE_MS = 330_000;

/**
 * How long a new runner waits for the lease. A self-continuation is kicked by the runner
 * before that runner returns and releases, so the successor usually waits a few hundred
 * milliseconds. Anything still holding it after this is a live runner, and this one leaves.
 */
const LEASE_WAIT_MS = 15_000;
const LEASE_POLL_MS = 500;

/** Take the job if nobody holds it (or their lease ran out). Times are the database's own. */
async function tryAcquireImportLease(importId: string, token: string): Promise<boolean> {
  const db = await getDb();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE imports
         SET runner_token = ${token},
             runner_lease_until = now() + make_interval(secs => ${IMPORT_LEASE_MS / 1000})
       WHERE id = ${importId}::uuid
         AND (runner_lease_until IS NULL OR runner_lease_until < now())
      RETURNING id
    `)
  );
  return rows.length > 0;
}

export async function acquireImportLease(importId: string, token: string, waitMs = LEASE_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await tryAcquireImportLease(importId, token)) return true;
    if (Date.now() + LEASE_POLL_MS > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
}

export async function releaseImportLease(importId: string, token: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE imports SET runner_token = NULL, runner_lease_until = NULL
     WHERE id = ${importId}::uuid AND runner_token = ${token}
  `);
}

/**
 * Run an import's processor, as its only runner. Every path in goes through here — the
 * upload's `after()`, `/api/imports/[id]/continue`, the stall backstop's kick, the admin
 * retry — so the lease covers all of them. A second runner that cannot get the lease within
 * `waitMs` returns without touching the job.
 */
export async function runImportJobById(importId: string, options: { waitMs?: number } = {}): Promise<void> {
  const token = randomUUID();
  if (!(await acquireImportLease(importId, token, options.waitMs))) return;
  try {
    await dispatchImportJob(importId);
  } finally {
    await releaseImportLease(importId, token).catch(() => undefined);
  }
}

async function dispatchImportJob(importId: string): Promise<void> {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
    columns: { importType: true },
  });
  if (!row) return;

  switch (row.importType) {
    case GMAIL_SCAN_IMPORT_TYPE:
      return runGmailRecruiterScanJob(importId);
    case OUTLOOK_SCAN_IMPORT_TYPE:
      return runOutlookRecruiterScanJob(importId);
    case DRIVE_IMPORT_TYPE:
      return runDriveImportJob(importId);
    case LINKEDIN_IMPORT_TYPE:
    case GOOGLE_CONTACTS_IMPORT_TYPE:
    case OUTLOOK_CONTACTS_IMPORT_TYPE:
    case CONTACTS_FILE_IMPORT_TYPE:
    case LINKEDIN_MESSAGES_IMPORT_TYPE:
    case CALENDAR_ICS_IMPORT_TYPE:
    case CALENDAR_CSV_IMPORT_TYPE:
      return runImportJob(importId);
    default:
      // Import types with no server-side runner land here — none remain today.
      return;
  }
}
