import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

/**
 * A keyed lease for background work that must not run twice at once (`job_leases`, v113).
 *
 * Taken with one INSERT ... ON CONFLICT that only overwrites an EXPIRED holder, so of two
 * callers racing for a free key exactly one gets it, and a holder that died frees the key
 * when its time runs out. Times are the database's, so instance clocks cannot disagree.
 * Released only by its holder.
 */
export async function acquireJobLease(key: string, holder: string, ms: number): Promise<boolean> {
  const db = await getDb();
  const rows = rowsOf<{ key: string }>(
    await db.execute(sql`
      INSERT INTO job_leases (key, holder, until)
      VALUES (${key}, ${holder}, now() + make_interval(secs => ${ms / 1000}))
      ON CONFLICT (key) DO UPDATE
         SET holder = EXCLUDED.holder, until = EXCLUDED.until
       WHERE job_leases.until < now()
      RETURNING key
    `)
  );
  return rows.length > 0;
}

export async function releaseJobLease(key: string, holder: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM job_leases WHERE key = ${key} AND holder = ${holder}`);
}
