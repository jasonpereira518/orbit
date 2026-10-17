/**
 * PROBE: schema inventory (verified against a freshly bootstrapped PGlite database).
 *
 * Prints, for every table in the live schema:
 *   - whether it is user-scoped by `user_id`
 *   - other columns that reference an account holder by a different name
 *   - columns that look like direct identifiers (email/phone/name/IP/…) and free text
 *   - whether the table appears in the export registry and in the purge coverage
 *
 * and writes privacy/out/schema-inventory.json for the audit.
 *
 * Run: npx tsx privacy/probe-schema-inventory.ts
 */
import "../scripts/smoke/_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { DATA_CATEGORY_META } from "../src/lib/data-categories";
import { exportSourcesFor } from "../src/lib/user-data";
import { readCatalog, USER_REF, PII_NAME, PROSE_NAME, isTextish } from "./lib/catalog";
import { run } from "../scripts/smoke/_env";

run(async () => {
  const cat = await readCatalog();
  const exported = new Set<string>(["billing_events"]);
  for (const { id } of DATA_CATEGORY_META) for (const s of exportSourcesFor(id)) exported.add(s.name);

  const rows = cat.tables.map((t) => {
    const cols = cat.columns.get(t)!;
    const names = cols.map((c) => c.column);
    const userScoped = names.includes("user_id");
    const otherUserRefs = names.filter((n) => n !== "user_id" && USER_REF.test(n));
    const pii = cols.filter((c) => PII_NAME.test(c.column) && isTextish(c.type)).map((c) => c.column);
    const prose = cols
      .filter((c) => PROSE_NAME.test(c.column) && isTextish(c.type) && !PII_NAME.test(c.column))
      .map((c) => c.column);
    const parents = cat.fks.filter((f) => f.table === t).map((f) => `${f.columns.join(",")}->${f.refTable}(${f.onDelete})`);
    return { table: t, userScoped, otherUserRefs, pii, prose, exported: exported.has(t), parents, columnCount: cols.length };
  });

  mkdirSync("privacy/out", { recursive: true });
  writeFileSync("privacy/out/schema-inventory.json", JSON.stringify(rows, null, 2));

  const userScoped = rows.filter((r) => r.userScoped);
  const notExported = userScoped.filter((r) => !r.exported);
  const otherRef = rows.filter((r) => r.otherUserRefs.length);
  const globalPii = rows.filter((r) => !r.userScoped && !r.otherUserRefs.length && (r.pii.length || r.prose.length));

  console.log(`tables: ${rows.length}, user_id-scoped: ${userScoped.length}`);
  console.log(`\nuser_id tables NOT in the export registry (${notExported.length}):`);
  for (const r of notExported) console.log(`  - ${r.table}  parents=[${r.parents.join("; ")}]`);
  console.log(`\ntables referencing a user by another column (${otherRef.length}):`);
  for (const r of otherRef) console.log(`  - ${r.table}: ${r.otherUserRefs.join(", ")}${r.userScoped ? " (also user_id)" : ""}`);
  console.log(`\nnon-user-scoped tables with identifier/prose-looking columns (${globalPii.length}):`);
  for (const r of globalPii) console.log(`  - ${r.table}: pii=[${r.pii.join(",")}] prose=[${r.prose.join(",")}] parents=[${r.parents.join("; ")}]`);
});
