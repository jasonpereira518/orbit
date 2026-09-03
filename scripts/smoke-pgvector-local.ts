/**
 * Documents the intentional local degradation: the pinned `@electric-sql/pglite` (0.5.x,
 * `^0.5.4`) has no `vector` extension export (that moved to a separate
 * `@electric-sql/pglite-pgvector` package pinned to PGlite `0.5.8`), so local PGlite never
 * installs pgvector and semantic search falls back to the bounded in-memory cosine scan.
 * True dev/prod parity requires upgrading to pglite >=0.5.8 + @electric-sql/pglite-pgvector.
 * Run: npx tsx scripts/smoke-pgvector-local.ts
 */
import { getDb, isPgvectorAvailable, rowsOf } from "../src/db";
import { pgvectorSearchContacts } from "../src/lib/search";
import { sql } from "drizzle-orm";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) {
    throw new Error("Unset DATABASE_URL — this smoke targets local PGlite.");
  }
  const db = await getDb();
  check("isPgvectorAvailable() is false locally", !isPgvectorAvailable());

  const hits = await pgvectorSearchContacts("smoke-pgvector-user", [1, 0, 0], 5);
  check(
    "pgvectorSearchContacts resolves to [] without throwing",
    Array.isArray(hits) && hits.length === 0
  );

  const ext = rowsOf<{ extname: string }>(
    await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`)
  );
  check("vector extension is absent locally", ext.length === 0);

  const trgm = rowsOf<{ extname: string }>(
    await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)
  );
  check("pg_trgm extension is present (extension detection works at all)", trgm.length === 1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
