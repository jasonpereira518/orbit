/**
 * recalibrateCloseness cost, and what a read costs when 1 or 20 contacts are unscored.
 *
 *   ORBIT_PGLITE_DIR=<seeded copy> npx tsx scripts/dev/perf/cohort-bench.ts
 */
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
const U = "demo-user";
(async () => {
  const { sql } = await import("drizzle-orm");
  const { getDb } = await import("../../../src/db");
  const { recalibrateCloseness } = await import("../../../src/lib/closeness-cohort");
  const { getDashboardData } = await import("../../../src/lib/reminders");
  const { startQueryCount, stopQueryCount } = await import("../../../src/lib/query-counter");
  const db = await getDb();
  const out: Record<string, number> = {};
  let t = performance.now();
  startQueryCount();
  await recalibrateCloseness(U);
  out.recalibrate_ms = Math.round(performance.now() - t);
  out.recalibrate_statements = stopQueryCount();

  await getDashboardData(U); // warm
  t = performance.now();
  await getDashboardData(U);
  out.dashboard_all_scored_ms = Math.round(performance.now() - t);

  await db.execute(sql`UPDATE contacts SET closeness_computed_at = NULL WHERE id = (SELECT id FROM contacts WHERE user_id = ${U} ORDER BY created_at DESC LIMIT 1)`);
  startQueryCount();
  t = performance.now();
  await getDashboardData(U);
  out.dashboard_one_unscored_ms = Math.round(performance.now() - t);
  out.dashboard_one_unscored_statements = stopQueryCount();
  await new Promise((r) => setTimeout(r, 15000)); // let any deferred recalibration finish
  await db.execute(sql`UPDATE contacts SET closeness_computed_at = NULL WHERE id IN (SELECT id FROM contacts WHERE user_id = ${U} ORDER BY created_at DESC LIMIT 20)`);
  startQueryCount();
  t = performance.now();
  await getDashboardData(U);
  out.dashboard_20_unscored_ms = Math.round(performance.now() - t);
  out.dashboard_20_unscored_statements = stopQueryCount();
  await new Promise((r) => setTimeout(r, 15000));
  const [{ n }] = (await db.execute(sql`select count(*)::int n from contacts where user_id = ${U} and closeness_computed_at is null`) as unknown as { rows: { n: number }[] }).rows;
  out.unscored_left_after_deferred = n;
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
