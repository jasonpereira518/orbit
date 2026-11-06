/**
 * Perf audit: LinkedIn Connections import at size N against a fresh PGlite (ORBIT_PGLITE_DIR).
 * Measures CSV bytes vs the one-request ceiling, parse ms, staging ms, engine wall/rows-per-s,
 * statements per row, peak RSS/heap, and query-counter retention after the run.
 *   ORBIT_PGLITE_DIR=$(mktemp -d) npx tsx scripts/dev/perf/import-bench.ts 10000
 * Add NODE_OPTIONS=--cpu-prof to see where the engine's time goes.
 */
// A module, not a global script: with only dynamic imports its top-level names would
// collide with other scripts' (`main` did, with scripts/post-deploy-smoke.ts).
export {};

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_perf-import";
process.env.CLERK_SECRET_KEY ||= "sk_test_perf-import";

const N = Number(process.argv[2]);
const USER = "perf-import-user";
const FIRST = ["Olivia","Liam","Emma","Noah","Ava","Ethan","Sophia","Mason","Isabella","Lucas","Mia","Elijah","Amelia","Oliver","Harper","Benjamin","Evelyn","James","Abigail","Henry","Emily","Alexander","Ella","Michael","Scarlett"];
const LAST = ["Nguyen","Garcia","Patel","Kowalski","Johansson","Okafor","Silva","Andersson","Tanaka","Kim","Rossi","Dubois","Haddad","Novak","Larsen","Petrov","Costa","Ibrahim","Fischer","Yamada"];

let peakRss = 0;
let peakHeap = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 50);
const mb = (b: number) => Math.round(b / 1048576);

async function main() {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../../../src/db");
  const { imports, userSettings } = await import("../../../src/db/schema");
  const { parseLinkedInConnectionsCsv } = await import("../../../src/lib/linkedin-connections");
  const { stageImportRows } = await import("../../../src/lib/import-job-rows");
  const { runLinkedInImportJob } = await import("../../../src/lib/import-job-processor");
  const { capturedQueries, startQueryCount, stopQueryCount } = await import("../../../src/lib/query-counter");
  const { fitsInOneRequest, IMPORT_TEXT_MAX_BYTES } = await import("../../../src/lib/capture-limits");
  const { ensureUserSettings } = await import("../../../src/lib/user-settings");

  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, USER));
  const base = process.memoryUsage();

  const lines = ["Notes:", '"When exporting your connection data, you may notice..."', "", "First Name,Last Name,URL,Email Address,Company,Position,Connected On"];
  for (let i = 0; i < N; i++) {
    const f = FIRST[i % FIRST.length];
    const l = `${LAST[Math.floor(i / FIRST.length) % LAST.length]}${Math.floor(i / 500)}`;
    lines.push(`${f},${l},https://www.linkedin.com/in/${f.toLowerCase()}-${l.toLowerCase()}-${i},${i % 3 ? "" : `${f}.${i}@example.com`},Company ${i % 997},Title ${i % 61},15 Mar 2024`);
  }
  const csv = lines.join("\n");
  const bytes = Buffer.byteLength(csv);

  let t = performance.now();
  const { rows } = parseLinkedInConnectionsCsv(csv);
  const parseMs = performance.now() - t;

  const [job] = await db
    .insert(imports)
    .values({ userId: USER, importType: "linkedin_connections", fileName: `perf-${N}.csv`, status: "processing", totalRows: rows.length, stats: {} })
    .returning();
  t = performance.now();
  await stageImportRows(
    rows.map((row, index) => ({
      importId: job.id,
      userId: USER,
      rowIndex: index,
      payload: { index, firstName: row.firstName, lastName: row.lastName, email: row.email, company: row.company, position: row.position, connectedOn: row.connectedOn, url: row.url },
    }))
  );
  const stageMs = performance.now() - t;

  startQueryCount();
  t = performance.now();
  // The engine self-continues by HTTP when its 4.5-min budget runs out; loop in-process instead.
  let passes = 0;
  for (;;) {
    passes++;
    try {
      await runLinkedInImportJob(job.id);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!/static generation store missing|outside a request scope|fetch failed|ECONNREFUSED/.test(m)) throw err;
    }
    const cur = await db.query.imports.findFirst({ where: eq(imports.id, job.id), columns: { status: true } });
    if (cur?.status !== "processing" || passes > 20) break;
  }
  const runMs = performance.now() - t;
  const statements = stopQueryCount();
  const captured = capturedQueries();
  const capturedChars = captured.reduce((s, q) => s + q.length, 0);
  const fin = await db.query.imports.findFirst({ where: eq(imports.id, job.id) });
  clearInterval(sampler);
  console.log(JSON.stringify({
    N, csv_kb: Math.round(bytes / 1024), fits_one_request: fitsInOneRequest(csv), ceiling_kb: Math.round(IMPORT_TEXT_MAX_BYTES / 1024),
    parse_ms: Math.round(parseMs), stage_ms: Math.round(stageMs), run_ms: Math.round(runMs), passes,
    rows_per_s: Math.round(rows.length / (runMs / 1000)), statements, statements_per_1k_rows: Math.round((statements / rows.length) * 1000),
    status: fin?.status, stats: fin?.stats,
    query_counter_retained: { entries: captured.length, mb: Math.round(capturedChars / 1048576 * 10) / 10 },
    base_rss_mb: mb(base.rss), peak_rss_mb: mb(peakRss), peak_heap_mb: mb(peakHeap),
  }));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
