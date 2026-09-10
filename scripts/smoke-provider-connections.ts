/**
 * The sync claim's safety properties, which are all consequences of it being ONE statement.
 *
 * `neon-http` has no transactions, so the scheduler's exclusivity rests entirely on a single
 * `UPDATE ... WHERE id IN (SELECT ... LIMIT n) RETURNING ...` taking its row locks atomically.
 * The things that can quietly break that — a second run claiming the same row, an abandoned
 * lease latching `syncing` forever, a dead grant staying armed and being retried every run —
 * are exactly what this pins.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  MAX_SYNC_FAILURES,
  SYNC_LEASE_MS,
  backoffMs,
  claimDueConnections,
  disarmSync,
  loadCoverageSources,
  markSyncResult,
} from "../src/lib/provider-connections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Raw SQL bypasses Drizzle's column mapping, so timestamps arrive as whatever the driver
 * hands back — a `Date` on one, an ISO string on the other. Typed honestly here and
 * normalized through `asDate` rather than annotated as `Date` and hoped for.
 */
type Row = {
  id: string;
  sync_status: string | null;
  next_sync_at: string | Date | null;
  sync_failures: number;
  sync_error: string | null;
};

function asDate(value: string | Date | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

async function seed(userId: string, armedAt: Date | null): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, status, next_sync_at)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${armedAt})
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function readRow(id: string): Promise<Row> {
  const db = await getDb();
  return rowsOf<Row>(
    await db.execute(sql`
      SELECT id, sync_status, next_sync_at, sync_failures, sync_error
      FROM gmail_connections WHERE id = ${id}
    `)
  )[0];
}

run(async () => {
  const db = await getDb();
  const past = new Date(Date.now() - 60_000);

  // --- A due connection is claimed exactly once ------------------------------------------
  const dueId = await seed("claim-user", past);
  const first = await claimDueConnections("google", 10);
  check(
    "a due connection is claimed",
    first.some((c) => c.id === dueId),
    `claimed ${first.length}`
  );
  const second = await claimDueConnections("google", 10);
  check(
    "a second run does not re-claim the row it still holds",
    !second.some((c) => c.id === dueId)
  );
  check("the claim marks the row syncing", (await readRow(dueId)).sync_status === "syncing");

  // --- An unarmed connection is never claimed --------------------------------------------
  const unarmedId = await seed("unarmed-user", null);
  const unarmedClaim = await claimDueConnections("google", 10);
  check(
    "next_sync_at IS NULL means never claimed",
    !unarmedClaim.some((c) => c.id === unarmedId)
  );

  // --- An abandoned lease becomes reclaimable, a fresh one does not -----------------------
  await db.execute(sql`
    UPDATE gmail_connections
       SET sync_started_at = ${new Date(Date.now() - SYNC_LEASE_MS - 60_000)}
     WHERE id = ${dueId}
  `);
  const reclaimed = await claimDueConnections("google", 10);
  check(
    "an expired lease is reclaimed rather than latching forever",
    reclaimed.some((c) => c.id === dueId)
  );

  // --- Success clears state and stores the cursor -----------------------------------------
  const nextAt = new Date(Date.now() + 15 * 60_000);
  await markSyncResult("google", dueId, {
    ok: true,
    cursor: { calendar: { syncToken: "tok-1" } },
    nextSyncAt: nextAt,
  });
  const afterOk = await readRow(dueId);
  check("success returns the row to idle", afterOk.sync_status === "idle");
  check("success zeroes the failure counter", Number(afterOk.sync_failures) === 0);
  check("success re-arms the connection", afterOk.next_sync_at !== null);
  const cursorBack = rowsOf<{ tok: string | null }>(
    await db.execute(sql`
      SELECT sync_cursor->'calendar'->>'syncToken' AS tok FROM gmail_connections WHERE id = ${dueId}
    `)
  )[0];
  check("the cursor round-trips", cursorBack.tok === "tok-1", String(cursorBack.tok));

  // --- A retryable failure backs off but stays armed ---------------------------------------
  await markSyncResult("google", dueId, { ok: false, error: "boom", retryable: true });
  const afterFail = await readRow(dueId);
  check("a retryable failure increments the counter", Number(afterFail.sync_failures) === 1);
  check("a retryable failure stays armed", afterFail.next_sync_at !== null);
  check(
    "a retryable failure backs off into the future",
    (asDate(afterFail.next_sync_at) as Date).getTime() > Date.now()
  );

  // --- A non-retryable failure disarms immediately ------------------------------------------
  const deadId = await seed("dead-user", past);
  await claimDueConnections("google", 10);
  await markSyncResult("google", deadId, {
    ok: false,
    error: "scope revoked",
    retryable: false,
  });
  const afterDead = await readRow(deadId);
  check("a non-retryable failure disarms", afterDead.next_sync_at === null);
  check(
    "a disarmed connection is not claimed again",
    !(await claimDueConnections("google", 10)).some((c) => c.id === deadId)
  );

  // --- Repeated retryable failures eventually give up ----------------------------------------
  const wedgedId = await seed("wedged-user", past);
  await db.execute(sql`
    UPDATE gmail_connections SET sync_failures = ${MAX_SYNC_FAILURES - 1} WHERE id = ${wedgedId}
  `);
  await markSyncResult("google", wedgedId, { ok: false, error: "still broken", retryable: true });
  const afterGiveUp = await readRow(wedgedId);
  check(
    `giving up at ${MAX_SYNC_FAILURES} failures disarms rather than retrying forever`,
    afterGiveUp.next_sync_at === null,
    `failures=${afterGiveUp.sync_failures}`
  );

  // --- disarmSync leaves consent alone -------------------------------------------------------
  const consentId = await seed("consent-user", past);
  await disarmSync("google", consentId, "transport error");
  const consentRow = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM gmail_connections WHERE id = ${consentId}`)
  )[0];
  check(
    "disarming a connection never touches its consent status",
    consentRow.status === "active",
    consentRow.status
  );

  // --- Backoff is bounded and jittered --------------------------------------------------------
  const day = 24 * 60 * 60 * 1000;
  check("backoff never exceeds a day", backoffMs(99) <= day * 1.2 && backoffMs(99) >= day * 0.8);
  check("backoff grows with failures", backoffMs(1) < backoffMs(4));
  const samples = new Set(Array.from({ length: 8 }, () => backoffMs(3)));
  check("backoff is jittered, not a fixed ladder", samples.size > 1);

  // --- Coverage requires an actual sync, not merely a row --------------------------------------
  const covId = await seed("coverage-user", null);
  const noSync = await loadCoverageSources("coverage-user");
  check("a connected mailbox counts as mail coverage", noSync.mailConnected);
  check(
    "a calendar scope that has never synced does not count as coverage",
    !noSync.calendarConnected
  );
  await db.execute(sql`
    UPDATE gmail_connections
       SET scopes = 'https://www.googleapis.com/auth/calendar.readonly', last_synced_at = now()
     WHERE id = ${covId}
  `);
  const synced = await loadCoverageSources("coverage-user");
  check("a synced calendar scope does count as coverage", synced.calendarConnected);
  const stranger = await loadCoverageSources("nobody-at-all");
  check("an unconnected user has no coverage", !stranger.mailConnected && !stranger.calendarConnected);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll provider-connection checks passed.");
});
