import { and, eq, getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb } from "@/db";
import { decryptWithStatus, encrypt } from "@/lib/crypto";

/**
 * Lazy re-encryption on read (audit L-06).
 *
 * A stored ciphertext in the legacy format, or one made with `ENCRYPTION_SECRET_PREVIOUS`, is
 * rewritten under the current secret the first time it is read. The write is a compare-and-
 * swap on the exact stored value, so it can never overwrite a token a concurrent refresh just
 * stored, and it is best-effort: a failed rewrite leaves a readable value behind and is simply
 * tried again on the next read.
 */
export type RewrapTarget = {
  table: PgTable;
  column: PgColumn;
  idColumn: PgColumn;
  id: string;
};

/** Override in tests to observe rewrites without a database. */
let rewrapWriter: ((target: RewrapTarget, stored: string, fresh: string) => Promise<void>) | null = null;

export function setRewrapWriterForTest(
  writer: ((target: RewrapTarget, stored: string, fresh: string) => Promise<void>) | null
) {
  rewrapWriter = writer;
}

async function writeRewrap(target: RewrapTarget, stored: string, fresh: string): Promise<void> {
  if (rewrapWriter) return rewrapWriter(target, stored, fresh);
  const db = await getDb();
  await db
    .update(target.table)
    .set({ [columnKey(target.table, target.column)]: fresh })
    .where(and(eq(target.idColumn, target.id), eq(target.column, stored)));
}

/** The JS property name drizzle uses for a column on its table. */
function columnKey(table: PgTable, column: PgColumn): string {
  for (const [key, value] of Object.entries(getTableColumns(table))) {
    if (value === column) return key;
  }
  throw new Error(`Column ${column.name} is not on this table`);
}

/**
 * Decrypt `stored`, re-encrypting it in place when it is stale. Null for a missing or
 * undecryptable value, exactly like `decryptOrNull`.
 */
export async function decryptAndRewrap(
  stored: string | null | undefined,
  target: Omit<RewrapTarget, "id"> & { id: string | null | undefined }
): Promise<string | null> {
  if (!stored) return null;
  let result;
  try {
    result = decryptWithStatus(stored);
  } catch {
    return null;
  }
  if (result.stale && target.id) {
    try {
      await writeRewrap({ ...target, id: target.id }, stored, encrypt(result.plaintext));
    } catch {
      // Best-effort; the stored value still decrypts, and the next read tries again.
    }
  }
  return result.plaintext;
}

/** `decryptAndRewrap` that throws on an undecryptable value, for callers built on `decrypt`. */
export async function decryptAndRewrapStrict(
  stored: string,
  target: Omit<RewrapTarget, "id"> & { id: string }
): Promise<string> {
  const result = decryptWithStatus(stored);
  if (result.stale) {
    try {
      await writeRewrap(target, stored, encrypt(result.plaintext));
    } catch {
      // Best-effort, as above.
    }
  }
  return result.plaintext;
}
