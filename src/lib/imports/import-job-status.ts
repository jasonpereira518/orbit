import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { isImportId } from "@/lib/imports/import-ids";

export type ImportJobStatus = {
  id: string;
  status: string;
  totalRows: number;
  rowsProcessed: number;
  contactsCreated: number;
  contactsUpdated: number;
  duplicatesFound: number;
  errorMessage: string | null;
  /**
   * The engine's own counters (`ImportStats.interactionsLogged`/`remindersCreated` —
   * see `src/db/schema.ts`) for how many interaction/reminder rows this job's bulk inserts
   * actually wrote. Surfaced here so the poll UI can report the number a calendar or
   * LinkedIn-messages import's user actually cares about — meetings/messages logged — rather
   * than only `contactsCreated`/`contactsUpdated`, which for a `createsContacts: false`
   * import like calendar never move the "created" half at all.
   */
  interactionsLogged: number;
  remindersCreated: number;
  /**
   * Rows the engine isolated and marked `failed` rather than failing the whole import
   * (`ImportStats.failedRows`). Surfaced so a user whose file contained unwritable rows is
   * actually told — chunk narrowing's entire purpose is to drop those rows instead of the
   * job, and a "completed" toast that never mentions them hides the loss.
   */
  failedRows: number;
  /** Drive imports: docs actually read (skipped and unchanged ones excluded). */
  docsRead: number;
  /** LinkedIn export: files kept, and what its extras added (see `ImportStats.filesSaved`). */
  filesSaved: number;
  targetsAdded: number;
  backgroundAdded: number;
};

/**
 * One import's progress, to its owner; null when the id is not theirs or not an import.
 *
 * Shared by the `getImportJobStatus` action and `GET /api/imports/[id]/status`. The client
 * polls the route: Server Actions from one tab run one at a time, so a poll every 1.5 s
 * for the length of an import queued the person's own saves behind it.
 */
export async function readImportJobStatus(userId: string, importId: string): Promise<ImportJobStatus | null> {
  if (!isImportId(importId)) return null;
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
  });
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    totalRows: row.totalRows ?? 0,
    rowsProcessed: row.rowsProcessed ?? 0,
    contactsCreated: row.contactsCreated ?? 0,
    contactsUpdated: row.contactsUpdated ?? 0,
    duplicatesFound: row.duplicatesFound ?? 0,
    errorMessage: row.errorMessage,
    interactionsLogged: row.stats?.interactionsLogged ?? 0,
    remindersCreated: row.stats?.remindersCreated ?? 0,
    failedRows: row.stats?.failedRows ?? 0,
    docsRead: row.stats?.docsRead ?? 0,
    filesSaved: row.stats?.filesSaved ?? 0,
    targetsAdded: row.stats?.targetsAdded ?? 0,
    backgroundAdded: row.stats?.backgroundAdded ?? 0,
  };
}
