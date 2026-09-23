/**
 * The HubSpot sync end to end against a scripted HubSpot: identify the owner, page the owned
 * contacts, write them through `persistCrmPage`, and record progress so a run cut short
 * resumes where it stopped. Every outcome the scheduler depends on is pinned here.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, contacts, crmRecords, leads, userSettings } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { resolveConnectorWithSync } from "../src/lib/connectors/syncs";
import { HUBSPOT_WATERMARK_OVERLAP_MS } from "../src/lib/crm/hubspot/mapping";
import { syncHubspot } from "../src/lib/crm/hubspot/sync";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-sync";

/** Where a finished window leaves the next one: five minutes before its newest record. */
const overlapped = (max: string) => new Date(Date.parse(max) - HUBSPOT_WATERMARK_OVERLAP_MS).toISOString();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function contact(id: string, first: string, email: string, stage: string | null, modified: string) {
  return {
    id,
    properties: { firstname: first, lastname: "Test", email, lifecyclestage: stage, hubspot_owner_id: "77", lastmodifieddate: modified },
  };
}

/** A HubSpot with owner 77 and the given pages of search results, answered in order. */
function hubspot(
  pages: Array<{ results: unknown[]; after: string | null } | "429" | "403">,
  opts: { onSearch?: () => void | Promise<void>; introspect?: Record<string, unknown> } = {}
) {
  const searches: Array<Record<string, unknown>> = [];
  let introspections = 0;
  let owners = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token/introspect")) {
      introspections++;
      return json(200, opts.introspect ?? { active: true, hub_id: 4242, hub_domain: "acme.hubspot.com", user_id: 9, user: "sam@acme.test" });
    }
    if (url.includes("/crm/owners/")) owners++;
    if (url.includes("/crm/owners/2026-09/9?idProperty=userId")) return json(200, { id: "77" });
    if (url.endsWith("/contacts/search")) {
      searches.push(JSON.parse(String(init?.body)));
      await opts.onSearch?.();
      const next = pages.shift();
      if (!next) return json(200, { total: 0, results: [] });
      if (next === "429") return json(429, { errorType: "RATE_LIMIT" });
      if (next === "403") return json(403, { message: "missing scopes" });
      return json(200, { total: 999, results: next.results, ...(next.after ? { paging: { next: { after: next.after } } } : {}) });
    }
    throw new Error(`unscripted ${url}`);
  }) as typeof fetch;
  return { impl, searches, introspections: () => introspections, owners: () => owners };
}

async function connect() {
  await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    label: "acme.hubspot.com",
    accountRef: "4242",
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    nextSyncAt: null,
  });
}

async function claim() {
  const conn = await claimConnectorConnectionForUser(USER, "hubspot");
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
  // A paid plan: `crm` is a paid entitlement and the sync checks it every run. Comped the way
  // scripts/smoke-entitlements.ts comps an account.
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));

  console.log("registration");
  check("HubSpot is available", resolveConnectorWithSync("hubspot")?.availability === "available");
  check("and resolves with a sync", typeof resolveConnectorWithSync("hubspot")?.sync === "function");

  console.log("\na first run: identify, then page to the end");
  await connect();
  const first = hubspot([
    { results: [contact("1", "Dana", "dana@acme.test", "customer", "2026-09-01T00:00:00.000Z"), contact("2", "Grace", "grace@beta.test", "lead", "2026-09-02T00:00:00.000Z")], after: "100" },
    { results: [contact("3", "Ivy", "ivy@gamma.test", null, "2026-09-03T00:00:00.000Z")], after: null },
  ]);
  const r1 = await syncHubspot(await claim(), { fetchImpl: first.impl });
  check("complete", r1.outcome === "complete" && r1.pages === 2, JSON.stringify(r1));
  check("introspected once", first.introspections() === 1);
  const filters1 = (first.searches[0]?.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>)[0].filters;
  check("searched the owner's contacts", filters1[0]?.propertyName === "hubspot_owner_id" && filters1[0]?.value === "77");
  check("the first run is a full read (no since)", filters1.length === 1);
  check("the second page carried after", first.searches[1]?.after === "100");
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("three records stored", records.length === 3, String(records.length));
  check("the customer became a linked contact", records.find((r) => r.remoteId === "1")?.contactId !== null);
  const pipeline = await db.select().from(leads).where(eq(leads.userId, USER));
  check("the lead and the no-stage record joined the pipeline", pipeline.length === 2 && pipeline.every((l) => l.source === "crm"), String(pipeline.length));
  const after1 = await row();
  check("the row is idle and re-armed on the normal cadence", after1?.syncStatus === "idle" && (after1?.nextSyncAt?.getTime() ?? 0) > Date.now() + 20 * 60_000);
  check("the cursor holds the identity", after1?.syncCursor?.meta?.portalId === "4242" && after1?.syncCursor?.meta?.ownerId === "77");
  check(
    "…and the watermark is the newest modified time, less the overlap",
    after1?.syncCursor?.syncedThrough === overlapped("2026-09-03T00:00:00.000Z"),
    String(after1?.syncCursor?.syncedThrough)
  );
  check("…and the full read is stamped", Boolean(after1?.syncCursor?.meta?.fullSyncedAt));

  console.log("\nthe next run is incremental, and re-uses the identity");
  const second = hubspot([{ results: [contact("2", "Grace", "grace@beta.test", "customer", "2026-09-04T00:00:00.000Z")], after: null }]);
  const r2 = await syncHubspot(await claim(), { fetchImpl: second.impl });
  check("complete", r2.outcome === "complete", JSON.stringify(r2));
  check("no second introspection", second.introspections() === 0);
  const filters2 = (second.searches[0]?.filterGroups as Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>)[0].filters;
  check("filtered on lastmodifieddate >= the watermark", filters2[1]?.propertyName === "lastmodifieddate" && filters2[1]?.operator === "GTE" && filters2[1]?.value === String(Date.parse(overlapped("2026-09-03T00:00:00.000Z"))), filters2[1]?.value);
  const graceLead = (await db.select().from(leads).where(eq(leads.userId, USER))).find((l) => l.emailNormalized === "grace@beta.test");
  check("a lead that became a customer converted", graceLead?.status === "converted" && graceLead?.contactId !== null);

  console.log("\na run that runs out of budget saves its page and comes back");
  await db.update(connectorConnections).set({ syncCursor: null }).where(eq(connectorConnections.userId, USER));
  // Each search "takes" 1.2 s of a 1 s budget: one page fits, the second does not start.
  let clock = Date.now();
  let ticking = true;
  const slow = hubspot(
    [
      { results: [contact("5", "Page", "p1@x.test", "lead", "2026-09-05T00:00:00.000Z")], after: "100" },
      { results: [contact("6", "Page", "p2@x.test", "lead", "2026-09-06T00:00:00.000Z")], after: null },
    ],
    { onSearch: () => {
      if (ticking) clock += 1_200;
    } }
  );
  const r3 = await syncHubspot(await claim(), {
    fetchImpl: slow.impl,
    budgetMs: 1_000,
    now: () => new Date(clock),
  });
  ticking = false;
  check("partial after one page", r3.outcome === "partial" && r3.pages === 1, JSON.stringify(r3));
  const after3 = await row();
  check("due again now", (after3?.nextSyncAt?.getTime() ?? Infinity) <= Date.now() + 5_000);
  check("resuming at the next page", after3?.syncCursor?.cursor === "100");
  const r4 = await syncHubspot(await claim(), { fetchImpl: slow.impl });
  check("the next run finishes it", r4.outcome === "complete" && slow.searches[1]?.after === "100", JSON.stringify(r4));

  console.log("\na 429 mid-run: retryable, progress kept");
  await db.update(connectorConnections).set({ syncCursor: null }).where(eq(connectorConnections.userId, USER));
  const limited = hubspot([{ results: [contact("7", "Rate", "r@x.test", "lead", "2026-09-07T00:00:00.000Z")], after: "100" }, "429"]);
  let thrown: unknown = null;
  try {
    await syncHubspot(await claim(), { fetchImpl: limited.impl });
  } catch (err) {
    thrown = err;
  }
  check("the 429 propagates for the scheduler to back off", thrown !== null && (thrown as { retryable?: boolean }).retryable === true, String(thrown));
  check("the first page's cursor survived", (await row())?.syncCursor?.cursor === "100");
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\na 403: stop and say why");
  const forbidden = hubspot(["403"]);
  const r5 = await syncHubspot(await claim(), { fetchImpl: forbidden.impl });
  const after5 = await row();
  check("stopped", r5.outcome === "stopped", JSON.stringify(r5));
  check("disarmed with HubSpot's reason in the house voice", after5?.nextSyncAt === null && (after5?.syncError ?? "").includes("reconnect HubSpot"), String(after5?.syncError));

  console.log("\na reconnect to another HubSpot account starts over");
  await db
    .update(connectorConnections)
    .set({ accountRef: "999", syncStatus: "idle", nextSyncAt: new Date() })
    .where(eq(connectorConnections.userId, USER));
  const other = hubspot([]);
  await syncHubspot(await claim(), { fetchImpl: other.impl });
  check("it re-identified", other.introspections() === 1);
  await db.update(connectorConnections).set({ accountRef: "4242", syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\na run whose only page is empty");
  const quiet = hubspot([{ results: [], after: null }]);
  const rQuiet = await syncHubspot(await claim(), { fetchImpl: quiet.impl });
  check("completes, having read one empty page", rQuiet.outcome === "complete" && rQuiet.pages === 1 && rQuiet.records === 0, JSON.stringify(rQuiet));
  const afterQuiet = await row();
  check("and records its end", afterQuiet?.syncStatus === "idle" && afterQuiet?.syncError === null && afterQuiet?.lastSyncedAt !== null);

  console.log("\na connection deleted mid-run: the run stops writing");
  await db.update(connectorConnections).set({ syncCursor: null, syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));
  let purgeSearches = 0;
  const purged = hubspot(
    [
      { results: [contact("20", "Before", "before@x.test", "lead", "2026-09-10T00:00:00.000Z")], after: "100" },
      { results: [contact("21", "After", "after@x.test", "customer", "2026-09-11T00:00:00.000Z")], after: null },
    ],
    // Account deletion, or the "Connected accounts" data category, lands while page 2 is in flight.
    { onSearch: async () => {
      if (++purgeSearches === 2) await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
    } }
  );
  const r7 = await syncHubspot(await claim(), { fetchImpl: purged.impl });
  check("stopped, and says why", r7.outcome === "stopped" && r7.message === "HubSpot’s connection changed during the sync", JSON.stringify(r7));
  const afterPurge = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("page 1 was written before the purge", afterPurge.some((r) => r.remoteId === "20"));
  check("the person from page 2 never was", !afterPurge.some((r) => r.remoteId === "21"));
  check("…nor became a contact", (await db.select().from(contacts).where(eq(contacts.userId, USER))).every((c) => c.email !== "after@x.test"));
  check("nothing brought the row back", (await row()) === undefined);

  console.log("\na reconnect mid-run: the old run stops writing");
  await connect();
  let reconnectSearches = 0;
  const reconnected = hubspot(
    [
      { results: [contact("22", "Early", "early@x.test", "lead", "2026-09-12T00:00:00.000Z")], after: "100" },
      { results: [contact("23", "Late", "late@x.test", "lead", "2026-09-13T00:00:00.000Z")], after: null },
    ],
    { onSearch: async () => {
      if (++reconnectSearches === 2) await connect();
    } }
  );
  const r8 = await syncHubspot(await claim(), { fetchImpl: reconnected.impl });
  check("stopped", r8.outcome === "stopped" && r8.message === "HubSpot’s connection changed during the sync", JSON.stringify(r8));
  const afterReconnect = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("page 2 was never written", afterReconnect.some((r) => r.remoteId === "22") && !afterReconnect.some((r) => r.remoteId === "23"));
  const reconnectedRow = await row();
  check(
    "the reconnect’s row is left as the reconnect wrote it",
    reconnectedRow?.syncStatus === "idle" && reconnectedRow?.syncError === null && reconnectedRow?.lastSyncedAt === null,
    JSON.stringify({ s: reconnectedRow?.syncStatus, e: reconnectedRow?.syncError, l: reconnectedRow?.lastSyncedAt })
  );

  console.log("\nan introspection that names nobody says so");
  await db.update(connectorConnections).set({ syncCursor: null, syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));
  const nameless = hubspot([], { introspect: { active: true, hub_id: 4242 } });
  const r9 = await syncHubspot(await claim(), { fetchImpl: nameless.impl });
  check("stopped with its own reason", r9.outcome === "stopped" && r9.message === "HubSpot didn’t say who connected — reconnect HubSpot", JSON.stringify(r9));
  check("no owner lookup, no search", nameless.owners() === 0 && nameless.searches.length === 0, `${nameless.owners()} owners, ${nameless.searches.length} searches`);
  check("the card gets the same words", (await row())?.syncError === "HubSpot didn’t say who connected — reconnect HubSpot", String((await row())?.syncError));

  console.log("\na downgraded account stops syncing");
  await db.update(userSettings).set({ compedPlan: null }).where(eq(userSettings.userId, USER));
  const unpaid = hubspot([]);
  const r6 = await syncHubspot(await claim(), { fetchImpl: unpaid.impl });
  check("stopped without calling HubSpot", r6.outcome === "stopped" && unpaid.searches.length === 0 && unpaid.introspections() === 0);
  check("with the upgrade message", ((await row())?.syncError ?? "").includes("Orbit Pro and Lifetime"));
  check("and nothing was deleted", (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length > 0);

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM sync checks passed.");
});
