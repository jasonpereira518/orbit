/**
 * Salesforce's HTTP half: the error taxonomy the sync acts on, and the three calls it makes.
 * A stubbed fetch throughout. The invariant under test beyond shapes: no provider text in any
 * message, and no token sent to a host outside Salesforce's domains.
 *
 * Run: npx tsx scripts/smoke-salesforce-api.ts
 */
import { ConnectorAuthError } from "../src/lib/connectors/auth-errors";
import { SalesforceApiError, fetchSalesforceIdentity, querySalesforce, revokeSalesforceToken } from "../src/lib/crm/salesforce/api";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const INSTANCE = "https://acme.my.salesforce.com";
const calls: Array<{ url: string; init?: RequestInit }> = [];
function stub(status: number, body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const sfError = (errorCode: string, message = "SECRET PROVIDER TEXT") => [{ errorCode, message }];
async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; return null; } catch (err) { return err; }
}

async function main() {
  console.log("\nquery");
  const page = await querySalesforce("tok", INSTANCE, "SELECT Id FROM Contact", stub(200, { totalSize: 1, done: true, records: [{ Id: "003000000000001AAA" }] }));
  check("reads records", page.records.length === 1 && page.done);
  const q = new URL(calls.at(-1)!.url);
  check("on the org's host, v66.0", q.origin === INSTANCE && q.pathname === "/services/data/v66.0/query", q.href);
  check("with the SOQL as q", q.searchParams.get("q") === "SELECT Id FROM Contact");
  check("and a bearer token", new Headers(calls.at(-1)!.init?.headers).get("authorization") === "Bearer tok");

  const expired = await caught(querySalesforce("tok", INSTANCE, "q", stub(401, sfError("INVALID_SESSION_ID"))));
  check("401 is an auth error (refresh once)", expired instanceof ConnectorAuthError);
  const limit = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("REQUEST_LIMIT_EXCEEDED"))));
  check("the daily limit retries later", limit instanceof SalesforceApiError && limit.kind === "rate_limited" && limit.retryable);
  const off = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("API_DISABLED_FOR_ORG"))));
  check("API access off stops", off instanceof SalesforceApiError && off.kind === "api_disabled" && !off.retryable);
  const off2 = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("API_CURRENTLY_DISABLED"))));
  check("so does API_CURRENTLY_DISABLED", off2 instanceof SalesforceApiError && off2.kind === "api_disabled");
  const forbidden = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("INSUFFICIENT_ACCESS"))));
  check("another 403 stops as forbidden", forbidden instanceof SalesforceApiError && forbidden.kind === "forbidden" && !forbidden.retryable);
  const field = await caught(querySalesforce("tok", INSTANCE, "q", stub(400, sfError("INVALID_FIELD"))));
  check("INVALID_FIELD is its own kind", field instanceof SalesforceApiError && field.kind === "invalid_field" && !field.retryable);
  const malformed = await caught(querySalesforce("tok", INSTANCE, "q", stub(400, sfError("MALFORMED_QUERY"))));
  check("another 400 is a bad request", malformed instanceof SalesforceApiError && malformed.kind === "bad_request" && !malformed.retryable);
  const down = await caught(querySalesforce("tok", INSTANCE, "q", stub(503, "<html>down</html>")));
  check("5xx retries", down instanceof SalesforceApiError && down.kind === "server" && down.retryable);
  const net = await caught(querySalesforce("tok", INSTANCE, "q", (async () => { throw new TypeError("fetch failed: SECRET"); }) as typeof fetch));
  check("a network failure retries", net instanceof SalesforceApiError && net.kind === "network" && net.retryable);
  const errors = [expired, limit, off, forbidden, field, malformed, down, net];
  check("no provider text in any message", errors.every((e) => e instanceof Error && !e.message.includes("SECRET")), errors.map((e) => (e as Error).message).join(" | "));
  check("every message starts with Salesforce", errors.filter((e) => e instanceof SalesforceApiError).every((e) => (e as Error).message.startsWith("Salesforce ")));
  check("the detail is kept for the report", limit instanceof SalesforceApiError && (limit.detail ?? "").includes("REQUEST_LIMIT_EXCEEDED"));

  const before = calls.length;
  const evil = await caught(querySalesforce("tok", "https://evil.example", "q", stub(200, { records: [] })));
  check("an untrusted host is never sent the token", evil instanceof SalesforceApiError && evil.kind === "untrusted_host" && calls.length === before);

  console.log("\nidentity");
  const who = await fetchSalesforceIdentity("tok", "https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA", stub(200, {
    user_id: "005000000000001AAA", organization_id: "00D000000000001AAA", username: "ada@acme.com", display_name: "Ada Lovelace", email: "ada@acme.com",
  }));
  check("reads org and user", who.orgId === "00D000000000001AAA" && who.userId === "005000000000001AAA" && who.username === "ada@acme.com");
  check("with a bearer token", new Headers(calls.at(-1)!.init?.headers).get("authorization") === "Bearer tok");
  const nobody = await caught(fetchSalesforceIdentity("tok", "https://login.salesforce.com/id/x/y", stub(200, { username: "a" })));
  check("an identity without ids is refused", nobody instanceof SalesforceApiError && nobody.kind === "bad_request");
  const before2 = calls.length;
  const evilId = await caught(fetchSalesforceIdentity("tok", "https://evil.example/id/x/y", stub(200, {})));
  check("an untrusted identity URL is never called", evilId instanceof SalesforceApiError && calls.length === before2);

  console.log("\nrevoke");
  check("a 200 revokes", await revokeSalesforceToken(INSTANCE, "rt", stub(200, "")));
  const r = calls.at(-1)!;
  check("on the org's host, form-encoded", r.url === `${INSTANCE}/services/oauth2/revoke` && new URLSearchParams(String(r.init?.body)).get("token") === "rt");
  check("a 400 says no", !(await revokeSalesforceToken(INSTANCE, "rt", stub(400, { error: "unsupported_token_type" }))));
  check("a network failure says no", !(await revokeSalesforceToken(INSTANCE, "rt", (async () => { throw new Error("x"); }) as typeof fetch)));
  const before3 = calls.length;
  check("an untrusted host says no without a call", !(await revokeSalesforceToken("https://evil.example", "rt", stub(200, ""))) && calls.length === before3);

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Salesforce API checks passed.");
  process.exit(0);
}

void main();
