/**
 * Keyed job leases (`src/lib/job-lease.ts`, `job_leases`, v113) and the per-user embedding
 * backfill that uses one (`runEmbeddingBackfillExclusive`).
 *
 * Local PGlite. Run: npx tsx scripts/smoke-job-lease.ts
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { acquireJobLease, releaseJobLease } from "../src/lib/job-lease";
import { runEmbeddingBackfillExclusive } from "../src/lib/embedding-backfill";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  const KEY = "smoke:lease";
  await db.execute(sql`DELETE FROM job_leases WHERE key LIKE 'smoke:%' OR key LIKE 'embedding-backfill:smoke-%'`);

  check("a free key can be taken", await acquireJobLease(KEY, "a", 60_000));
  check("a held key cannot", !(await acquireJobLease(KEY, "b", 60_000)));
  const racers = await Promise.all(["c", "d", "e"].map((h) => acquireJobLease("smoke:race", h, 60_000)));
  check("of three racing for a free key, exactly one wins", racers.filter(Boolean).length === 1, JSON.stringify(racers));
  await releaseJobLease(KEY, "b");
  check("only the holder can release", !(await acquireJobLease(KEY, "b", 60_000)));
  await releaseJobLease(KEY, "a");
  check("released, it can be taken again", await acquireJobLease(KEY, "b", 60_000));
  await db.execute(sql`UPDATE job_leases SET until = now() - interval '1 second' WHERE key = ${KEY}`);
  check("an expired holder (a job that died) loses the key", await acquireJobLease(KEY, "c", 60_000));

  const USER = "smoke-lease-user";
  await acquireJobLease(`embedding-backfill:${USER}`, "a-live-chain", 60_000);
  let embedCalls = 0;
  const busy = await runEmbeddingBackfillExclusive(USER, (async () => {
    embedCalls++;
    return [];
  }) as never);
  check("a second embedding chain for the same user does not run", busy === null && embedCalls === 0);
  await releaseJobLease(`embedding-backfill:${USER}`, "a-live-chain");
  const free = await runEmbeddingBackfillExclusive(USER, (async () => []) as never);
  check("once the first lets go, the next one runs", free !== null);
  const left = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE key = ${`embedding-backfill:${USER}`}`))[0]!.n;
  check("and releases its lease when it returns", left === 0, String(left));

  await db.execute(sql`DELETE FROM job_leases WHERE key LIKE 'smoke:%' OR key LIKE 'embedding-backfill:smoke-%'`);
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll job lease checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
