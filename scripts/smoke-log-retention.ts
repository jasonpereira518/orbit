/**
 * Retention for the append-only logs nothing used to prune (webhook_deliveries, cron_runs,
 * outbound_webhook_deliveries): old finished rows go; recent rows, and rows something is
 * still waiting on, stay.
 *
 * Run: npx tsx scripts/smoke-log-retention.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { LOG_RETENTION, pruneLogTables } from "../src/lib/event-prune";

const DAY = 86_400_000;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const count = async (table: string, where: string) =>
    Number(rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(where)}`))[0]?.n ?? 0);

  console.log("the retention table names real columns");
  for (const t of LOG_RETENTION) {
    const cols = rowsOf<{ column_name: string }>(await db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${t.table}`)).map((r) => r.column_name);
    check(`${t.table} has id and ${t.column}`, cols.includes("id") && cols.includes(t.column));
  }

  console.log("\nwebhook_deliveries");
  await db.execute(sql`DELETE FROM webhook_deliveries WHERE source = 'smoke-retention'`);
  await db.execute(sql`INSERT INTO webhook_deliveries (source, outcome, created_at) VALUES
    ('smoke-retention', 'ok', ${ago(45)}::timestamptz), ('smoke-retention', 'ok', ${ago(5)}::timestamptz)`);

  console.log("cron_runs");
  await db.execute(sql`DELETE FROM cron_runs WHERE job = 'smoke.retention'`);
  await db.execute(sql`INSERT INTO cron_runs (job, trigger, status, started_at) VALUES
    ('smoke.retention', 'manual', 'ok', ${ago(120)}::timestamptz),
    ('smoke.retention', 'manual', 'running', ${ago(120)}::timestamptz),
    ('smoke.retention', 'manual', 'ok', ${ago(10)}::timestamptz)`);

  const pruned = await pruneLogTables();
  check("it reports what it pruned per table", pruned.webhook_deliveries >= 1 && pruned.cron_runs >= 1, JSON.stringify(pruned));
  check("an old delivery log row is gone, a recent one stays",
    (await count("webhook_deliveries", "source = 'smoke-retention'")) === 1);
  check("an old finished cron run is gone",
    (await count("cron_runs", `job = 'smoke.retention' AND status = 'ok' AND started_at < '${ago(90)}'`)) === 0);
  check("an old run still marked running stays", (await count("cron_runs", "job = 'smoke.retention' AND status = 'running'")) === 1);
  check("a recent cron run stays", (await count("cron_runs", `job = 'smoke.retention' AND started_at > '${ago(30)}'`)) === 1);

  await db.execute(sql`DELETE FROM webhook_deliveries WHERE source = 'smoke-retention'`);
  await db.execute(sql`DELETE FROM cron_runs WHERE job = 'smoke.retention'`);
  console.log(failures === 0 ? "\nAll log-retention checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
});
