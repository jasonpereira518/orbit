import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { decryptDetailed, encrypt } from "@/lib/crypto";

/**
 * Re-encrypt every stored secret under the CURRENT `ENCRYPTION_SECRET`.
 *
 * Rotation is: put the old secret in `ENCRYPTION_PREVIOUS_SECRETS`, set the new
 * `ENCRYPTION_SECRET`, deploy (reads fall back to the old one, so nothing breaks), run this
 * until `remaining` is 0, then drop the old secret. Only rows that an old secret opened are
 * rewritten, each with an update that matches the value it read, so a row changed in the
 * meantime is left alone and picked up on the next run. Idempotent and resumable.
 *
 * Columns are found by name (`*encrypted*`) so a new secret column is covered without editing
 * this list, plus `calendar_subscriptions.ics_url`, which holds sealed URLs among plain ones.
 * Anything that is merely HMAC-keyed by the secret (unsubscribe links, OAuth state, log tags)
 * is NOT stored ciphertext: rotating changes those and old links stop verifying.
 */
export type ReencryptReport = {
  columns: number;
  scanned: number;
  rewritten: number;
  /** Present but opened by no configured secret. Rotation is not safe to finish while > 0. */
  undecryptable: number;
  /** Rows an old secret still opens (dry run), or that raced and will be picked up next run. */
  remaining: number;
};

const SEALED = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;
const BATCH = 500;

export async function ciphertextColumns(): Promise<Array<{ table: string; column: string }>> {
  const db = await getDb();
  const rows = rowsOf<{ table_name: string; column_name: string }>(
    await db.execute(sql`
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        JOIN information_schema.key_column_usage k
          ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = 'id'
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema AND tc.constraint_type = 'PRIMARY KEY'
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = 'text'
         AND (c.column_name LIKE '%encrypted%' OR (c.table_name = 'calendar_subscriptions' AND c.column_name = 'ics_url'))
       ORDER BY 1, 2`)
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

export async function reencryptAll(options: { apply: boolean }): Promise<ReencryptReport> {
  const db = await getDb();
  const columns = await ciphertextColumns();
  const report: ReencryptReport = { columns: columns.length, scanned: 0, rewritten: 0, undecryptable: 0, remaining: 0 };
  for (const { table, column } of columns) {
    const t = sql.raw(`"${table}"`);
    const c = sql.raw(`"${column}"`);
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const batch = rowsOf<{ id: string; v: string }>(
        await db.execute(sql`SELECT id::text AS id, ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND id > ${after}::uuid ORDER BY id LIMIT ${BATCH}`)
      );
      if (batch.length === 0) break;
      for (const { id, v } of batch) {
        if (!SEALED.test(v)) continue; // plain text (legacy ICS urls) or not ours
        report.scanned += 1;
        let detail;
        try {
          detail = decryptDetailed(v);
        } catch {
          report.undecryptable += 1;
          continue;
        }
        if (!detail.usedPrevious) continue;
        if (!options.apply) {
          report.remaining += 1;
          continue;
        }
        const updated = rowsOf(
          await db.execute(sql`UPDATE ${t} SET ${c} = ${encrypt(detail.plaintext)} WHERE id = ${id}::uuid AND ${c} = ${v} RETURNING 1`)
        );
        if (updated.length) report.rewritten += 1;
        else report.remaining += 1; // changed under us: next run
      }
      after = batch[batch.length - 1]!.id;
    }
  }
  return report;
}
