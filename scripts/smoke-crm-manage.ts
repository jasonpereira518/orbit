/**
 * The CRM card's server half: the status it shows, "Sync now", and disconnect. The actions in
 * src/actions/crm.ts are thin shells over these (smoke-leads-page pins that), because a Server
 * Action behind the coming-soon gate cannot be called from a script.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, crmRecords, leads, userSettings } from "../src/db/schema";
import { upsertConnectorConnection } from "../src/lib/connectors/connections";
import { crmStatusFor, disconnectCrm, runCrmSyncNow } from "../src/lib/crm/manage";
import { upsertCrmRecords } from "../src/lib/crm/records";
import { DEMO_CRM_ACCOUNT_REF, type CrmPerson } from "../src/lib/crm/types";
import { UserFacingError } from "../src/lib/errors";
import { RateLimitedError } from "../src/lib/rate-limit";
import { saveLead } from "../src/lib/leads/store";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-manage";

const person = (remoteId: string, lifecycle: CrmPerson["lifecycle"]): CrmPerson => ({
  remoteType: "contact", remoteId, lifecycle, stage: null, displayName: `P ${remoteId}`, email: null, phone: null,
  linkedinUrl: null, companyName: null, companyDomain: null, title: null, remoteOwnerRef: null, remoteUrl: null,
  lastActivityAt: null, remoteCreatedAt: null, remoteUpdatedAt: null, properties: {},
});

async function message(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof UserFacingError ? err.message : `not a UserFacingError: ${String(err)}`;
  }
}

async function reset() {
  const db = await getDb();
  for (const table of [leads, crmRecords, connectorConnections]) await db.delete(table).where(eq(table.userId, USER));
}

run(async () => {
  await reset();
  const db = await getDb();
  await ensureUserSettings(USER);

  console.log("status");
  await db.update(userSettings).set({ compedPlan: null }).where(eq(userSettings.userId, USER));
  const free = await crmStatusFor(USER);
  check("a free account is not entitled", free.entitled === false && free.connection === null && free.counts === null);
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));
  const paid = await crmStatusFor(USER);
  check("a paid account is, and the server is configured", paid.entitled && paid.configured);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", label: "acme.hubspot.com", accountRef: "4242", accessToken: "a", refreshToken: "r", nextSyncAt: null });
  await upsertCrmRecords(USER, "hubspot", [person("1", "customer"), person("2", "lead"), person("3", "other")]);
  const connected = await crmStatusFor(USER);
  check("the connection shows", connected.connection?.label === "acme.hubspot.com" && connected.connection.status === "active" && !connected.connection.demo);
  check("never synced yet", connected.connection?.lastSyncedAgo === null && connected.connection?.syncing === false);
  check("counts: pipeline is every non-customer", connected.counts?.pipeline === 2 && connected.counts.workContacts === 0, JSON.stringify(connected.counts));
  await db.update(connectorConnections).set({ syncStatus: "syncing", syncStartedAt: new Date(), lastSyncedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(connectorConnections.userId, USER));
  const busy = await crmStatusFor(USER);
  check("a live lease reads as syncing", busy.connection?.syncing === true);
  check("with a relative last sync", /minutes? ago/.test(busy.connection?.lastSyncedAgo ?? ""), String(busy.connection?.lastSyncedAgo));
  await db.update(connectorConnections).set({ syncStartedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(connectorConnections.userId, USER));
  check("an expired lease does not", (await crmStatusFor(USER)).connection?.syncing === false);
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\nthe error the card shows never carries raw text");
  await db.update(connectorConnections).set({ syncError: 'duplicate key value violates unique constraint "x"' }).where(eq(connectorConnections.userId, USER));
  const rawError = (await crmStatusFor(USER)).connection?.error;
  check("a database error reads as the generic line", rawError === "The last sync hit a problem — the next automatic sync will try again", String(rawError));
  const rateLimited = "HubSpot is rate-limiting this account — the next sync picks up where this one stopped";
  await db.update(connectorConnections).set({ syncError: rateLimited }).where(eq(connectorConnections.userId, USER));
  const ownError = (await crmStatusFor(USER)).connection?.error;
  check("Orbit’s own HubSpot message passes through", ownError === rateLimited, String(ownError));
  await db.update(connectorConnections).set({ syncError: null }).where(eq(connectorConnections.userId, USER));
  check("no error is no line", (await crmStatusFor(USER)).connection?.error === null);

  console.log("\na connection a stop disarmed reads as paused");
  check("an unarmed connection with no error is not paused", (await crmStatusFor(USER)).connection?.paused === false);
  await db.update(connectorConnections).set({ nextSyncAt: null, syncError: rateLimited }).where(eq(connectorConnections.userId, USER));
  check("disarmed with an error: paused", (await crmStatusFor(USER)).connection?.paused === true);
  await db.update(connectorConnections).set({ nextSyncAt: new Date() }).where(eq(connectorConnections.userId, USER));
  check("armed again (a retry is coming): not paused", (await crmStatusFor(USER)).connection?.paused === false);
  await db.update(connectorConnections).set({ nextSyncAt: null, status: "needs_reauth" }).where(eq(connectorConnections.userId, USER));
  check("needs reauth is its own state, not paused", (await crmStatusFor(USER)).connection?.paused === false);
  await db.update(connectorConnections).set({ status: "active", syncError: null }).where(eq(connectorConnections.userId, USER));

  console.log("\nsync now");
  const calls: string[] = [];
  const okSync = async (conn: { id: string; accessToken: string | null }, opts: { budgetMs: number }) => {
    calls.push(`${conn.accessToken}:${opts.budgetMs}`);
    return { outcome: "complete" as const, pages: 2, records: 3, contactsCreated: 1, leadsCreated: 2, blocked: 0 };
  };
  const result = await runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} });
  check("runs the sync with the claimed connection and a 30 s budget (inside the 60 s function limit)", calls[0] === "a:30000", calls.join(","));
  check("reports what it did", result.outcome === "complete" && result.pages === 2 && result.records === 3 && result.message === null);
  check("and releases the lease", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER)))[0]?.syncStatus === "idle");

  const limited = await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => { throw new RateLimitedError("providerSync", 600); } }));
  check("rate limited, in words", limited === "You’ve synced a few times this hour — the automatic sync keeps running", String(limited));

  await db.update(connectorConnections).set({ syncStatus: "syncing", syncStartedAt: new Date() }).where(eq(connectorConnections.userId, USER));
  check("a sync already running is said so", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "A sync is already running — give it a minute");
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  const broken = async () => {
    throw new Error("socket hang up");
  };
  const failed = await message(runCrmSyncNow(USER, "hubspot", { sync: broken, consume: async () => {} }));
  check("a provider failure is said plainly", failed === "HubSpot didn’t answer — the next automatic sync will try again", String(failed));
  const [afterFail] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check(
    "and recorded as retryable, in words — the raw error goes to the report, not the row",
    afterFail?.syncStatus === "error" && afterFail?.nextSyncAt !== null && afterFail?.syncError === "HubSpot didn’t answer — the next automatic sync will try again",
    String(afterFail?.syncError)
  );

  const stopped = await runCrmSyncNow(USER, "hubspot", { sync: async () => ({ outcome: "stopped", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0, message: "HubSpot says no" }), consume: async () => {} });
  check("a stop comes back with its reason", stopped.outcome === "stopped" && stopped.message === "HubSpot says no");

  await db.update(connectorConnections).set({ status: "needs_reauth" }).where(eq(connectorConnections.userId, USER));
  check("needs reauth is said before trying", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "HubSpot needs you to reconnect — use Reconnect, then sync");
  await db.update(connectorConnections).set({ status: "active", accountRef: DEMO_CRM_ACCOUNT_REF }).where(eq(connectorConnections.userId, USER));
  check("the demo connection never syncs", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "The demo’s HubSpot data is sample data — there’s nothing to sync");
  check("…and says it is the demo", (await crmStatusFor(USER)).connection?.demo === true);
  await db.update(connectorConnections).set({ accountRef: "4242" }).where(eq(connectorConnections.userId, USER));

  console.log("\ndisconnect");
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  const { lead } = await saveLead(USER, { source: "manual", displayName: "Tied Lead" });
  await db.update(leads).set({ crmRecordId: records[1]!.id }).where(eq(leads.id, lead.id));

  await db.update(connectorConnections).set({ syncStatus: "syncing", syncStartedAt: new Date() }).where(eq(connectorConnections.userId, USER));
  const refusedRevokes: string[] = [];
  check("a disconnect while a sync holds the lease is refused in words", (await message(disconnectCrm(USER, "hubspot", { revoke: async (t) => { refusedRevokes.push(t); return true; } }))) === "HubSpot is syncing right now — disconnect again in a minute");
  check("nothing was revoked", refusedRevokes.length === 0);
  check("the connection still exists", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 1);
  check("so do its records", (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === records.length);
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  const revoked: string[] = [];
  await disconnectCrm(USER, "hubspot", { revoke: async (t) => { revoked.push(t); return true; } });
  check("the refresh token was revoked", revoked.join(",") === "r");
  check("the connection is gone", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 0);
  check("so are its records", (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 0);
  const [keptLead] = await db.select().from(leads).where(eq(leads.id, lead.id));
  check("a CRM-tied lead stays, untied", keptLead !== undefined && keptLead.crmRecordId === null);
  check("disconnecting nothing is fine", (await message(disconnectCrm(USER, "hubspot", { revoke: async () => true }))) === null);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", accountRef: "4242", accessToken: "a2", refreshToken: "r2", nextSyncAt: null });
  const rejectedRevokes: string[] = [];
  const rejected = await message(disconnectCrm(USER, "hubspot", { revoke: async (t) => { rejectedRevokes.push(t); return false; } }));
  check("a revoke HubSpot refuses is tried, and the disconnect still completes", rejected === null && rejectedRevokes.join(",") === "r2", String(rejected));
  check("…the connection is gone", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 0);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", accountRef: DEMO_CRM_ACCOUNT_REF, nextSyncAt: null });
  const demoRevokes: string[] = [];
  await disconnectCrm(USER, "hubspot", { revoke: async (t) => { demoRevokes.push(t); return true; } });
  check("the demo connection is never revoked at HubSpot", demoRevokes.length === 0);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", accountRef: "4242", nextSyncAt: null });
  await db.update(connectorConnections).set({ status: "needs_reauth", syncStatus: "syncing", syncStartedAt: new Date() }).where(eq(connectorConnections.userId, USER));
  await disconnectCrm(USER, "hubspot", { revoke: async () => true });
  check("a needs_reauth connection with a stale syncing flag disconnects anyway", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 0);

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM manage checks passed.");
});
