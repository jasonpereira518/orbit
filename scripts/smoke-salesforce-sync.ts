/**
 * The Salesforce sync end to end against a scripted org: identify by the connect-time cursor
 * seed, page owned Contacts then Leads with keyset resume, fall back to a lean field list on
 * INVALID_FIELD, refresh once on a 401, and stop — without a write, not even the stop itself —
 * once the lease is gone. Every outcome the scheduler and the card depend on is pinned here.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.SALESFORCE_CLIENT_ID = "cid";
process.env.SALESFORCE_CLIENT_SECRET = "csecret";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, contacts, crmRecords, leads, userSettings } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  markConnectorSyncResult,
  resetConnectorCursor,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { OAuthTokenError } from "../src/lib/connectors/oauth";
import { resolveConnectorWithSync } from "../src/lib/connectors/syncs";
import { SYNC_LEASE_MS } from "../src/lib/provider-connections";
import { cursorFromProgress, progressFromCursor, SALESFORCE_PAGE } from "../src/lib/crm/salesforce/mapping";
import { syncSalesforce } from "../src/lib/crm/salesforce/sync";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-salesforce-sync";
const INSTANCE = "https://acme.my.salesforce.com";
const OWNER = "005000000000001AAA";
const ORG = "00D000000000001AAA";

function contactRecord(n: number, stamp: string) {
  return {
    Id: `003000000000${String(n).padStart(3, "0")}AAA`,
    FirstName: "C",
    LastName: `Person ${n}`,
    Email: `c${n}@acme.com`,
    OwnerId: OWNER,
    SystemModstamp: stamp,
    Account: { Name: "Acme" },
  };
}
function leadRecord(n: number, stamp: string, converted = false) {
  return {
    Id: `00Q000000000${String(n).padStart(3, "0")}AAA`,
    FirstName: "L",
    LastName: `Lead ${n}`,
    Email: `l${n}@prospect.com`,
    Company: "Prospect",
    Status: "Open",
    IsConverted: converted,
    OwnerId: OWNER,
    SystemModstamp: stamp,
  };
}

type Route = (soql: string, auth: string) => { status: number; body: unknown };

function salesforce(route: Route, opts: { onQuery?: (call: number) => void | Promise<void> } = {}) {
  const soqls: string[] = [];
  let calls = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const url = new URL(String(input));
    const soql = url.searchParams.get("q") ?? "";
    soqls.push(soql);
    await opts.onQuery?.(calls);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    const { status, body } = route(soql, auth);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, soqls };
}

const stampAt = (baseMs: number, n: number) =>
  new Date(baseMs + n * 1000).toISOString().replace("Z", "+0000");

async function connect(instanceUrl: string = INSTANCE) {
  await upsertConnectorConnection({
    userId: USER,
    connectorId: "salesforce",
    authKind: "oauth2",
    accountRef: ORG,
    label: "ada@acme.com",
    instanceUrl,
    accessToken: "at",
    refreshToken: "rt",
    capabilities: ["syncPeople"],
    nextSyncAt: null,
  });
}

async function seedCursor() {
  await resetConnectorCursor(USER, "salesforce", cursorFromProgress(progressFromCursor(null), { orgId: ORG, userId: OWNER }));
}

async function claim(now?: Date) {
  const conn = await claimConnectorConnectionForUser(USER, "salesforce", now);
  if (!conn) throw new Error("setup: could not claim");
  return conn;
}

async function row() {
  const db = await getDb();
  const [r] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  return r;
}

async function reset() {
  const db = await getDb();
  for (const table of [leads, crmRecords, contacts, connectorConnections]) {
    await db.delete(table).where(eq(table.userId, USER));
  }
}

run(async () => {
  await reset();
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));

  console.log("registration");
  check("Salesforce is available", resolveConnectorWithSync("salesforce")?.availability === "available");
  check("and resolves with a sync", typeof resolveConnectorWithSync("salesforce")?.sync === "function");

  console.log("\n1. first run, both objects");
  await connect();
  await seedCursor();
  const first = salesforce((soql) => {
    if (soql.includes("FROM Contact")) {
      if (soql.includes("SystemModstamp >")) return { status: 200, body: { records: [] } };
      return {
        status: 200,
        body: {
          records: [
            contactRecord(1, "2026-09-01T00:00:00.000+0000"),
            contactRecord(2, "2026-09-02T00:00:00.000+0000"),
          ],
        },
      };
    }
    if (soql.includes("FROM Lead")) {
      return {
        status: 200,
        body: {
          records: [
            leadRecord(1, "2026-09-03T00:00:00.000+0000", false),
            leadRecord(2, "2026-09-04T00:00:00.000+0000", true),
          ],
        },
      };
    }
    return { status: 200, body: { records: [] } };
  });
  const r1 = await syncSalesforce(await claim(), { fetchImpl: first.impl });
  check("complete", r1.outcome === "complete" && r1.records === 4, JSON.stringify(r1));
  check("every SOQL carries the owner filter", first.soqls.every((q) => q.includes(`OwnerId = '${OWNER}'`)), first.soqls.join(" | "));
  const recordsAfter1 = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  const c1 = recordsAfter1.find((r) => r.remoteId === "003000000000001AAA");
  const c2 = recordsAfter1.find((r) => r.remoteId === "003000000000002AAA");
  check("both contacts are linked Orbit contacts", c1?.contactId != null && c2?.contactId != null);
  const leadsAfter1 = await db.select().from(leads).where(eq(leads.userId, USER));
  const openLead = leadsAfter1.find((l) => l.emailNormalized === "l1@prospect.com");
  check("the open lead joined the pipeline", openLead?.crmRecordId != null, JSON.stringify(openLead));
  const convertedRecord = recordsAfter1.find((r) => r.remoteId === "00Q000000000002AAA");
  check("the converted lead's record is a customer", convertedRecord?.lifecycle === "customer", String(convertedRecord?.lifecycle));
  const after1 = await row();
  check(
    "the cursor rests mid-cycle back at Contact",
    after1?.syncCursor?.meta?.phase === "Contact" &&
      after1?.syncCursor?.meta?.contactAt === "2026-09-01T23:55:00.000Z" &&
      after1?.syncCursor?.meta?.contactId === "",
    JSON.stringify(after1?.syncCursor?.meta)
  );
  check("idle, synced, no error", after1?.syncStatus === "idle" && after1?.lastSyncedAt !== null && after1?.syncError === null);

  console.log("\n2. resume");
  const second = salesforce((soql) => ({ status: 200, body: { records: [] } }));
  const r2 = await syncSalesforce(await claim(), { fetchImpl: second.impl });
  check("complete, nothing new", r2.outcome === "complete" && r2.records === 0, JSON.stringify(r2));
  check(
    "the Contact query resumed from the rewound watermark",
    second.soqls.some((q) => q.includes("FROM Contact") && q.includes("SystemModstamp >= 2026-09-01T23:55:00Z")),
    second.soqls.join(" | ")
  );
  const recordsAfter2 = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("no new records", recordsAfter2.length === recordsAfter1.length, String(recordsAfter2.length));

  console.log("\n3. a full page continues, and the budget makes it partial");
  await seedCursor();
  let clock = Date.now();
  const BASE = Date.parse("2026-10-01T00:00:00.000Z");
  const third = salesforce((soql) => {
    clock += 30_000;
    if (soql.includes("FROM Contact")) {
      if (soql.includes("SystemModstamp >")) {
        return {
          status: 200,
          body: { records: Array.from({ length: SALESFORCE_PAGE }, (_, i) => contactRecord(201 + i, stampAt(BASE, 200 + i))) },
        };
      }
      return {
        status: 200,
        body: { records: Array.from({ length: SALESFORCE_PAGE }, (_, i) => contactRecord(1 + i, stampAt(BASE, i))) },
      };
    }
    return { status: 200, body: { records: [] } };
  });
  const r3 = await syncSalesforce(await claim(), { fetchImpl: third.impl, budgetMs: 45_000, now: () => new Date(clock) });
  check("partial after two full pages", r3.outcome === "partial" && r3.pages === 2, JSON.stringify(r3));
  const after3 = await row();
  check("re-armed for the simulated now", after3?.nextSyncAt?.getTime() === clock, String(after3?.nextSyncAt?.getTime()));
  check(
    "the cursor sits mid-phase, not rewound",
    after3?.syncCursor?.meta?.phase === "Contact" && after3?.syncCursor?.meta?.contactId === "003000000000400AAA",
    JSON.stringify(after3?.syncCursor?.meta)
  );

  console.log("\n4. field-level security");
  await seedCursor();
  const fourth = salesforce((soql) => {
    if (soql.includes("FROM Contact")) {
      if (soql.includes("Phone")) return { status: 400, body: [{ errorCode: "INVALID_FIELD", message: "No such column 'Phone'" }] };
      return { status: 200, body: { records: [contactRecord(500, "2026-09-05T00:00:00.000+0000")] } };
    }
    return { status: 200, body: { records: [] } };
  });
  const r4 = await syncSalesforce(await claim(), { fetchImpl: fourth.impl });
  check("completes on the lean list", r4.outcome === "complete" && r4.records >= 1, JSON.stringify(r4));
  const after4 = await row();
  check("the connection remembers it's lean", after4?.syncCursor?.meta?.lean === "1", JSON.stringify(after4?.syncCursor?.meta));
  check(
    "a lean SOQL (no Phone) was sent",
    fourth.soqls.some((q) => q.includes("FROM Contact") && !q.includes("Phone")),
    fourth.soqls.join(" | ")
  );

  console.log("\n5. API disabled stops");
  await seedCursor();
  const fifth = salesforce(() => ({ status: 403, body: [{ errorCode: "API_DISABLED_FOR_ORG", message: "nope" }] }));
  const r5 = await syncSalesforce(await claim(), { fetchImpl: fifth.impl });
  const after5 = await row();
  check("stopped", r5.outcome === "stopped", JSON.stringify(r5));
  check(
    "disarmed with the exact house sentence — no provider text ('nope') anywhere in it",
    after5?.syncError ===
      "Salesforce says API access is off for your user — ask a Salesforce admin to turn on API Enabled, then sync again" &&
      after5?.nextSyncAt === null,
    String(after5?.syncError)
  );

  console.log("\n6. daily limit throws for the scheduler");
  await seedCursor();
  await db.update(connectorConnections).set({ syncStatus: "idle", syncError: null }).where(eq(connectorConnections.userId, USER));
  const sixth = salesforce(() => ({ status: 403, body: [{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "nope" }] }));
  let thrown: unknown = null;
  try {
    await syncSalesforce(await claim(), { fetchImpl: sixth.impl });
  } catch (err) {
    thrown = err;
  }
  check("rejects, retryable", thrown !== null && (thrown as { retryable?: boolean }).retryable === true, String(thrown));
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null }).where(eq(connectorConnections.userId, USER));

  console.log("\n7. 401 -> one refresh -> retry");
  await seedCursor();
  const refreshedWith: (string | null)[] = [];
  const seventh = salesforce((soql, auth) => {
    if (auth === "Bearer at") return { status: 401, body: [{ errorCode: "INVALID_SESSION_ID", message: "expired" }] };
    if (soql.includes("FROM Contact")) return { status: 200, body: { records: [contactRecord(600, "2026-09-06T00:00:00.000+0000")] } };
    return { status: 200, body: { records: [] } };
  });
  const r7 = await syncSalesforce(await claim(), {
    fetchImpl: seventh.impl,
    auth: {
      refresh: async (_id, _rt, instanceUrl) => {
        refreshedWith.push(instanceUrl);
        return { accessToken: "at2", refreshToken: null, expiresAt: null, scopes: null };
      },
    },
  });
  check("refreshed against the org's own host", JSON.stringify(refreshedWith) === JSON.stringify([INSTANCE]), JSON.stringify(refreshedWith));
  check("and completed", r7.outcome === "complete", JSON.stringify(r7));

  console.log("\n8. refresh refused -> needs_reauth");
  // Reconnect to restore a known access token ("at"), since case 7 rewrote it to "at2".
  await connect();
  await seedCursor();
  const eighth = salesforce(() => ({ status: 401, body: [{ errorCode: "INVALID_SESSION_ID", message: "expired" }] }));
  const r8 = await syncSalesforce(await claim(), {
    fetchImpl: eighth.impl,
    auth: {
      refresh: async () => {
        throw new OAuthTokenError("expired access/refresh token", true);
      },
    },
  });
  check("needs_reauth", r8.outcome === "needs_reauth", JSON.stringify(r8));
  const after8 = await row();
  check("the row needs reauth", after8?.status === "needs_reauth", String(after8?.status));

  console.log("\n9. lost lease writes nothing");
  await connect();
  await seedCursor();
  let stolenLease9: Date | null = null;
  const ninth = salesforce(
    (soql) => {
      if (soql.includes("FROM Contact")) return { status: 200, body: { records: [contactRecord(700, "2026-09-07T00:00:00.000+0000")] } };
      return { status: 200, body: { records: [] } };
    },
    {
      onQuery: async (call) => {
        if (call === 1) {
          stolenLease9 = new Date(Date.now() + SYNC_LEASE_MS + 1000);
          await claimConnectorConnectionForUser(USER, "salesforce", stolenLease9);
        }
      },
    }
  );
  const conn9 = await claim();
  const r9 = await syncSalesforce(conn9, { fetchImpl: ninth.impl });
  check("stopped, lease lost", r9.outcome === "stopped" && (r9.message ?? "").includes("connection changed"), JSON.stringify(r9));
  const afterSteal9 = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("nothing written from this page", !afterSteal9.some((r) => r.remoteId === "003000000000700AAA"), String(afterSteal9.length));
  const after9 = await row();
  check(
    "the stolen claim's lease stands",
    after9?.syncStartedAt?.getTime() === stolenLease9!.getTime(),
    String(after9?.syncStartedAt)
  );
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null }).where(eq(connectorConnections.userId, USER));

  console.log("\n10. lost lease on the stop path");
  await seedCursor();
  let stolenLease10: Date | null = null;
  const tenth = salesforce(
    () => ({ status: 403, body: [{ errorCode: "API_DISABLED_FOR_ORG", message: "nope" }] }),
    {
      onQuery: async (call) => {
        if (call === 1) {
          stolenLease10 = new Date(Date.now() + SYNC_LEASE_MS + 1000);
          await claimConnectorConnectionForUser(USER, "salesforce", stolenLease10);
        }
      },
    }
  );
  const conn10 = await claim();
  const r10 = await syncSalesforce(conn10, { fetchImpl: tenth.impl });
  check("stopped", r10.outcome === "stopped", JSON.stringify(r10));
  const after10 = await row();
  check("the stop was never recorded over the new holder", after10?.syncError === null, String(after10?.syncError));
  check("the stolen claim's lease stands here too", after10?.syncStartedAt?.getTime() === stolenLease10!.getTime());
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null }).where(eq(connectorConnections.userId, USER));

  console.log("\n11. not entitled");
  await seedCursor();
  await db.update(userSettings).set({ compedPlan: null }).where(eq(userSettings.userId, USER));
  const eleventh = salesforce(() => {
    throw new Error("must not be called");
  });
  const r11 = await syncSalesforce(await claim(), { fetchImpl: eleventh.impl });
  check("stopped without calling Salesforce", r11.outcome === "stopped", JSON.stringify(r11));
  check("no SOQL was sent", eleventh.soqls.length === 0, String(eleventh.soqls.length));
  check("the upgrade line", ((await row())?.syncError ?? "").includes("Orbit Pro and Lifetime"));
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null, syncError: null }).where(eq(connectorConnections.userId, USER));

  console.log("\n12. no identity / another org");
  await resetConnectorCursor(USER, "salesforce", null);
  const twelfthA = salesforce(() => {
    throw new Error("must not be called");
  });
  const r12a = await syncSalesforce(await claim(), { fetchImpl: twelfthA.impl });
  check("no identity: stopped, reconnect", r12a.outcome === "stopped" && (r12a.message ?? "").toLowerCase().includes("reconnect"), JSON.stringify(r12a));
  check("no SOQL was sent", twelfthA.soqls.length === 0, String(twelfthA.soqls.length));
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null, syncError: null }).where(eq(connectorConnections.userId, USER));

  await resetConnectorCursor(USER, "salesforce", cursorFromProgress(progressFromCursor(null), { orgId: "00D000000000999AAA", userId: OWNER }));
  const twelfthB = salesforce(() => {
    throw new Error("must not be called");
  });
  const r12b = await syncSalesforce(await claim(), { fetchImpl: twelfthB.impl });
  check("mismatched org: stopped, reconnect", r12b.outcome === "stopped" && (r12b.message ?? "").toLowerCase().includes("reconnect"), JSON.stringify(r12b));
  check("no SOQL was sent", twelfthB.soqls.length === 0, String(twelfthB.soqls.length));
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null, syncError: null }).where(eq(connectorConnections.userId, USER));

  console.log("\n13. untrusted host");
  await seedCursor();
  await db.update(connectorConnections).set({ instanceUrl: "https://evil.example" }).where(eq(connectorConnections.userId, USER));
  const thirteenth = salesforce(() => {
    throw new Error("must not be called");
  });
  const r13 = await syncSalesforce(await claim(), { fetchImpl: thirteenth.impl });
  check("stopped, no fetch", r13.outcome === "stopped" && thirteenth.soqls.length === 0, JSON.stringify(r13));

  console.log("\n14. the lean fallback is ALSO blocked (Ruling 8 exhausted)");
  // Case 13 pointed instance_url at an untrusted host directly in the row; restore it.
  await connect();
  await seedCursor();
  const fourteenth = salesforce(() => ({ status: 400, body: [{ errorCode: "INVALID_FIELD", message: "No such column" }] }));
  const r14 = await syncSalesforce(await claim(), { fetchImpl: fourteenth.impl });
  check("stopped", r14.outcome === "stopped", JSON.stringify(r14));
  check("both the full and the lean query were tried", fourteenth.soqls.length === 2, String(fourteenth.soqls.length));
  const after14 = await row();
  check(
    "the fixed sentence, not the false 'Orbit will read the ones you can see' line",
    after14?.syncError ===
      "Salesforce won’t let this connection read contact and lead names, emails and companies — ask a Salesforce admin to grant read access, then sync again",
    String(after14?.syncError)
  );
  await db
    .update(connectorConnections)
    .set({ syncStatus: "idle", syncStartedAt: null, syncError: null, syncFailures: 0 })
    .where(eq(connectorConnections.userId, USER));

  console.log("\n15. a lost lease survives the scheduler's own retry bookkeeping too");
  await seedCursor();
  let stolenLease15: Date | null = null;
  const fifteenth = salesforce(
    () => ({ status: 403, body: [{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "nope" }] }),
    {
      onQuery: async (call) => {
        if (call === 1) {
          stolenLease15 = new Date(Date.now() + SYNC_LEASE_MS + 1000);
          await claimConnectorConnectionForUser(USER, "salesforce", stolenLease15);
        }
      },
    }
  );
  const conn15 = await claim();
  let thrown15: unknown = null;
  try {
    await syncSalesforce(conn15, { fetchImpl: fifteenth.impl });
  } catch (err) {
    thrown15 = err;
  }
  check("rejects, retryable", thrown15 !== null && (thrown15 as { retryable?: boolean }).retryable === true, String(thrown15));
  // Exactly what the scheduler's (and runCrmSyncNow's) catch does with the claimed connection.
  await markConnectorSyncResult(
    conn15.id,
    { ok: false, error: (thrown15 as Error).message, retryable: true },
    undefined,
    { leaseStartedAt: conn15.leaseStartedAt }
  );
  const after15 = await row();
  check("the new holder's lease still stands", after15?.syncStartedAt?.getTime() === stolenLease15!.getTime(), String(after15?.syncStartedAt));
  check("still syncing — not backed off over the new holder", after15?.syncStatus === "syncing", String(after15?.syncStatus));
  check("no error recorded over the new holder", after15?.syncError === null, String(after15?.syncError));
  check("no failure counted over the new holder either", after15?.syncFailures === 0, String(after15?.syncFailures));
  await db.update(connectorConnections).set({ syncStatus: "idle", syncStartedAt: null }).where(eq(connectorConnections.userId, USER));

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Salesforce sync checks passed.");
});
