/**
 * The connector family inside `runSyncPass`.
 *
 * What matters here is the contract, not any one connector:
 *
 *   - a due connection is claimed and handed to its manifest's sync function;
 *   - a clean return leaves the row idle, stamped and re-armed, so it is not due again on the
 *     very next pass — the scheduler's success backstop (`markConnectorSyncSucceeded`);
 *   - a sync that recorded its OWN result keeps it: the backstop is guarded on `syncing`;
 *   - a connector whose sync throws costs exactly one failure and does not take the pass down;
 *   - an unregistered connector_id disarms rather than throwing (a row can outlive the code
 *     that made it).
 *
 * No manifest in the registry has a `sync` yet — P0 ships the dispatch and none of the
 * connectors it dispatches to — so every branch but the last one is reached through the
 * `resolveConnector` dep, which exists for exactly this reason. Registering a stub here rather
 * than in the shipped registry keeps the catalog honest: it describes what Orbit offers, not
 * what a test needs.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import {
  markConnectorSyncResult,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import type { ConnectorManifest } from "../src/lib/connectors/registry";
import { connectorById } from "../src/lib/connectors/registry";
import { runSyncPass } from "../src/lib/sync-scheduler";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-pass";

/** A registered connector that does not exist in the catalog, built from a real entry's shape. */
function stubManifest(id: string, sync: (connectionId: string) => Promise<void>): ConnectorManifest {
  return {
    id,
    label: id,
    family: "crm",
    auth: "api_key",
    availability: "available",
    entitlement: "sync",
    rateBucket: null,
    purgeCategory: "connections",
    capabilities: [{ id: "syncPeople", label: "Stub", direction: "read", scopes: [] }],
    sync,
  };
}

/**
 * Resolve the stubs first and fall through to the real registry for everything else, so a
 * connection some other smoke script left behind still behaves exactly as it does in
 * production rather than being handed a stub.
 */
function resolverFor(stubs: ConnectorManifest[]) {
  return (id: string): ConnectorManifest | null =>
    stubs.find((m) => m.id === id) ?? connectorById(id);
}

async function arm(connectorId: string) {
  return upsertConnectorConnection({
    userId: USER,
    connectorId,
    authKind: "api_key",
    accessToken: "k",
    nextSyncAt: new Date(Date.now() - 1000),
  });
}

async function rowFor(id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.id, id));
  return row;
}

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  console.log("a due connection is claimed and handed to its manifest's sync");
  const okConn = await arm("stub-ok");
  const handed: string[] = [];
  const okStats = await runSyncPass({
    now: new Date(),
    deps: {
      // The Google/Outlook halves of the pass are not under test here and must not reach the
      // network; no `google` connection exists for this user, so these are never called.
      getAccessToken: async () => {
        throw new Error("not used");
      },
      fetchPage: async () => {
        throw new Error("not used");
      },
      resolveConnector: resolverFor([
        stubManifest("stub-ok", async (connectionId) => {
          handed.push(connectionId);
        }),
      ]),
    },
  });
  check("the connection was claimed", okStats.connectorClaimed >= 1, JSON.stringify(okStats.connectorClaimed));
  check("its sync was actually called, with its connection id", handed[0] === okConn.id, JSON.stringify(handed));
  // Nothing in this repo asserted `connectorSynced` at all before this line — a dispatch that
  // never counted a success would have looked identical to one that never ran.
  check("a successful sync is counted", okStats.connectorSynced === 1, String(okStats.connectorSynced));
  check("and costs no failure", okStats.connectorFailed === 0, String(okStats.connectorFailed));

  console.log("\nand the pass records that success, rather than leaving the row leased");
  // The contract settled on `ConnectorManifest.sync`. Without the backstop the row stayed
  // `sync_status = 'syncing'` with `next_sync_at` unchanged and `last_synced_at` NULL: due
  // again on the very next pass, forever, while the settings UI said "never synced".
  const okRow = await rowFor(okConn.id);
  check("the lease is released", okRow?.syncStatus === "idle", String(okRow?.syncStatus));
  check("the run is stamped", okRow?.lastSyncedAt !== null, String(okRow?.lastSyncedAt));
  check("no error is left behind", okRow?.syncError === null, String(okRow?.syncError));
  check(
    "it is re-armed into the future, not due again immediately",
    (okRow?.nextSyncAt?.getTime() ?? 0) > Date.now() + 60_000,
    String(okRow?.nextSyncAt?.toISOString())
  );

  console.log("\na sync that records its own result keeps it (the backstop is claim-guarded)");
  // The other half of the same contract: a real connector with a cursor calls
  // `markConnectorSyncResult` itself. The backstop must not reopen that decision — and in
  // particular must not overwrite the cursor it just stored with the stale one the claim read.
  const ownConn = await arm("stub-owns-result");
  const ownCadence = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await runSyncPass({
    now: new Date(),
    deps: {
      getAccessToken: async () => {
        throw new Error("not used");
      },
      fetchPage: async () => {
        throw new Error("not used");
      },
      resolveConnector: resolverFor([
        stubManifest("stub-owns-result", async (connectionId) => {
          await markConnectorSyncResult(connectionId, {
            ok: true,
            cursor: { cursor: "page-2" },
            nextSyncAt: ownCadence,
          });
        }),
      ]),
    },
  });
  const ownRow = await rowFor(ownConn.id);
  check("the sync's own cursor survives the backstop", ownRow?.syncCursor?.cursor === "page-2", JSON.stringify(ownRow?.syncCursor));
  check(
    "the sync's own cadence survives too",
    ownRow?.nextSyncAt?.getTime() === ownCadence.getTime(),
    String(ownRow?.nextSyncAt?.toISOString())
  );

  console.log("\na connector whose sync throws costs exactly one failure");
  const badConn = await arm("stub-throws");
  const badStats = await runSyncPass({
    now: new Date(),
    deps: {
      getAccessToken: async () => {
        throw new Error("not used");
      },
      fetchPage: async () => {
        throw new Error("not used");
      },
      resolveConnector: resolverFor([
        stubManifest("stub-throws", async () => {
          throw new Error("provider exploded");
        }),
      ]),
    },
  });
  check("the failure is counted once", badStats.connectorFailed === 1, String(badStats.connectorFailed));
  check("it is not also counted as a sync", badStats.connectorSynced === 0, String(badStats.connectorSynced));
  const badRow = await rowFor(badConn.id);
  check("the failure is recorded on the row", badRow?.syncFailures === 1, String(badRow?.syncFailures));
  check("with the provider's message", (badRow?.syncError ?? "").includes("provider exploded"), String(badRow?.syncError));
  check("a retryable failure stays armed, on a backoff", badRow?.nextSyncAt !== null);
  check("and the lease is released", badRow?.syncStatus === "error", String(badRow?.syncStatus));

  console.log("\none connector's failure does not stop the next one's sync");
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  const firstConn = await arm("stub-throws");
  const secondConn = await arm("stub-ok");
  const bothHanded: string[] = [];
  const bothStats = await runSyncPass({
    now: new Date(),
    deps: {
      getAccessToken: async () => {
        throw new Error("not used");
      },
      fetchPage: async () => {
        throw new Error("not used");
      },
      resolveConnector: resolverFor([
        stubManifest("stub-throws", async () => {
          throw new Error("provider exploded");
        }),
        stubManifest("stub-ok", async (connectionId) => {
          bothHanded.push(connectionId);
        }),
      ]),
    },
  });
  check("both were claimed", bothStats.connectorClaimed >= 2, String(bothStats.connectorClaimed));
  check("one synced, one failed", bothStats.connectorSynced === 1 && bothStats.connectorFailed === 1, JSON.stringify(bothStats));
  check("the healthy connector still ran", bothHanded.includes(secondConn.id), JSON.stringify(bothHanded));
  check("the failing one is still armed for a retry", (await rowFor(firstConn.id))?.nextSyncAt !== null);

  console.log("\nan unregistered connector is disarmed, not thrown on");
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  const orphan = await arm("connector-that-no-longer-exists");
  const stats = await runSyncPass({ now: new Date() });
  check("the pass returned stats", typeof stats.connectorClaimed === "number");
  check("the orphan was claimed", stats.connectorClaimed >= 1);

  const row = await rowFor(orphan.id);
  check("the orphan is unscheduled", row?.nextSyncAt === null);
  check("the orphan records why", (row?.syncError ?? "").length > 0);
  check("the orphan did not fail the pass", stats.connectorFailed === 0);
  check("and was not counted as a sync either", stats.connectorSynced === 0, String(stats.connectorSynced));

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector sync-pass checks passed.");
});
