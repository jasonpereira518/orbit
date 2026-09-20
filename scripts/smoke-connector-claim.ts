/**
 * The claim/lease/backoff contract for connector connections.
 *
 * The lease is the load-bearing part: without it `sync_status = 'syncing'` latches forever
 * the first time an invocation is killed mid-run, and the connection is never swept again.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import {
  claimDueConnectorConnections,
  disarmConnectorSync,
  markConnectorSyncResult,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { SYNC_LEASE_MS } from "../src/lib/provider-connections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-claim";

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  const now = new Date();
  const conn = await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    accessToken: "token-1",
    refreshToken: "refresh-1",
    scopes: "crm.objects.contacts.read",
    capabilities: ["syncPeople"],
    nextSyncAt: new Date(now.getTime() - 1000),
  });
  check("upsert returns a row", Boolean(conn.id));

  console.log("\nclaiming");
  const claimed = await claimDueConnectorConnections(10, now);
  const mine = claimed.filter((c) => c.userId === USER);
  check("a due connection is claimed", mine.length === 1);
  check("the secret comes back decrypted", mine[0]?.accessToken === "token-1");
  check("capabilities come back", mine[0]?.capabilities.includes("syncPeople") === true);

  const again = await claimDueConnectorConnections(10, now);
  check("a leased connection is not claimed twice", again.every((c) => c.userId !== USER));

  const afterLease = new Date(now.getTime() + SYNC_LEASE_MS + 1000);
  const reclaimed = await claimDueConnectorConnections(10, afterLease);
  check("an expired lease is reclaimable", reclaimed.some((c) => c.userId === USER));

  console.log("\noutcomes");
  const next = new Date(now.getTime() + 60_000);
  await markConnectorSyncResult(conn.id, { ok: true, cursor: { cursor: "abc" }, nextSyncAt: next });
  const [ok] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("success clears the failure count", ok?.syncFailures === 0);
  check("success stores the cursor", ok?.syncCursor?.cursor === "abc");
  check("success re-arms the connection", ok?.nextSyncAt?.getTime() === next.getTime());
  check("success clears the lease", ok?.syncStatus === "idle");

  await markConnectorSyncResult(conn.id, { ok: false, error: "boom", retryable: true });
  const [failed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("a retryable failure counts", failed?.syncFailures === 1);
  check("a retryable failure backs off rather than disarming", failed?.nextSyncAt !== null);
  check("the error is recorded", failed?.syncError === "boom");

  await disarmConnectorSync(conn.id, "needs attention");
  const [disarmed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("disarming unschedules the connection", disarmed?.nextSyncAt === null);

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector claim checks passed.");
});
