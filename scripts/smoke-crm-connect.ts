/**
 * Connecting a CRM: the authorize URL, and `completeCrmConnect` — the part of the callback
 * with the security properties. A validly-signed state is not enough: it must name the person
 * whose session is finishing the flow (see `OAuthState` in src/lib/connectors/oauth.ts).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";
process.env.SALESFORCE_CLIENT_ID = "sf-cid";
process.env.SALESFORCE_CLIENT_SECRET = "sf-secret";
process.env.APP_BASE_URL = "https://orbit.test";
delete process.env.HUBSPOT_REDIRECT_URI;

import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, crmRecords } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  getConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
  saveConnectorCursor,
} from "../src/lib/connectors/connections";
import { parseOAuthState, pkceVerifierForState, signOAuthState } from "../src/lib/connectors/oauth";
import {
  CrmConnectError,
  completeCrmConnect,
  crmAuthorizeUrl,
  crmRedirectUri,
  isCrmConnectorId,
} from "../src/lib/crm/connect";
import { upsertCrmRecords } from "../src/lib/crm/records";
import type { CrmPerson } from "../src/lib/crm/types";
import { decryptOrNull } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-connect";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(hubId: number, opts: { exchange?: number } = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth/2026-09/token")) {
      if (opts.exchange && opts.exchange !== 200) return json(opts.exchange, { error: "invalid_grant", error_description: "bad code" });
      return json(200, { token_type: "bearer", access_token: "acc", refresh_token: "ref", expires_in: 1800, hub_id: hubId, scopes: ["crm.objects.contacts.read", "crm.objects.owners.read"] });
    }
    if (url.endsWith("/token/introspect")) return json(200, { active: true, hub_id: hubId, hub_domain: `portal-${hubId}.hubspot.com`, user_id: 9, user: "sam@acme.test" });
    throw new Error(`unscripted ${url}`);
  }) as typeof fetch;
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

async function cleanup(userId: string) {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, userId));
  await db.delete(crmRecords).where(eq(crmRecords.userId, userId));
}

async function listCrmRecordsForSmoke(userId: string, connectorId: string) {
  const db = await getDb();
  return db
    .select()
    .from(crmRecords)
    .where(and(eq(crmRecords.userId, userId), eq(crmRecords.connectorId, connectorId)));
}

function person(overrides: Partial<CrmPerson> & { remoteId: string }): CrmPerson {
  return {
    remoteType: "contact",
    lifecycle: "customer",
    stage: null,
    displayName: `P ${overrides.remoteId}`,
    email: null,
    phone: null,
    linkedinUrl: null,
    companyName: null,
    companyDomain: null,
    title: null,
    remoteOwnerRef: null,
    remoteUrl: null,
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
    ...overrides,
  };
}

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));

  console.log("the authorize URL");
  check("hubspot is a CRM connector; notion is not", isCrmConnectorId("hubspot") && !isCrmConnectorId("notion"));
  check("the redirect is derived from APP_BASE_URL", crmRedirectUri("hubspot") === "https://orbit.test/api/connectors/hubspot/callback");
  process.env.HUBSPOT_REDIRECT_URI = "https://preview.orbit.test/api/connectors/hubspot/callback";
  check("HUBSPOT_REDIRECT_URI wins when set", crmRedirectUri("hubspot") === "https://preview.orbit.test/api/connectors/hubspot/callback");
  delete process.env.HUBSPOT_REDIRECT_URI;
  const url = new URL(crmAuthorizeUrl(USER, "hubspot", "/leads"));
  check("HubSpot's authorize endpoint", url.origin + url.pathname === "https://app.hubspot.com/oauth/authorize");
  check("the client id", url.searchParams.get("client_id") === "cid");
  check("the redirect", url.searchParams.get("redirect_uri") === "https://orbit.test/api/connectors/hubspot/callback");
  check("the app's required scopes, space-separated", url.searchParams.get("scope") === "crm.objects.contacts.read crm.objects.owners.read");
  const rawState = url.searchParams.get("state")!;
  const state = parseOAuthState(rawState);
  check("a signed state naming this user, connector and return path", state?.userId === USER && state?.connectorId === "hubspot" && state?.returnTo === "/leads", JSON.stringify(state));

  console.log("\ncompleting the connect");
  const done = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c1", state: state!, rawState, fetchImpl: provider(4242) });
  check("reports the account", done.accountRef === "4242" && done.label === "portal-4242.hubspot.com" && !done.switchedAccount);
  const [row] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check("one oauth2 connection row", row?.connectorId === "hubspot" && row?.authKind === "oauth2");
  check("tokens stored encrypted", decryptOrNull(row?.accessTokenEncrypted ?? null) === "acc" && decryptOrNull(row?.refreshTokenEncrypted ?? null) === "ref");
  check("the 30-minute expiry", Math.abs((row?.tokenExpiresAt?.getTime() ?? 0) - (Date.now() + 1_800_000)) < 10_000);
  check("label and account", row?.label === "portal-4242.hubspot.com" && row?.accountRef === "4242");
  check("granted scopes", row?.scopes === "crm.objects.contacts.read crm.objects.owners.read");
  check("reads switched on", JSON.stringify(row?.capabilities) === JSON.stringify(["syncPeople"]));
  check("armed: the sync ships in the same change", row?.nextSyncAt !== null && row?.status === "active");

  console.log("\nthe state must name the person finishing the flow");
  const stolen = await caught(completeCrmConnect({ sessionUserId: "someone-else", connectorId: "hubspot", code: "c2", state: state!, rawState, fetchImpl: provider(4242) }));
  check("another session is refused", stolen instanceof CrmConnectError && stolen.kind === "state_mismatch");
  check("and nothing is written for them", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, "someone-else"))).length === 0);
  const crossedState = { ...state!, connectorId: "salesforce" };
  const crossed = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c3", state: crossedState, rawState: signOAuthState(crossedState), fetchImpl: provider(4242) }));
  check("a state minted for another connector is refused", crossed instanceof CrmConnectError && crossed.kind === "state_mismatch");
  const badCode = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "bad", state: state!, rawState, fetchImpl: provider(4242, { exchange: 400 }) }));
  check("a refused code is an exchange failure", badCode instanceof CrmConnectError && badCode.kind === "exchange_failed");

  console.log("\nreconnecting");
  await upsertCrmRecords(USER, "hubspot", [
    { remoteType: "contact", remoteId: "1", lifecycle: "lead", stage: null, displayName: "Kept", email: null, phone: null, linkedinUrl: null, companyName: null, companyDomain: null, title: null, remoteOwnerRef: null, remoteUrl: null, lastActivityAt: null, remoteCreatedAt: null, remoteUpdatedAt: null, properties: {} },
  ]);
  // A window in progress, and the owner of whoever connected last — possibly someone else in
  // the same portal.
  await db
    .update(connectorConnections)
    .set({ syncCursor: { syncedThrough: "2026-09-01T00:00:00.000Z", cursor: "300", meta: { portalId: "4242", ownerId: "77", windowMax: "2026-09-02T00:00:00.000Z" } } })
    .where(eq(connectorConnections.userId, USER));
  const same = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c4", state: state!, rawState, fetchImpl: provider(4242) });
  check("the same account keeps its records", !same.switchedAccount && (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 1);
  const [reconnectedRow] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check("every reconnect starts a fresh window: the cursor is cleared", reconnectedRow?.syncCursor === null, JSON.stringify(reconnectedRow?.syncCursor));
  const other = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c5", state: state!, rawState, fetchImpl: provider(999) });
  check("another account clears the old account's records", other.switchedAccount && (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 0);
  check("still one connection row", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 1);

  console.log("\nthe route stays a thin shell");
  const route = readFileSync("src/app/api/connectors/[connectorId]/callback/route.ts", "utf8");
  check("awaits its params (Next 16)", /const \{ connectorId \} = await params/.test(route));
  check("parses the signed state", route.includes("parseOAuthState("));
  check("gates on the paid, released Leads surface", route.includes("requireCrmUser()"));
  check("hands the security-bearing part to completeCrmConnect", route.includes("completeCrmConnect("));
  check("never writes an error message into the URL", !/searchParams\.set\([^)]*message/.test(route) && !/searchParams\.set\([^)]*String\(err/.test(route));
  check("records the failure", route.includes("ERROR_SOURCES.oauthConnectorCallback"));

  // --- Salesforce (Leads P5) -----------------------------------------------------------
  {
    const SF = "smoke-crm-connect-sf";
    await cleanup(SF);
    const authorize = new URL(crmAuthorizeUrl(SF, "salesforce", "/leads", { sandbox: true }));
    check("a sandbox connect authorizes at test.salesforce.com", authorize.origin === "https://test.salesforce.com");
    check("and asks for api, refresh_token and id", authorize.searchParams.get("scope") === "api refresh_token id");
    const sfRawState = authorize.searchParams.get("state")!;
    const sfState = parseOAuthState(sfRawState)!;

    const seen: Array<{ url: string; body: string; auth: string | null }> = [];
    const sfProvider = (opts: { instanceUrl?: string; idUrl?: string; orgId?: string } = {}): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, body: String(init?.body ?? ""), auth: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/services/oauth2/token")) {
          return Response.json({
            access_token: "sf-at",
            refresh_token: "sf-rt",
            instance_url: opts.instanceUrl ?? "https://acme--dev.sandbox.my.salesforce.com",
            id: opts.idUrl ?? "https://test.salesforce.com/id/00D000000000001AAA/005000000000001AAA",
            token_type: "Bearer",
            issued_at: "1790000000000",
            signature: "s",
          });
        }
        if (url.includes("/id/")) {
          return Response.json({ organization_id: opts.orgId ?? "00D000000000001AAA", user_id: "005000000000001AAA", username: "ada@acme.com.dev", display_name: "Ada" });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;

    const sfDone = await completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c1", state: sfState, rawState: sfRawState, fetchImpl: sfProvider() });
    const exchange = seen.find((s) => s.url.endsWith("/services/oauth2/token"));
    check("the code is exchanged on the sandbox host", exchange?.url === "https://test.salesforce.com/services/oauth2/token", exchange?.url);
    check("with the state's PKCE verifier", new URLSearchParams(exchange?.body).get("code_verifier") === pkceVerifierForState(sfRawState));
    check("the label is the Salesforce username", sfDone.label === "ada@acme.com.dev");
    const sfRow = await getConnectorConnection(SF, "salesforce");
    check("the org id is the account ref", sfRow?.accountRef === "00D000000000001AAA");
    check("instance_url is stored", sfRow?.instanceUrl === "https://acme--dev.sandbox.my.salesforce.com", String(sfRow?.instanceUrl));
    const claimed = await claimConnectorConnectionForUser(SF, "salesforce");
    check(
      "the cursor is seeded with org and user",
      claimed?.cursor?.meta?.orgId === "00D000000000001AAA" && claimed.cursor.meta.userId === "005000000000001AAA",
      JSON.stringify(claimed?.cursor)
    );
    check("and armed", sfRow?.nextSyncAt !== null);
    await markConnectorSyncResult(claimed!.id, { ok: true, cursor: claimed!.cursor });

    const evilInstance = await caught(
      completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c2", state: sfState, rawState: sfRawState, fetchImpl: sfProvider({ instanceUrl: "https://evil.example" }) })
    );
    check("an untrusted instance_url is refused", evilInstance instanceof CrmConnectError && evilInstance.kind === "identify_failed");
    const evilId = await caught(
      completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c3", state: sfState, rawState: sfRawState, fetchImpl: sfProvider({ idUrl: "https://evil.example/id/x/y" }) })
    );
    check("an untrusted identity URL is refused", evilId instanceof CrmConnectError && evilId.kind === "identify_failed");
    check("and neither was sent a token", !seen.some((s) => s.url.startsWith("https://evil.example")));
    check("the stored host survived both refusals", (await getConnectorConnection(SF, "salesforce"))?.instanceUrl === "https://acme--dev.sandbox.my.salesforce.com");

    await upsertCrmRecords(SF, "salesforce", [person({ remoteId: "003000000000009AAA" })]);
    const switched = await completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c4", state: sfState, rawState: sfRawState, fetchImpl: sfProvider({ orgId: "00D000000000002AAA" }) });
    check("another org is a switched account", switched.switchedAccount);
    check("whose old records are gone", (await listCrmRecordsForSmoke(SF, "salesforce")).length === 0);

    // F1: a reconnect lands while a claimed run is mid-flight. The grant and its seed are one
    // statement, and the stale run's lease-scoped writes never reach the new grant.
    const midFlight = await claimConnectorConnectionForUser(SF, "salesforce");
    if (!midFlight) throw new Error("setup: could not claim");
    await completeCrmConnect({
      sessionUserId: SF,
      connectorId: "salesforce",
      code: "c6",
      state: sfState,
      rawState: sfRawState,
      fetchImpl: sfProvider({ orgId: "00D000000000003AAA", instanceUrl: "https://acme--dev.sandbox.my.salesforce.com/" }),
    });
    await saveConnectorCursor(midFlight.id, { meta: { orgId: "00D000000000002AAA", userId: "005000000000009AAA", phase: "Contact" } }, {
      leaseStartedAt: midFlight.leaseStartedAt,
    });
    await markConnectorNeedsReauth(midFlight.id, "Salesforce stopped accepting Orbit’s sign-in — reconnect to keep syncing", {
      leaseStartedAt: midFlight.leaseStartedAt,
    });
    const afterMid = await claimConnectorConnectionForUser(SF, "salesforce");
    check(
      "a stale run's cursor save never overwrites the reconnect's seed",
      afterMid?.cursor?.meta?.orgId === "00D000000000003AAA" && afterMid.cursor.meta.userId === "005000000000001AAA",
      JSON.stringify(afterMid?.cursor)
    );
    check("nor marks the new grant needs_reauth", afterMid !== null && (await getConnectorConnection(SF, "salesforce"))?.status === "active");
    check(
      "the instance host is stored as its origin",
      (await getConnectorConnection(SF, "salesforce"))?.instanceUrl === "https://acme--dev.sandbox.my.salesforce.com",
      String((await getConnectorConnection(SF, "salesforce"))?.instanceUrl)
    );
    if (afterMid) await markConnectorSyncResult(afterMid.id, { ok: true, cursor: afterMid.cursor });

    const forged = await caught(
      completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c5", state: { ...sfState, userId: "someone-else" }, rawState: sfRawState, fetchImpl: sfProvider() })
    );
    check("a state for someone else is refused", forged instanceof CrmConnectError && forged.kind === "state_mismatch");
    const noVerifier = await caught(
      completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c6", state: sfState, rawState: "garbage", fetchImpl: sfProvider() })
    );
    check("a state that yields no verifier is refused", noVerifier instanceof CrmConnectError && noVerifier.kind === "state_mismatch");

    await cleanup(SF);
  }

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM connect checks passed.");
});
