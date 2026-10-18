/**
 * EXPLAIN (ANALYZE) the hot statements against a seeded tier, locally on PGlite.
 *
 *   ORBIT_PGLITE_DIR=latency/.data/tier-5000 npx tsx latency/explain.ts [--only duplicates,dashboard]
 *
 * PGlite is a real Postgres planner and executor (single connection, WASM), so plan SHAPE
 * (seq scan vs index, nested loop vs hash join, rows removed by filter) is representative;
 * absolute times are not. The same statements with Neon-only parts (HNSW) are in
 * LATENCY_BASELINE.md under "Staging and production readings".
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
if (!env.ORBIT_PGLITE_DIR) throw new Error("ORBIT_PGLITE_DIR is required");
const USER = "demo-user";
const only = (process.argv.slice(2).find((a, i, xs) => xs[i - 1] === "--only") ?? "").split(",").filter(Boolean);

const STATEMENTS: Record<string, string> = {
  duplicates: `SELECT a.id, b.id FROM contacts a JOIN contacts b ON b.user_id = a.user_id AND lower(btrim(b.full_name)) = lower(btrim(a.full_name)) AND a.id < b.id
    WHERE a.user_id = '${USER}' AND btrim(coalesce(a.full_name,'')) <> ''
      AND NOT (btrim(coalesce(a.company,'')) <> '' AND lower(btrim(a.company)) = lower(btrim(b.company)))
      AND NOT (btrim(coalesce(a.title,'')) <> '' AND lower(btrim(a.title)) = lower(btrim(b.title)))
      AND NOT EXISTS (SELECT 1 FROM duplicate_suggestions s WHERE s.user_id = a.user_id AND s.status <> 'pending' AND s.contact_a_id = LEAST(a.id,b.id) AND s.contact_b_id = GREATEST(a.id,b.id))
    LIMIT 99`,
  dashboard_scan: `SELECT id, full_name, company, updated_at, (btrim(notes) <> '') AS has_notes FROM contacts WHERE user_id = '${USER}' ORDER BY updated_at DESC, id DESC`,
  touches: `SELECT contact_id, count(*) FROM interactions WHERE user_id = '${USER}' GROUP BY contact_id`,
  unscored: `SELECT id FROM contacts WHERE user_id = '${USER}' AND closeness_computed_at IS NULL`,
  reminders_panel: `SELECT * FROM reminders WHERE user_id = '${USER}' AND status = 'pending' ORDER BY due_date LIMIT 80`,
  suggestions_panel: `SELECT * FROM ai_suggestions WHERE user_id = '${USER}' AND status = 'pending' ORDER BY confidence_score DESC LIMIT 30`,
  avatar_sql: `SELECT id, (btrim(profile_image_url) LIKE 'data:image/%') AS inline FROM contacts WHERE user_id = '${USER}' ORDER BY updated_at DESC LIMIT 50`,
  contacts_search: `SELECT id FROM contacts WHERE user_id = '${USER}' AND (search_tsv @@ websearch_to_tsquery('simple','hopper') OR lower(full_name) LIKE 'hopper%' OR lower(company) LIKE 'hopper%' OR lower(email) LIKE 'hopper%') ORDER BY full_name LIMIT 51`,
  fts_arm: `SELECT id FROM contacts WHERE user_id = '${USER}' AND search_tsv @@ websearch_to_tsquery('simple','engineer OR acme') ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('simple','engineer OR acme')) DESC LIMIT 40`,
  trigram_arm: `SELECT id FROM contacts WHERE user_id = '${USER}' AND (lower(full_name) LIKE 'hopp%' OR lower(coalesce(company,'')) LIKE 'hopp%' OR lower(full_name) % 'hopp' OR lower(coalesce(company,'')) % 'hopp') LIMIT 40`,
  memory_lexical: `SELECT id FROM memory_chunks WHERE user_id = '${USER}' AND search_tsv @@ websearch_to_tsquery('simple','hiring recruiter') ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('simple','hiring recruiter')) DESC LIMIT 32`,
  related_scan: `SELECT id, full_name, company, school, title, location FROM contacts WHERE user_id = '${USER}'`,
};

async function main() {
  const db = await getDb();
  // Fresh statistics: the import bench adds and removes 20k rows, which leaves the planner
  // estimating 50× the real row count and picking nested loops it would not pick in production.
  await db.execute(sql`ANALYZE`);
  for (const [name, text] of Object.entries(STATEMENTS)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n=== ${name}`);
    try {
      const started = performance.now();
      const res = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${text}`));
      const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Array<Record<string, string>>;
      for (const r of rows) console.log(Object.values(r)[0]);
      console.log(`(wall ${Math.round(performance.now() - started)} ms)`);
    } catch (err) {
      console.log(`ERROR ${String(err).slice(0, 200)}`);
    }
  }
  await closeDb();
}
main().then(() => process.exit(0)).catch(async (e) => { console.error(e); await closeDb().catch(() => undefined); process.exit(1); });
