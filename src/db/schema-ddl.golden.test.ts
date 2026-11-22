import "../../scripts/smoke/_env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { getDb, reconcileSchema, rowsOf } from "@/db";
import { DATA_CATEGORY_IDS, countedTableNames, exportSourcesFor } from "@/lib/user-data";
import { schemaCoverage } from "../../scripts/lib/schema-coverage";
import { expectGolden } from "@/test-support/golden";

/** Tables, columns (type, nullability, default), indexes and constraints, as one comparable value. */
async function schemaShape() {
  const db = await getDb();
  const q = async <T>(query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));
  const columns = await q<{ t: string; c: string; ty: string; n: string; d: string | null }>(sql`
    SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable AS n, column_default AS d
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`);
  const indexes = await q<{ i: string; def: string }>(sql`
    SELECT indexname AS i, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`);
  const constraints = await q<{ t: string; c: string; def: string }>(sql`
    SELECT conrelid::regclass::text AS t, conname AS c, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`);
  return { columns, indexes, constraints };
}

describe("schema DDL", () => {
  it("is idempotent: a forced full re-run on a built database changes nothing and fails nothing", async () => {
    const db = await getDb(); // first boot builds the schema on the fresh throwaway PGlite
    const before = await schemaShape();
    assert.ok(before.columns.length > 500, "the live schema should be large");

    // Drop the "schema is current" stamp so reconcileSchema replays every statement.
    await db.execute(sql`DELETE FROM schema_migrations`);
    const replay = await reconcileSchema();
    assert.equal(replay.applied, true, "the sweep ran");
    assert.deepEqual(replay.failed, [], "no DDL statement failed on the second pass");
    assert.deepEqual(await schemaShape(), before, "the schema is byte-for-byte what it was");

    const settled = await reconcileSchema();
    assert.equal(settled.applied, false, "and it is stamped current again");
  });

  it("declares everything schema.ts declares (characterization)", async () => {
    expectGolden(import.meta.url, "schema-coverage", await schemaCoverage());
  });
});

describe("purge registry (characterization)", () => {
  it("pins the user_id tables the registry in user-data.ts does not list", async () => {
    const db = await getDb();
    const live = rowsOf<{ t: string }>(
      await db.execute(sql`
        SELECT DISTINCT c.table_name AS t FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE'
        ORDER BY 1`)
    ).map((r) => r.t);

    // "The registry" = every table a category counts or exports. The delete closures in STEPS
    // are opaque, and each category's export is documented as "same boundary as the delete".
    // Tables only removed by an FK cascade (chat_messages, import_job_rows, action_items, ...)
    // show up here when they are not also exported; user-data.ts documents which are cascade-
    // covered, and scripts/smoke-purge.ts proves the real deletion row by row.
    const registry = new Set<string>();
    for (const category of DATA_CATEGORY_IDS) {
      for (const t of countedTableNames(category)) registry.add(t);
      for (const s of exportSourcesFor(category)) registry.add(s.name);
    }

    const missingFromCountsAndExports = live.filter((t) => !registry.has(t));

    // The purge closures themselves are opaque, so the second tier reads user-data.ts as text:
    // a table whose schema identifier appears outside the import block is a delete/update
    // target there (embedding_failures, cloud_note_sources, credit_*, plan_meter_usage, ...).
    const source = readFileSync(new URL("../lib/user-data.ts", import.meta.url), "utf8").replace(
      /import\s*\{[^}]*\}\s*from\s*"@\/db\/schema";/,
      ""
    );
    const mentioned = new Set<string>();
    for (const [exportName, value] of Object.entries(schema)) {
      if (is(value, PgTable) && new RegExp(`\\b${exportName}\\b`).test(source)) mentioned.add(getTableName(value));
    }
    const missing = missingFromCountsAndExports.filter((t) => !mentioned.has(t));
    // Registry entries that are not tables with a user_id (joined exports such as contact_tags).
    const registeredWithoutUserId = [...registry].filter((t) => !live.includes(t)).sort();
    expectGolden(import.meta.url, "purge-registry-gap", {
      note: "user_id tables missing from the user-data.ts registry; P9.2 drives `missing` to empty. `missing` = no count, export or mention in user-data.ts; the two left rely on FK cascade from contacts (documented in user-data.ts, verified by scripts/smoke-purge.ts).",
      liveUserIdTables: live.length,
      registryTables: registry.size,
      missingFromCountsAndExports,
      missing,
      registeredWithoutUserId,
    });
  });
});
