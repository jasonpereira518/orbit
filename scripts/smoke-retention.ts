/**
 * The retention sweep (`src/lib/retention.ts`): every append-only table loses its rows past
 * the window, keeps the recent ones, and never removes more than a batch per run, so a
 * neglected table drains over several runs instead of one long lock.
 *
 * Rows are built generically from information_schema (every NOT NULL column without a
 * default gets a plausible value), so a column added to one of these tables later does not
 * silently turn this into a test of nothing.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-retention.ts
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { RETENTION_BATCH, RETENTION_RULES, pruneRetainedTables } from "../src/lib/retention";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

type Col = { column_name: string; data_type: string; udt_name: string };

async function main() {
  const db = await getDb();
  const DAY = 86_400_000;
  const now = new Date();
  // An endpoint for the outbound deliveries' foreign key.
  const [endpoint] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO webhook_endpoints (user_id, url, secret_encrypted, event_types, status)
    VALUES ('smoke-retention', 'https://example.com/hook', 'x', '[]'::jsonb, 'active') RETURNING id`));

  async function insertRow(table: string, overrides: Record<string, unknown>) {
    const cols = rowsOf<Col>(await db.execute(sql`
      SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_name = ${table} AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER'`));
    const values: Record<string, unknown> = {};
    for (const c of cols) {
      values[c.column_name] =
        c.udt_name === "uuid" ? crypto.randomUUID()
        : c.udt_name.startsWith("int") || c.udt_name === "numeric" || c.udt_name.startsWith("float") ? 0
        : c.udt_name === "bool" ? false
        : c.udt_name.startsWith("timestamp") ? now.toISOString()
        : c.udt_name === "jsonb" || c.udt_name === "json" ? "{}"
        : `smoke-${crypto.randomUUID()}`;
    }
    if (table === "outbound_webhook_deliveries") values.endpoint_id = endpoint!.id;
    Object.assign(values, overrides);
    const names = Object.keys(values);
    await db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names.map((n) => sql.identifier(n)), sql`, `)})
      VALUES (${sql.join(names.map((n) => sql`${values[n] as string}`), sql`, `)})`);
  }

  const count = async (table: string) =>
    rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`))[0]!.n;

  console.log("each table keeps what is recent and loses what is old");
  const before: Record<string, number> = {};
  for (const rule of RETENTION_RULES) {
    before[rule.table] = await count(rule.table);
    const old = new Date(now.getTime() - (rule.olderThanDays + 1) * DAY).toISOString();
    const recent = new Date(now.getTime() - Math.max(0, rule.olderThanDays - 1) * DAY / 2).toISOString();
    const extra = rule.table === "outbound_webhook_deliveries" ? { status: "delivered" } : {};
    await insertRow(rule.table, { [rule.ageColumn]: old, ...extra });
    await insertRow(rule.table, { [rule.ageColumn]: old, ...extra });
    await insertRow(rule.table, { [rule.ageColumn]: recent, ...extra });
  }
  // An old outbound delivery still being retried must survive.
  await insertRow("outbound_webhook_deliveries", { created_at: new Date(now.getTime() - 400 * DAY).toISOString(), status: "pending" });

  const removed = await pruneRetainedTables(now, (t, err) => console.error(t, err));
  for (const rule of RETENTION_RULES) {
    const after = await count(rule.table);
    const expectedRemoved = rule.table === "outbound_webhook_deliveries" ? 2 : 2;
    check(`${rule.table}: the two old rows go, the recent one stays`, removed[rule.table]! >= expectedRemoved && after === before[rule.table]! + 3 + (rule.table === "outbound_webhook_deliveries" ? 1 : 0) - removed[rule.table]!, `removed ${removed[rule.table]}, ${before[rule.table]} → ${after}`);
  }
  const pending = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE status = 'pending'`))[0]!.n;
  check("a delivery still being retried is kept, however old", pending >= 1);

  console.log("a backlog drains a batch at a time");
  const old = new Date(now.getTime() - 400 * DAY).toISOString();
  await db.execute(sql`INSERT INTO rate_limit_buckets (bucket, window_started_at, count)
    SELECT 'smoke-backlog:' || g, ${old}, 1 FROM generate_series(1, ${RETENTION_BATCH + 250}) g`);
  const first = await pruneRetainedTables(now);
  check("one run removes at most a batch", first.rate_limit_buckets === RETENTION_BATCH, String(first.rate_limit_buckets));
  const second = await pruneRetainedTables(now);
  check("and the next run takes the rest", second.rate_limit_buckets === 250, String(second.rate_limit_buckets));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll retention checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
