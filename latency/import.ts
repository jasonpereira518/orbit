/**
 * LinkedIn import throughput at one data tier, in-process: how long before the person sees
 * the first progress, and rows per second once the engine runs.
 *
 *   ORBIT_PGLITE_DIR=latency/.data/tier-5000 npx tsx latency/import.ts --tier 5000 [--rows 20000] [--out ...]
 *
 * Two phases, timed separately, the way the product does them (src/actions/imports.ts):
 *   stage   parse the CSV and write every row into import_job_rows in 1,000-row inserts.
 *           The action returns — and the progress bar first appears — only after this.
 *   run     the engine (src/lib/import-engine.ts) in 250-row chunks: dedupe against the
 *           whole network, company resolution, bulk create/merge, closeness recalibration.
 *           Embeddings and avatars are deferred to backfills and are not in this number.
 * The second run re-imports the same rows so every row takes the merge path (the realistic
 * "I re-uploaded my export" case).
 *
 * Statement counts come from the drizzle logger; divide by chunks for the per-chunk cost.
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import { companies, contacts, importJobRows, imports } from "../src/db/schema";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import Papa from "papaparse";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
env.ORBIT_JEV ||= "off";
if (!env.ORBIT_PGLITE_DIR) throw new Error("ORBIT_PGLITE_DIR is required");

const USER = "demo-user";
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const TIER = flag("tier", "?");
const ROWS = Number(flag("rows", "20000"));
const OUT = flag("out", `latency/results/import-${TIER}.json`);

const FIRST = ["Olivia","Liam","Emma","Noah","Ava","Ethan","Sophia","Mason","Isabella","Lucas","Mia","Elijah","Amelia","Oliver","Harper","Benjamin","Evelyn","James","Abigail","Henry","Emily","Alexander","Ella","Michael","Scarlett"];
const LAST = ["Nguyen","Garcia","Patel","Kowalski","Johansson","Okafor","Silva","Andersson","Tanaka","Kim","Rossi","Dubois","Haddad","Novak","Larsen","Petrov","Costa","Ibrahim","Fischer","Yamada"];

/** A LinkedIn Connections.csv the size of a real export. */
function buildCsv(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    "First Name": FIRST[i % FIRST.length],
    "Last Name": `${LAST[Math.floor(i / FIRST.length) % LAST.length]}${Math.floor(i / (FIRST.length * LAST.length)) || ""}`,
    URL: `https://www.linkedin.com/in/lat-import-${i}`,
    "Email Address": i % 3 === 0 ? `lat${i}@example.com` : "",
    Company: `Company ${i % 211}`,
    Position: `Title ${i % 37}`,
    "Connected On": "15 Mar 2024",
  }));
  return "Notes:\n\"When exporting your connection data...\"\n\n" + Papa.unparse(rows);
}

async function stage(csv: string) {
  const db = await getDb();
  const { runAtomicWrite } = await import("../src/db");
  const started = performance.now();
  const parsed = Papa.parse<Record<string, string>>(csv.split("\n").slice(3).join("\n"), { header: true, skipEmptyLines: true });
  const parseMs = performance.now() - started;
  const [job] = await db.insert(imports).values({ userId: USER, importType: "linkedin_connections", fileName: "Connections.csv", status: "processing", totalRows: parsed.data.length, stats: {} }).returning();
  const payloads = parsed.data.map((r, i) => ({ index: i, firstName: r["First Name"], lastName: r["Last Name"], email: r["Email Address"] || null, company: r.Company, position: r.Position, connectedOn: r["Connected On"], url: r.URL }));
  startQueryCount();
  for (let i = 0; i < payloads.length; i += 1000) {
    const slice = payloads.slice(i, i + 1000);
    await runAtomicWrite(db, (w) => [w.insert(importJobRows).values(slice.map((payload, k) => ({ importId: job.id, userId: USER, rowIndex: i + k, payload: payload as never })))]);
  }
  const statements = stopQueryCount();
  return { jobId: job.id, rows: payloads.length, parse_ms: Math.round(parseMs), stage_ms: Math.round(performance.now() - started), statements };
}

async function run(jobId: string) {
  const { runImportJob, CHUNK_SIZE } = await import("../src/lib/import-engine");
  const db = await getDb();
  const started = performance.now();
  let firstChunkAt: number | null = null;
  // Watch the job row the way the client's poll does, to time the first visible progress.
  // Every change the poll sees is kept (first 40), with the poll's own round-trip time, so a
  // poll that is starved or queued behind the engine's statements is visible as such.
  const samples: Array<{ at: number; rows: number | null; poll_ms: number; error?: string }> = [];
  let lastRows: number | null = null;
  let polling = false;
  const watcher = setInterval(async () => {
    if (polling) return;
    polling = true;
    const t = performance.now();
    try {
      const row = await db.query.imports.findFirst({ where: eq(imports.id, jobId), columns: { rowsProcessed: true } });
      const rows = Number((row as { rowsProcessed?: number } | undefined)?.rowsProcessed ?? 0);
      if (rows !== lastRows && samples.length < 40) samples.push({ at: Math.round(performance.now() - started), rows, poll_ms: Math.round(performance.now() - t) });
      lastRows = rows;
      if (firstChunkAt == null && rows > 0) firstChunkAt = performance.now() - started;
    } catch (err) {
      if (samples.length < 40) samples.push({ at: Math.round(performance.now() - started), rows: null, poll_ms: Math.round(performance.now() - t), error: String(err).slice(0, 120) });
    } finally {
      polling = false;
    }
  }, 250);
  startQueryCount();
  try { await runImportJob(jobId); } catch (err) { const m = String(err); if (!m.includes("static generation store missing")) throw err; }
  const statements = stopQueryCount();
  clearInterval(watcher);
  const total = performance.now() - started;
  const finished = await db.query.imports.findFirst({ where: eq(imports.id, jobId) });
  const f = finished as unknown as { status?: string; rowsProcessed?: number; stats?: Record<string, unknown> } | undefined;
  return { run_ms: Math.round(total), first_progress_ms: firstChunkAt == null ? null : Math.round(firstChunkAt), progress_samples: samples, status: f?.status, processed: f?.rowsProcessed, stats: f?.stats, statements, chunk_size: CHUNK_SIZE, rows_per_s: f?.rowsProcessed ? Math.round((f.rowsProcessed / total) * 1000) : null };
}

async function main() {
  const db = await getDb();
  const before = await db.$count(contacts, eq(contacts.userId, USER));
  const csv = buildCsv(ROWS);
  console.error(`csv: ${ROWS} rows, ${(csv.length / 1024).toFixed(0)} KB; network before: ${before} contacts`);
  const staged = await stage(csv);
  console.error("stage:", JSON.stringify(staged));
  const create = await run(staged.jobId);
  console.error("run (creates):", JSON.stringify({ ...create, stats: undefined, progress_samples: undefined }));
  console.error("progress samples (creates):", JSON.stringify(create.progress_samples));
  const staged2 = await stage(csv);
  const merge = await run(staged2.jobId);
  console.error("run (merges):", JSON.stringify({ ...merge, stats: undefined, progress_samples: undefined }));
  // Leave the tier as it was found: only the rows this script created carry its URLs.
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER} AND linkedin_url LIKE 'https://www.linkedin.com/in/lat-import-%'`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER} AND name LIKE 'Company %' AND id NOT IN (SELECT company_id FROM contacts WHERE user_id = ${USER} AND company_id IS NOT NULL)`);
  await db.delete(imports).where(eq(imports.userId, USER));
  void companies;
  const after = await db.$count(contacts, eq(contacts.userId, USER));
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ tier: TIER, rows: ROWS, csv_kb: Math.round(csv.length / 1024), network_before: before, network_after: after, stage: staged, create, stage_again: staged2, merge, at: new Date().toISOString() }, null, 2));
  console.log(`wrote ${OUT}`);
  await closeDb();
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await closeDb().catch(() => undefined); process.exit(1); });
