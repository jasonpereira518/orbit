/**
 * Connecting a CRM: the authorize URL, and `completeCrmConnect` — the part of the callback
 * with the security properties. A validly-signed state is not enough: it must name the person
 * whose session is finishing the flow (see `OAuthState` in src/lib/connectors/oauth.ts).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";
process.env.APP_BASE_URL = "https://orbit.test";
delete process.env.HUBSPOT_REDIRECT_URI;

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, crmRecords } from "../src/db/schema";
import { parseOAuthState } from "../src/lib/connectors/oauth";
import {
  CrmConnectError,
  completeCrmConnect,
  crmAuthorizeUrl,
  crmRedirectUri,
  isCrmConnectorId,
} from "../src/lib/crm/connect";
import { upsertCrmRecords } from "../src/lib/crm/records";
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
  const state = parseOAuthState(url.searchParams.get("state"));
  check("a signed state naming this user, connector and return path", state?.userId === USER && state?.connectorId === "hubspot" && state?.returnTo === "/leads", JSON.stringify(state));

  console.log("\ncompleting the connect");
  const done = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c1", state: state!, fetchImpl: provider(4242) });
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
  const stolen = await caught(completeCrmConnect({ sessionUserId: "someone-else", connectorId: "hubspot", code: "c2", state: state!, fetchImpl: provider(4242) }));
  check("another session is refused", stolen instanceof CrmConnectError && stolen.kind === "state_mismatch");
  check("and nothing is written for them", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, "someone-else"))).length === 0);
  const crossed = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c3", state: { ...state!, connectorId: "salesforce" }, fetchImpl: provider(4242) }));
  check("a state minted for another connector is refused", crossed instanceof CrmConnectError && crossed.kind === "state_mismatch");
  const badCode = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "bad", state: state!, fetchImpl: provider(4242, { exchange: 400 }) }));
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
  const same = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c4", state: state!, fetchImpl: provider(4242) });
  check("the same account keeps its records", !same.switchedAccount && (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 1);
  const [reconnectedRow] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check("every reconnect starts a fresh window: the cursor is cleared", reconnectedRow?.syncCursor === null, JSON.stringify(reconnectedRow?.syncCursor));
  const other = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c5", state: state!, fetchImpl: provider(999) });
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

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM connect checks passed.");
});
