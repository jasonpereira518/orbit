/**
 * EXPLAIN (ANALYZE, BUFFERS) a list of named queries against a seeded PGlite directory —
 * the audit's B10 table (PERFORMANCE_AUDIT.md). Queries are written for user `demo-user`.
 *
 *   ORBIT_PGLITE_DIR=<seeded copy> npx tsx scripts/dev/perf/explain-suite.ts \
 *     scripts/dev/perf/queries.json out.txt
 *
 * PGlite ignores statement_timeout (no signals in WASM), so a pathological query runs to
 * the end; replay it on a native Postgres loaded with the same rows instead.
 */
import { readFileSync, writeFileSync } from "node:fs";

type PlanClient = {
  query: (sql: string) => Promise<{ rows: Array<Record<string, string>> }>;
  exec: (sql: string) => Promise<unknown>;
};
type NamedQuery = { name: string; sql: string; pre?: string };

(async () => {
  const { getDb } = await import("../../../src/db");
  await getDb();
  const pg = (globalThis as unknown as { orbitPglite: PlanClient }).orbitPglite;
  const queries: NamedQuery[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const out: string[] = [];
  for (const q of queries) {
    try {
      if (q.pre) await pg.exec(q.pre);
      const r = await pg.query(`EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`);
      const plan = r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      out.push(`### ${q.name}\n${plan}\n`);
      console.log(`${q.name}\texec=${plan.match(/Execution Time: ([\d.]+)/)?.[1]}ms`);
    } catch (e) {
      out.push(`### ${q.name}\nERROR ${(e as Error).message}\n`);
      console.log(`${q.name}\tERROR ${(e as Error).message.slice(0, 150)}`);
    }
  }
  writeFileSync(process.argv[3], out.join("\n"));
  process.exit(0);
})();
