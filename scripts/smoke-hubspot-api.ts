/**
 * HubSpot's HTTP client against a scripted fetch: the dated endpoints, the auth header, the
 * form bodies OAuth wants, and the error taxonomy the sync acts on. No network, no database.
 * Run: npx tsx scripts/smoke-hubspot-api.ts
 */
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { ConnectorAuthError } from "../src/lib/connectors/auth-errors";
import { OAUTH_PROVIDERS, exchangeCode, isOAuthConfigured } from "../src/lib/connectors/oauth";
import {
  HubspotApiError,
  findHubspotOwner,
  introspectHubspotToken,
  revokeHubspotToken,
  searchHubspotContacts,
} from "../src/lib/crm/hubspot/api";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fetch that answers from a list of (predicate, response) pairs and records every call. */
function scripted(routes: Array<[(url: string) => boolean, () => Response | Promise<Response>]>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ""),
    });
    const route = routes.find(([match]) => match(url));
    if (!route) throw new Error(`unscripted ${url}`);
    return route[1]();
  }) as typeof fetch;
  return { impl, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  console.log("search");
  {
    const f = scripted([
      [(u) => u.endsWith("/contacts/search"), () => json(200, { total: 2, results: [{ id: "1", properties: {} }], paging: { next: { after: "100" } } })],
    ]);
    const page = await searchHubspotContacts("tok", { limit: 100 }, f.impl);
    check("posts to the dated search path", f.seen[0]?.url === "https://api.hubapi.com/crm/objects/2026-09/contacts/search" && f.seen[0]?.method === "POST", f.seen[0]?.url);
    check("with a bearer token", f.seen[0]?.headers.authorization === "Bearer tok");
    check("and a JSON body", f.seen[0]?.headers["content-type"] === "application/json" && f.seen[0]?.body === JSON.stringify({ limit: 100 }));
    check("reads results, total and the next offset", page.results.length === 1 && page.total === 2 && page.nextAfter === "100");
    const last = scripted([[(u) => u.endsWith("/contacts/search"), () => json(200, { total: 1, results: [] })]]);
    check("no paging.next is the last page", (await searchHubspotContacts("tok", {}, last.impl)).nextAfter === null);
  }

  console.log("\nthe error taxonomy");
  const fail = (status: number) => scripted([[() => true, () => json(status, { message: "nope" })]]).impl;
  const e401 = await caught(searchHubspotContacts("tok", {}, fail(401)));
  check("401 is the token", e401 instanceof ConnectorAuthError, String(e401));
  const e429 = await caught(searchHubspotContacts("tok", {}, fail(429)));
  check("429 is retryable rate limiting", e429 instanceof HubspotApiError && e429.kind === "rate_limited" && e429.retryable);
  const e403 = await caught(searchHubspotContacts("tok", {}, fail(403)));
  check("403 is a missing permission, not retryable", e403 instanceof HubspotApiError && e403.kind === "forbidden" && !e403.retryable);
  const e500 = await caught(searchHubspotContacts("tok", {}, fail(502)));
  check("5xx is retryable", e500 instanceof HubspotApiError && e500.kind === "server" && e500.retryable);
  const e400 = await caught(searchHubspotContacts("tok", {}, fail(400)));
  check("another 4xx is not retryable", e400 instanceof HubspotApiError && e400.kind === "bad_request" && !e400.retryable);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const eNet = await caught(searchHubspotContacts("tok", {}, down));
  check("a network failure is retryable", eNet instanceof HubspotApiError && eNet.kind === "network" && eNet.retryable);
  check("messages never end in a period", [e429, e403, e500, e400, eNet].every((e) => !(e as Error).message.endsWith(".")));

  console.log("\nintrospection");
  {
    const f = scripted([
      [(u) => u.endsWith("/oauth/2026-09/token/introspect"), () => json(200, { active: true, hub_id: 4242, hub_domain: "acme.hubspot.com", user_id: 9, user: "sam@acme.test", scopes: ["crm.objects.contacts.read"] })],
    ]);
    const info = await introspectHubspotToken("tok", f.impl);
    const form = new URLSearchParams(f.seen[0]?.body);
    check("posts a form to the dated introspection path", f.seen[0]?.url === "https://api.hubapi.com/oauth/2026-09/token/introspect" && f.seen[0]?.headers["content-type"] === "application/x-www-form-urlencoded");
    check("with the client credentials and the token", form.get("client_id") === "cid" && form.get("client_secret") === "csecret" && form.get("token") === "tok" && form.get("token_type_hint") === "access_token");
    check("and no bearer header", f.seen[0]?.headers.authorization === undefined);
    check("portal id as a string", info.hubId === "4242");
    check("user, domain and scopes", info.userId === "9" && info.userEmail === "sam@acme.test" && info.hubDomain === "acme.hubspot.com" && info.scopes.length === 1);
    const inactive = scripted([[() => true, () => json(200, { active: false })]]);
    check("an inactive token is the token", (await caught(introspectHubspotToken("tok", inactive.impl))) instanceof ConnectorAuthError);
  }

  console.log("\nthe owner");
  {
    const byId = scripted([[(u) => u.includes("/crm/owners/2026-09/9?idProperty=userId"), () => json(200, { id: "77", userId: 9 })]]);
    check("found by user id", (await findHubspotOwner("tok", { userId: "9", email: "sam@acme.test" }, byId.impl))?.id === "77");
    check("with a bearer token", byId.seen[0]?.headers.authorization === "Bearer tok");
    const byEmail = scripted([
      [(u) => u.includes("idProperty=userId"), () => json(404, { message: "not found" })],
      [(u) => u.includes("/crm/owners/2026-09?email="), () => json(200, { results: [{ id: 78 }] })],
    ]);
    check("falls back to the email", (await findHubspotOwner("tok", { userId: "9", email: "sam@acme.test" }, byEmail.impl))?.id === "78");
    check("the email is encoded", byEmail.seen[1]?.url.includes("email=sam%40acme.test") === true, byEmail.seen[1]?.url);
    const none = scripted([
      [(u) => u.includes("idProperty=userId"), () => json(404, {})],
      [(u) => u.includes("email="), () => json(200, { results: [] })],
    ]);
    check("nobody is null", (await findHubspotOwner("tok", { userId: "9", email: "x@y.test" }, none.impl)) === null);
    const boom = scripted([[() => true, () => json(500, {})]]);
    check("a 5xx is not mistaken for no owner", (await caught(findHubspotOwner("tok", { userId: "9", email: null }, boom.impl))) instanceof HubspotApiError);
  }

  console.log("\nrevoke");
  {
    const ok = scripted([[(u) => u.endsWith("/oauth/2026-09/token/revoke"), () => new Response("", { status: 200 })]]);
    check("a revoke that lands is true", (await revokeHubspotToken("refresh", ok.impl)) === true);
    const form = new URLSearchParams(ok.seen[0]?.body);
    check("revokes the refresh token with the client credentials", form.get("token") === "refresh" && form.get("token_type_hint") === "refresh_token" && form.get("client_id") === "cid");
    check("a revoke that fails is false, never a throw", (await revokeHubspotToken("refresh", down)) === false);
  }

  console.log("\nthe OAuth helper on HubSpot's dated token endpoint");
  {
    check("the token URL is dated", OAUTH_PROVIDERS.hubspot?.tokenUrl === "https://api.hubapi.com/oauth/2026-09/token");
    const f = scripted([
      [(u) => u.endsWith("/oauth/2026-09/token"), () => json(200, { token_type: "bearer", access_token: "a", refresh_token: "r", expires_in: 1800, hub_id: 4242, scopes: ["crm.objects.contacts.read", "crm.objects.owners.read", "oauth"] })],
    ]);
    const before = Date.now();
    const tokens = await exchangeCode("hubspot", "code-1", "https://app.example.com/api/connectors/hubspot/callback", { fetchImpl: f.impl });
    check("scopes arrive as an array and are joined", tokens.scopes === "crm.objects.contacts.read crm.objects.owners.read oauth", String(tokens.scopes));
    check("hub_id lands in extra, as a string", tokens.extra?.hub_id === "4242", JSON.stringify(tokens.extra));
    check("known fields stay out of extra", tokens.extra?.access_token === undefined && tokens.extra?.token_type === undefined);
    check("the 30-minute expiry is read", Math.abs((tokens.expiresAt?.getTime() ?? 0) - (before + 1_800_000)) < 5_000);
    check("configured when both env vars are set", isOAuthConfigured("hubspot"));
    delete process.env.HUBSPOT_CLIENT_SECRET;
    check("not configured without the secret", !isOAuthConfigured("hubspot"));
    check("an unknown connector is not configured", !isOAuthConfigured("nope"));
    process.env.HUBSPOT_CLIENT_SECRET = "csecret";
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll HubSpot API checks passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
