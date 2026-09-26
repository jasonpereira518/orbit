/**
 * Staging an import's rows (`src/lib/import-job-rows.ts`).
 *
 * Every import used to stage its work queue in ONE insert. Postgres caps a statement at
 * 65,535 bind parameters and each row binds four, so an import of about 16k rows failed
 * before any of it ran — an ordinary LinkedIn export at the sizes Orbit is built for. The
 * rows now go in chunks, and still all-or-nothing, because the runner treats what is
 * staged as the whole job.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-import-row-staging.ts
 */
import "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { getDb } from "../src/db";
import { importJobRows, imports } from "../src/db/schema";
import { IMPORT_ROW_INSERT_CHUNK, stageImportRows } from "../src/lib/import-job-rows";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "import-staging-user";
const ROWS = 20_000;

async function main() {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({ userId: USER, importType: "linkedin_connections", status: "processing", totalRows: ROWS, stats: {} })
    .returning();

  const payload = (i: number) => ({ index: i, firstName: `First${i}`, lastName: "Last", email: "", company: "", position: "", url: "", connectedOn: "" });

  console.log(`a ${ROWS.toLocaleString()}-row import`);
  let error: unknown = null;
  try {
    await stageImportRows(
      Array.from({ length: ROWS }, (_, i) => ({ importId: job!.id, userId: USER, rowIndex: i, payload: payload(i) as never }))
    );
  } catch (err) {
    error = err;
  }
  check("stages without hitting the bind-parameter cap", error === null, String(error));
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importJobRows)
    .where(eq(importJobRows.importId, job!.id))) as [{ n: number }];
  check("every row is there, exactly once", n === ROWS, `${n} rows`);
  check("a chunk stays far under 65,535 parameters", IMPORT_ROW_INSERT_CHUNK * 4 < 65_535);

  console.log("a failure part-way through");
  const [job2] = await db
    .insert(imports)
    .values({ userId: USER, importType: "linkedin_connections", status: "processing", totalRows: 2_500, stats: {} })
    .returning();
  const rows = Array.from({ length: 2_500 }, (_, i) => ({
    // The last chunk names an import that does not exist, so its insert violates the FK.
    importId: i < 2_100 ? job2!.id : "00000000-0000-4000-8000-000000000000",
    userId: USER,
    rowIndex: i,
    payload: payload(i) as never,
  }));
  let failed = false;
  try {
    await stageImportRows(rows);
  } catch {
    failed = true;
  }
  const [{ m }] = (await db
    .select({ m: sql<number>`count(*)::int` })
    .from(importJobRows)
    .where(eq(importJobRows.importId, job2!.id))) as [{ m: number }];
  check("the bad chunk fails the staging", failed);
  check("and none of the good chunks are left behind", m === 0, `${m} rows left`);

  console.log("no import stages rows any other way");
  for (const file of ["src/actions/imports.ts", "src/lib/drive-import-processor.ts"]) {
    const src = readFileSync(file, "utf8");
    check(`${file} goes through stageImportRows`, !/insert\(importJobRows\)\s*\.values\(/.test(src) && src.includes("stageImportRows("));
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll import row staging checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
