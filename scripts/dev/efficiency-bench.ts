/**
 * Before/after numbers for the efficiency pass: for each hot read path, how many SQL
 * statements it issues, how deep the chain of dependent round trips is, how many bytes
 * it returns, and how much local CPU time it takes.
 *
 *   ORBIT_PGLITE_DIR=/tmp/orbit-bench npx tsx scripts/dev/efficiency-bench.ts seed
 *   ORBIT_PGLITE_DIR=/tmp/orbit-bench npx tsx scripts/dev/efficiency-bench.ts [--json out.json]
 *
 * Why these metrics: on neon-http every statement is its own HTTPS round trip, so
 * production latency is roughly (sequential depth × round-trip time) and database load is
 * roughly (statements × rows touched). Local PGlite answers in microseconds, so wall time
 * alone hides both. `depth` is measured, not inferred: the path runs again with
 * ORBIT_SIM_DB_LATENCY_MS applied to every statement, and its wall time is divided by
 * that latency. Seed once, without latency, into a PGlite directory of its own.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../src/db";
import { contacts, interactions, userSettings } from "../../src/db/schema";
import { ensureUserSettings } from "../../src/lib/user-settings";
import { recalibrateCloseness } from "../../src/lib/closeness-cohort";
import { seedDemoWorkspace } from "../../src/lib/demo-data/seed";
import { capturedQueries, startQueryCount, stopQueryCount } from "../../src/lib/query-counter";
import { scaleContactRows } from "../lib/scale-fixture";
import { BENCH_USER, type BenchOp } from "./efficiency-bench-shared";

const SCALE_N = 3000;
const TYPES = ["email", "meeting", "note", "linkedin_message", "call"];

/**
 * One account holding both fixtures: the demo workspace (25 richly-connected people with
 * timelines, reminders, briefs) and a 3,000-contact network with ~9k interactions, so every
 * path is measured at a realistic size and still has real content to find.
 */
async function seed() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${BENCH_USER}`);
  await db.delete(interactions).where(eq(interactions.userId, BENCH_USER));
  await db.delete(contacts).where(eq(contacts.userId, BENCH_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, BENCH_USER));
  await seedDemoWorkspace(BENCH_USER);

  await ensureUserSettings(BENCH_USER);
  const rows = scaleContactRows(BENCH_USER, SCALE_N, {
    inlineAvatarShare: 0.3,
    longNotesShare: 0.5,
    dueFollowUpRows: [Math.floor(SCALE_N * 0.9)],
  });
  const ids: string[] = [];
  for (let start = 0; start < rows.length; start += 250) {
    const inserted = await db
      .insert(contacts)
      .values(rows.slice(start, start + 250))
      .returning();
    ids.push(...inserted.map((r) => r.id));
  }
  const touches = ids.flatMap((contactId, i) =>
    Array.from({ length: i % 7 }, (_, k) => ({
      userId: BENCH_USER,
      contactId,
      interactionType: TYPES[(i + k) % TYPES.length],
      interactionDate: new Date(Date.now() - ((i * 13 + k * 29) % 400) * 86_400_000),
      summary: `Touch ${k} with contact ${i}`,
      externalId: `bench-${i}-${k}`,
    }))
  );
  for (let start = 0; start < touches.length; start += 500) {
    await db.insert(interactions).values(touches.slice(start, start + 500));
  }
  await recalibrateCloseness(BENCH_USER);
  console.log(`seeded demo workspace + ${SCALE_N} contacts / ${touches.length} interactions`);
}

const plainBytes = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x))
    ?.length ?? 0;

async function time(fn: () => Promise<unknown>) {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * One pass over every op. The simulated latency is fixed when the database opens, so a
 * pass either has it or does not; `main` runs one of each in a child process and merges.
 */
async function measure(ops: BenchOp[]) {
  const latency = Number(process.env.ORBIT_SIM_DB_LATENCY_MS) || 0;
  const results: Record<string, Record<string, number>> = {};
  const db = await getDb();
  // Every op is called ~10 times a pass; without this the MCP and extension routes would
  // start answering 429 partway through and the numbers would describe the rate limiter.
  const resetBuckets = async () => {
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    await db.execute(sql`DELETE FROM extension_usage`);
  };
  for (const op of ops) {
    await resetBuckets();
    await op.run(); // warm modules, caches and the driver
    if (latency) {
      const lat: number[] = [];
      for (let i = 0; i < 3; i++) lat.push((await time(op.run)).ms);
      results[op.name] = {
        depth: Math.round((median(lat) / latency) * 10) / 10,
        sim_ms: Math.round(median(lat)),
      };
      continue;
    }
    startQueryCount();
    const first = await time(op.run);
    const statements = stopQueryCount();
    if (process.env.BENCH_SQL) console.log(`\n--- ${op.name}\n${capturedQueries().join("\n")}`);
    const cpu: number[] = [];
    for (let i = 0; i < 7; i++) cpu.push((await time(op.run)).ms);
    results[op.name] = {
      statements,
      kb: Math.round((plainBytes(first.value) / 1024) * 10) / 10,
      cpu_ms: Math.round(median(cpu) * 10) / 10,
    };
  }
  return results;
}

const LATENCY_MS = 25;

async function main() {
  const mode = process.argv[2];
  if (mode === "seed") return seed();
  const outIdx = process.argv.indexOf("--json");
  const out = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
  const { writeFileSync, readFileSync, mkdtempSync } = await import("node:fs");

  if (mode === "--child") {
    // Loaded here so `seed` does not pay for the whole app graph.
    const { benchOps } = await import("./efficiency-bench-ops");
    writeFileSync(out!, JSON.stringify(await measure(await benchOps())));
    return;
  }

  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "orbit-bench-out-"));
  const pass = (name: string, latency: number) => {
    const file = join(dir, `${name}.json`);
    const res = spawnSync("npx", ["tsx", __filename, "--child", "--json", file], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ORBIT_SIM_DB_LATENCY_MS: latency ? String(latency) : "" },
    });
    if (res.status !== 0) throw new Error(`${name} pass failed`);
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, number>>;
  };
  const plain = pass("plain", 0);
  const slow = pass("latency", LATENCY_MS);
  const rows = Object.keys(plain).map((op) => ({ op, ...plain[op], ...slow[op] }));
  console.log(`depth = wall time at ${LATENCY_MS} ms/statement ÷ ${LATENCY_MS}`);
  console.table(rows);
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
