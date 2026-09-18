/**
 * Connector sync throughput: claimed connections run four at a time, a run claims twenty,
 * one failure never stops the pool, and the run reports how overdue the oldest connection was.
 *
 * Run: npx tsx scripts/smoke-sync-concurrency.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { oldestDueAgeMs } from "../src/lib/provider-connections";
import { CONNECTIONS_PER_RUN, SYNC_CONCURRENCY, runSettledPool, runSyncPass, type SyncDeps } from "../src/lib/sync-scheduler";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

async function seed(userId: string, dueMsAgo = 60_000) {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${CALENDAR_SCOPE},
            ${new Date(Date.now() - dueMsAgo)}, 0)`);
}

/** This script is the scheduler's only tenant: foreign rows are disarmed, never deleted. */
async function clearAll() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'conc-%'`);
  await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'conc-%'`);
}

function slowDeps(failFor = new Set<string>()): { deps: SyncDeps; maxInFlight: () => number } {
  let inFlight = 0;
  let max = 0;
  const deps: SyncDeps = {
    getAccessToken: async (userId: string) => `stub-token:${userId}`,
    fetchPage: async ({ accessToken }) => {
      const userId = String(accessToken).replace(/^stub-token:/, "");
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 150));
      inFlight--;
      if (failFor.has(userId)) throw new Error("Google Calendar 503: upstream unavailable");
      return { events: [], nextSyncToken: "fresh", nextPageToken: null, tombstones: 0, selfEmails: [] };
    },
  };
  return { deps, maxInFlight: () => max };
}

run(async () => {
  console.log("The pool...");
  let seen = 0;
  await runSettledPool([1, 2, 3, 4, 5], 2, async (n) => {
    seen++;
    if (n === 2) throw new Error("boom");
  });
  check("a throwing worker neither rejects the pool nor stops it", seen === 5, String(seen));

  console.log("\nConcurrency, isolation and lag...");
  await clearAll();
  for (let i = 0; i < 8; i++) await seed(`conc-${i}`, i === 0 ? 3 * 3_600_000 : 60_000);
  const { deps, maxInFlight } = slowDeps(new Set(["conc-3"]));
  const lagBefore = await oldestDueAgeMs("google", new Date());
  check("oldestDueAgeMs reads the most overdue armed connection", (lagBefore ?? 0) >= 3 * 3_600_000 - 60_000, String(lagBefore));
  const stats = await runSyncPass({ deps });
  check(`at most ${SYNC_CONCURRENCY} connections sync at once, and more than one does`,
    maxInFlight() === SYNC_CONCURRENCY, String(maxInFlight()));
  check("seven synced, the failing one counted, none dropped",
    stats.claimed === 8 && stats.synced === 7 && stats.failed === 1, JSON.stringify(stats));
  check("the run reports the lag it started with", (stats.oldestDueAgeMs ?? 0) >= 3 * 3_600_000 - 60_000, String(stats.oldestDueAgeMs));
  check("nothing is due once they are synced", (await oldestDueAgeMs("google", new Date())) === null);

  console.log("\nClaim size...");
  await clearAll();
  for (let i = 0; i < CONNECTIONS_PER_RUN + 2; i++) await seed(`conc-claim-${i}`);
  const big = await runSyncPass({ deps: slowDeps().deps });
  check(`a run claims ${CONNECTIONS_PER_RUN}`, CONNECTIONS_PER_RUN === 20 && big.claimed === 20, JSON.stringify(big));
  const db = await getDb();
  const left = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM gmail_connections
     WHERE user_id LIKE 'conc-claim-%' AND next_sync_at <= now() AND sync_status IS DISTINCT FROM 'syncing'`))[0]?.n;
  check("the rest stay due for the next run", left === 2, String(left));

  await clearAll();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync-concurrency checks passed.");
});
