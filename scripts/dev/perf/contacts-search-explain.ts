import { and, eq, not, sql } from "drizzle-orm";
import { getDb, rowsOf, closeDb } from "../../../src/db";
import { contacts } from "../../../src/db/schema";
import { contactSearchCondition, nameMatchTierSql } from "../../../src/lib/contact-search-rank";
import { contactsOrderBy } from "../../../src/lib/contacts-page-cursor";
import { contactsListSelection } from "../../../src/lib/contact-avatar-sql";
import { nonPersonContactSql } from "../../../src/lib/non-person-participant";
const U = "demo-user";
async function main() {
  const db = await getDb();
  for (const q of ["sarah", "engineer at acme"]) {
    const tier = nameMatchTierSql(q);
    const where = and(eq(contacts.userId, U), not(nonPersonContactSql()), contactSearchCondition(q, U));
    const page = db.select({ ...contactsListSelection, nameTier: tier }).from(contacts).where(where).orderBy(...contactsOrderBy("relevance", tier, [])).limit(51);
    const count = db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where);
    for (const [name, qb] of [["PAGE", page], ["COUNT", count]] as const) {
      const { sql: text, params } = qb.toSQL();
      const res = rowsOf<Record<string, string>>(await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${inline(text, params)}`)));
      console.log(`\n=== ${q} / ${name}`);
      const lines = res.map((r) => Object.values(r)[0] as string);
      const summary = lines.filter((l) => /^(Planning|Execution) Time/.test(l)).join("  ");
      const nodes = lines.filter((l) => /Seq Scan|Index Scan|Bitmap Heap|Hash Join|Nested Loop/.test(l)).map((l) => l.trim().replace(/ \(actual.*/, "")).join(" | ");
      console.log(`${summary}\n${nodes}`);
      if (process.env.EXPLAIN_FULL) console.log(lines.join("\n"));
    }
  }
  await closeDb();
  process.exit(0);
}
function inline(text: string, params: unknown[]) {
  return text.replace(/\$(\d+)/g, (_m, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return String(v);
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}
main();
