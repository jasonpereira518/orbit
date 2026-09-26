import { getDb, runAtomicWrite } from "@/db";
import { importJobRows } from "@/db/schema";

/**
 * Rows per INSERT when staging an import's work queue.
 *
 * Postgres caps one statement at 65,535 bind parameters, and each staged row binds four
 * (import_id, user_id, row_index, payload; the rest go out as DEFAULT). A single INSERT
 * therefore failed outright at about 16k rows, which is an ordinary LinkedIn export or a
 * calendar file where every event × attendee is a row. 1,000 keeps each statement well
 * under the cap and each payload chunk a sane size.
 */
export const IMPORT_ROW_INSERT_CHUNK = 1_000;

export type StagedImportRow = typeof importJobRows.$inferInsert;

/**
 * Stages an import's rows in chunks, all-or-nothing.
 *
 * Atomic on purpose: the runner treats the staged rows as the whole job, so a failure
 * halfway through must not leave a job that silently imports only the first chunks.
 * `runAtomicWrite` sends every chunk in one Neon HTTP batch (a PGlite transaction locally).
 */
export async function stageImportRows(rows: StagedImportRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  await runAtomicWrite(db, (writer) => {
    const statements = [];
    for (let i = 0; i < rows.length; i += IMPORT_ROW_INSERT_CHUNK) {
      statements.push(writer.insert(importJobRows).values(rows.slice(i, i + IMPORT_ROW_INSERT_CHUNK)));
    }
    return statements;
  });
}
