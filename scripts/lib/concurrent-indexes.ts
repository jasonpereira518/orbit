/**
 * Build new indexes on the big tables CONCURRENTLY, ahead of the migration sweep.
 *
 * The sweep (`reconcileSchema`) runs plain CREATE INDEX IF NOT EXISTS, which holds a lock
 * that blocks every write to the table for as long as the build takes. At Orbit's target
 * scale that is minutes on contacts, interactions or memory_chunks, during which saving a
 * note fails. CONCURRENTLY builds without blocking writes, but it cannot run inside a
 * transaction or a DO block, so it cannot live in the sweep. Instead the build step creates
 * those indexes here first, and the sweep's IF NOT EXISTS then finds them and does nothing.
 *
 * Best effort by design. An index whose column the sweep has not added yet simply fails
 * here and is built by the sweep, as before. A failed concurrent build leaves an INVALID
 * index behind, which IF NOT EXISTS would then skip forever, so invalid ones are dropped first.
 */
import { neon } from "@neondatabase/serverless";
import { SCALE_DDL } from "../../src/db";

/** Tables big enough per account that a blocking build is a user-visible outage. */
const LARGE_TABLES = ["contacts", "interactions", "memory_chunks", "action_items", "reminders", "interaction_mentions", "chat_messages"];

/** SCALE_DDL's plain index builds on the large tables, rewritten to build concurrently. Pure. */
export function concurrentIndexStatements(statements: readonly string[]): Array<{ name: string; sql: string }> {
  const out: Array<{ name: string; sql: string }> = [];
  for (const statement of statements) {
    const text = statement.replace(/\s+/g, " ").trim();
    const m = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)\b(.*)$/i.exec(text);
    if (!m || m[1] || !LARGE_TABLES.includes(m[3]!)) continue; // unique ones stay in the sweep
    out.push({ name: m[2]!, sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${m[2]} ON ${m[3]}${m[4]}` });
  }
  return out;
}

/**
 * SCALE_DDL's column adds on the large tables that are metadata-only in Postgres 11+: a
 * boolean with a constant default rewrites nothing. Run before the index builds, so an index
 * on a new column (interactions_memory_dirty_idx) can be built concurrently too. Pure.
 */
export function metadataOnlyColumnAdds(statements: readonly string[]): string[] {
  return statements
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => {
      const m = /^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS \w+ boolean NOT NULL DEFAULT (true|false)$/i.exec(s);
      return Boolean(m && LARGE_TABLES.includes(m[1]!));
    });
}

export async function prebuildIndexesConcurrently(databaseUrl: string): Promise<{ built: string[]; skipped: string[] }> {
  const sql = neon(databaseUrl);
  const built: string[] = [];
  const skipped: string[] = [];
  for (const statement of metadataOnlyColumnAdds(SCALE_DDL)) {
    await sql.query(statement).catch(() => undefined);
  }
  for (const { name, sql: statement } of concurrentIndexStatements(SCALE_DDL)) {
    try {
      const invalid = (await sql.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
        [name]
      )) as unknown[];
      if (invalid.length) await sql.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      const existing = (await sql.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name])) as unknown[];
      if (existing.length) continue;
      await sql.query(statement);
      built.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { built, skipped };
}
