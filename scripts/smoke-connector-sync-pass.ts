/**
 * The connector family inside `runSyncPass`.
 *
 * What matters here is the contract, not any one connector: a due connection is claimed and
 * handed to its manifest's sync function, an unregistered connector_id disarms rather than
 * throwing (a row can outlive the code that made it), and a connector whose sync throws
 * costs one failure without taking the pass down.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import { upsertConnectorConnection } from "../src/lib/connectors/connections";
import { runSyncPass } from "../src/lib/sync-scheduler";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-pass";

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  console.log("an unregistered connector is disarmed, not thrown on");
  const orphan = await upsertConnectorConnection({
    userId: USER,
    connectorId: "connector-that-no-longer-exists",
    authKind: "api_key",
    accessToken: "k",
    nextSyncAt: new Date(Date.now() - 1000),
  });
  const stats = await runSyncPass({ now: new Date() });
  check("the pass returned stats", typeof stats.connectorClaimed === "number");
  check("the orphan was claimed", stats.connectorClaimed >= 1);

  const [row] = await db
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.id, orphan.id));
  check("the orphan is unscheduled", row?.nextSyncAt === null);
  check("the orphan records why", (row?.syncError ?? "").length > 0);
  check("the orphan did not fail the pass", stats.connectorFailed === 0);

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector sync-pass checks passed.");
});
