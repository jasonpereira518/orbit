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
  claimConnectorConnectionForUser,
  claimDueConnectorConnections,
  disarmConnectorSync,
  listConnectorConnections,
  markConnectorSyncResult,
  saveConnectorCursor,
  updateConnectorTokens,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { MAX_SYNC_FAILURES, SYNC_LEASE_MS } from "../src/lib/provider-connections";
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
    tokenExpiresAt: new Date(now.getTime() + 3_600_000),
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
  check(
    "the token expiry comes back with the claim",
    mine[0]?.tokenExpiresAt?.getTime() === now.getTime() + 3_600_000,
    String(mine[0]?.tokenExpiresAt?.toISOString())
  );

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

  // A non-retryable failure is a CONSENT problem — a revoked grant, a deleted app — and the
  // only way back is the connect flow. Grinding it up the backoff ladder to MAX_SYNC_FAILURES
  // just delays telling the user, for hours, while the connection looks merely slow. Dropping
  // `!outcome.retryable` from the disarm guard in connections.ts passed this whole file before
  // this check existed: with `failures` at 2, well under MAX_SYNC_FAILURES, the mutant simply
  // took the backoff branch and nothing looked.
  await markConnectorSyncResult(conn.id, {
    ok: false,
    error: "the user revoked this grant",
    retryable: false,
  });
  const [refused] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check(
    "a non-retryable failure disarms immediately rather than backing off",
    refused?.nextSyncAt === null,
    String(refused?.nextSyncAt?.toISOString())
  );
  check("it stays well under the failure ceiling", (refused?.syncFailures ?? 0) < MAX_SYNC_FAILURES, String(refused?.syncFailures));
  check("and says why", refused?.syncError === "the user revoked this grant", String(refused?.syncError));

  await disarmConnectorSync(conn.id, "needs attention");
  const [disarmed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("disarming unschedules the connection", disarmed?.nextSyncAt === null);

  console.log("\nan api_key connection's secret comes back from the column it was stored in");
  // The claim reads `access_token_encrypted` for oauth2 and `api_key_encrypted` for everything
  // else, and `upsertConnectorConnection` writes the matching one. Only the oauth2 half was
  // covered: forcing the claim to always read `access_token_encrypted` passed every check in
  // this file, and would have handed EVERY api-key connector a null secret at sync time — a
  // sync that cannot authenticate, reported as some provider error.
  const KEY_CONNECTOR = "luma-like";
  const keyConn = await upsertConnectorConnection({
    userId: USER,
    connectorId: KEY_CONNECTOR,
    authKind: "api_key",
    accessToken: "secret-api-key",
    nextSyncAt: new Date(Date.now() - 1000),
  });
  const claimedKeys = await claimDueConnectorConnections(10, new Date());
  const claimedKey = claimedKeys.find((c) => c.id === keyConn.id);
  check("the api_key connection is claimed", Boolean(claimedKey));
  check(
    "its secret comes back decrypted, not null",
    claimedKey?.accessToken === "secret-api-key",
    String(claimedKey?.accessToken)
  );
  check("and it is reported as an api_key connection", claimedKey?.authKind === "api_key", String(claimedKey?.authKind));

  console.log("\nlistConnectorConnections never returns a secret");
  // Its own contract ("this feeds the settings UI"), and a live risk on this branch: it
  // already needed a commit called "Never reveal connector credentials in the admin console".
  // Widening the projection to `.select()` — the easiest possible edit, and the one that
  // silently returns every `*_encrypted` column — fails this.
  const listed = await listConnectorConnections(USER);
  const keyRow = listed.find((c) => c.connectorId === KEY_CONNECTOR);
  check("the connection is listed at all", Boolean(keyRow), JSON.stringify(listed.map((c) => c.connectorId)));
  const SECRET_FIELDS = [
    "apiKeyEncrypted",
    "accessTokenEncrypted",
    "refreshTokenEncrypted",
    "accessToken",
    "refreshToken",
    "apiKey",
  ];
  const leakedFields = listed.flatMap((row) =>
    SECRET_FIELDS.filter((f) => f in (row as Record<string, unknown>))
  );
  check("no credential field is on the returned shape", leakedFields.length === 0, leakedFields.join(","));
  // Value-level too, not just key-level: a field renamed to something innocuous still leaks.
  const [storedKeyRow] = await db
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.id, keyConn.id));
  const serialized = JSON.stringify(listed);
  check("the plaintext secret is nowhere in the payload", !serialized.includes("secret-api-key"));
  check(
    "and neither is the ciphertext",
    !serialized.includes(storedKeyRow?.apiKeyEncrypted ?? "no-ciphertext-stored"),
    String(storedKeyRow?.apiKeyEncrypted).slice(0, 24)
  );

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
  // The refresh token belongs to the oauth2 grant that produced it. Switching away from
  // oauth2 without resupplying one must drop it, not carry it forward under the new auth
  // kind — before round 2's fix, the coalesce kept the stale "refresh-1" here.
  check("switching to api_key drops the stale oauth refresh token", row3?.refreshTokenEncrypted === null);

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

  console.log("\nclaiming one user's connection on demand (Sync now)");
  const onDemand = await upsertConnectorConnection({
    userId: USER,
    connectorId: "on-demand",
    authKind: "oauth2",
    accessToken: "od-access",
    refreshToken: "od-refresh",
    nextSyncAt: null,
  });
  const firstClaim = await claimConnectorConnectionForUser(USER, "on-demand");
  check("an idle connection is claimed even when it is not armed", firstClaim?.id === onDemand.id);
  const secondClaim = await claimConnectorConnectionForUser(USER, "on-demand");
  check("a leased connection is not claimed twice", secondClaim === null);
  const laterClaim = await claimConnectorConnectionForUser(
    USER,
    "on-demand",
    new Date(Date.now() + SYNC_LEASE_MS + 1000)
  );
  check("an expired lease is claimable again", laterClaim?.id === onDemand.id);
  await db
    .update(connectorConnections)
    .set({ status: "needs_reauth", syncStatus: "idle" })
    .where(eq(connectorConnections.id, onDemand.id));
  check(
    "a connection that needs reauth is never claimed",
    (await claimConnectorConnectionForUser(USER, "on-demand")) === null
  );
  check("nobody else's connection is claimed", (await claimConnectorConnectionForUser("someone-else", "on-demand")) === null);

  console.log("\nstoring a refreshed token");
  const expires = new Date(Date.now() + 1_800_000);
  await updateConnectorTokens(onDemand.id, { accessToken: "od-access-2", refreshToken: null, expiresAt: expires });
  const [refreshed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("the new access token is stored encrypted", decryptOrNull(refreshed?.accessTokenEncrypted ?? null) === "od-access-2");
  check("a refresh that returns no refresh token keeps the old one", decryptOrNull(refreshed?.refreshTokenEncrypted ?? null) === "od-refresh");
  check("the expiry is stored", refreshed?.tokenExpiresAt?.getTime() === expires.getTime());
  await updateConnectorTokens(onDemand.id, { accessToken: "od-access-3", refreshToken: "od-refresh-2", expiresAt: null });
  const [rotated] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("a rotated refresh token replaces the old one", decryptOrNull(rotated?.refreshTokenEncrypted ?? null) === "od-refresh-2");

  console.log("\nsaving progress mid-run");
  await db
    .update(connectorConnections)
    .set({ status: "active", syncStatus: "idle" })
    .where(eq(connectorConnections.id, onDemand.id));
  const midRun = await claimConnectorConnectionForUser(USER, "on-demand");
  await saveConnectorCursor(onDemand.id, { cursor: "200", syncedThrough: "2026-09-01T00:00:00.000Z", meta: { portalId: "42" } });
  const [progressed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("the cursor is stored", progressed?.syncCursor?.cursor === "200" && progressed?.syncCursor?.meta?.portalId === "42", JSON.stringify(progressed?.syncCursor));
  check("the lease is kept", progressed?.syncStatus === "syncing" && midRun !== null, String(progressed?.syncStatus));

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector claim checks passed.");
});
