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
import { decryptOrNull } from "../src/lib/crypto";

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

  console.log("\nupsert coalesce semantics (reconnect keeps unresupplied fields)");
  const COALESCE_CONNECTOR = "asana";
  const first = await upsertConnectorConnection({
    userId: USER,
    connectorId: COALESCE_CONNECTOR,
    authKind: "oauth2",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    label: "Acme Workspace",
    scopes: "tasks:read",
  });

  // A reconnect / token refresh that supplies only a new access token — the shape
  // Task 6's `refreshAccessToken` produces when the provider does not re-issue a
  // refresh token.
  const reup = await upsertConnectorConnection({
    userId: USER,
    connectorId: COALESCE_CONNECTOR,
    authKind: "oauth2",
    accessToken: "access-2",
  });
  check("coalesce: reupsert updates the same row", reup.id === first.id);

  const [row1] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, first.id));
  check("coalesce: label survives when not resupplied", row1?.label === "Acme Workspace");
  check("coalesce: scopes survive when not resupplied", row1?.scopes === "tasks:read");
  check(
    "coalesce: refresh token survives when not resupplied",
    decryptOrNull(row1?.refreshTokenEncrypted ?? null) === "refresh-1"
  );
  check(
    "coalesce: access token is replaced with the new value",
    decryptOrNull(row1?.accessTokenEncrypted ?? null) === "access-2"
  );

  // A reconnect that DOES supply new label/scopes must still replace them.
  await upsertConnectorConnection({
    userId: USER,
    connectorId: COALESCE_CONNECTOR,
    authKind: "oauth2",
    accessToken: "access-3",
    label: "New Workspace",
    scopes: "tasks:write",
  });
  const [row2] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, first.id));
  check("coalesce: label is replaced when resupplied", row2?.label === "New Workspace");
  check("coalesce: scopes are replaced when resupplied", row2?.scopes === "tasks:write");

  console.log("\nauth-kind switch nulls the column that no longer applies");
  await upsertConnectorConnection({
    userId: USER,
    connectorId: COALESCE_CONNECTOR,
    authKind: "api_key",
    accessToken: "api-key-1",
  });
  const [row3] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, first.id));
  check("switching to api_key nulls the old oauth access token", row3?.accessTokenEncrypted === null);
  check(
    "switching to api_key stores the new secret as an api key",
    decryptOrNull(row3?.apiKeyEncrypted ?? null) === "api-key-1"
  );

  await upsertConnectorConnection({
    userId: USER,
    connectorId: COALESCE_CONNECTOR,
    authKind: "oauth2",
    accessToken: "access-4",
  });
  const [row4] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, first.id));
  check("switching back to oauth2 nulls the api key", row4?.apiKeyEncrypted === null);
  check(
    "switching back to oauth2 stores the new secret as an access token",
    decryptOrNull(row4?.accessTokenEncrypted ?? null) === "access-4"
  );

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector claim checks passed.");
});
