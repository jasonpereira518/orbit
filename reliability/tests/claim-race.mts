// Does the sync scheduler's claim ever hand the same connection to two concurrent runs?
// Calls the real claimDueConnections (src/lib/provider-connections.ts) N times at once
// against real Postgres, over many rounds. Fake rows only (user_id 'rel-claim-*').
//
//   npx tsx reliability/lib/with-shim.mts reliability/tests/claim-race.mts
import { sql } from "drizzle-orm";
import fs from "node:fs";
import { getDb } from "../../src/db";
import { claimDueConnections } from "../../src/lib/provider-connections";

const ROWS = 40;
const CONCURRENT = 6;
const LIMIT = 20;
const ROUNDS = Number(process.env.ROUNDS ?? 150);

const db = await getDb();
await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'rel-claim-%'`);
await db.execute(sql`
  INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, status, next_sync_at)
  SELECT 'rel-claim-' || g, 'claim' || g || '@example.com', 'fake', 'active', now() - interval '1 hour'
  FROM generate_series(1, ${ROWS}) g`);

let roundsWithDoubleClaim = 0;
let doubleClaimedRows = 0;
let totalClaimed = 0;
for (let round = 0; round < ROUNDS; round++) {
  await db.execute(sql`
    UPDATE gmail_connections SET sync_status = NULL, sync_started_at = NULL, next_sync_at = now() - interval '1 hour'
    WHERE user_id LIKE 'rel-claim-%'`);
  const runs = await Promise.all(
    Array.from({ length: CONCURRENT }, () => claimDueConnections("google", LIMIT))
  );
  const seen = new Map<string, number>();
  for (const run of runs) for (const c of run) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  const dupes = [...seen.values()].filter((n) => n > 1).length;
  totalClaimed += runs.reduce((n, r) => n + r.length, 0);
  if (dupes) {
    roundsWithDoubleClaim++;
    doubleClaimedRows += dupes;
  }
}

await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'rel-claim-%'`);
const result = { ROWS, CONCURRENT, LIMIT, ROUNDS, totalClaimed, roundsWithDoubleClaim, doubleClaimedRows };
console.log(result);
fs.writeFileSync("reliability/results/claim-race.json", JSON.stringify(result, null, 2));
process.exit(0);
