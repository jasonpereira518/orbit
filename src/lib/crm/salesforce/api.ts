/**
 * Salesforce's HTTP half: one request path with the error taxonomy the sync acts on, and the
 * three calls P5 makes. Every call takes `fetchImpl`, so no smoke reaches the network, and
 * every call checks its host first — `instance_url` and the identity URL come from a token
 * response, and a bearer token only ever goes to Salesforce's own domains.
 *
 * A 401 becomes `ConnectorAuthError` and nothing else does: Salesforce never says when a token
 * expires, so `openConnectorAuth`'s reactive refresh is the only one that runs.
 *
 * Messages are sentences Orbit wrote; Salesforce's own text rides on `.detail` for the error
 * report and never reaches `sync_error` or a toast.
 */
import { ConnectorAuthError } from "@/lib/connectors/auth-errors";
import { SALESFORCE_API_VERSION, isTrustedSalesforceUrl, type SalesforceRecord } from "./mapping";

export type SalesforceErrorKind =
  | "rate_limited"
  | "api_disabled"
  | "forbidden"
  | "invalid_field"
  | "bad_request"
  | "not_found"
  | "server"
  | "network"
  | "untrusted_host";

export class SalesforceApiError extends Error {
  constructor(
    message: string,
    readonly kind: SalesforceErrorKind,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly detail: string | null = null
  ) {
    super(message);
    this.name = "SalesforceApiError";
  }
}

const TIMEOUT_MS = 15_000;

const UNTRUSTED = "Salesforce named a server Orbit doesn’t trust — reconnect Salesforce";

async function send(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = TIMEOUT_MS): Promise<Response> {
  if (!isTrustedSalesforceUrl(url)) throw new SalesforceApiError(UNTRUSTED, "untrusted_host", null, false, String(url).slice(0, 200));
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SalesforceApiError("Salesforce didn’t answer — the next sync will try again", "network", null, true, detail.slice(0, 300));
  }
}

/** Salesforce's REST errors are an array of `{ errorCode, message }`. */
function errorCodeOf(body: unknown): { code: string; detail: string } {
  const first = Array.isArray(body) ? (body[0] as { errorCode?: unknown; message?: unknown } | undefined) : undefined;
  const code = typeof first?.errorCode === "string" ? first.errorCode : "";
  const message = typeof first?.message === "string" ? first.message : "";
  return { code, detail: `${code}${message ? `: ${message}` : ""}`.slice(0, 300) };
}

function failure(status: number, body: unknown): Error {
  const { code, detail } = errorCodeOf(body);
  if (status === 401) return new ConnectorAuthError("Salesforce refused the access token");
  if (code === "REQUEST_LIMIT_EXCEEDED") {
    return new SalesforceApiError("Salesforce says your org’s daily API allowance is used up — the next sync picks up where this one stopped", "rate_limited", status, true, detail);
  }
  if (code === "API_DISABLED_FOR_ORG" || code === "API_CURRENTLY_DISABLED") {
    return new SalesforceApiError("Salesforce says API access is off for your user — ask a Salesforce admin to turn on API Enabled, then sync again", "api_disabled", status, false, detail);
  }
  if (status === 403) {
    return new SalesforceApiError("Salesforce says this connection can’t read your contacts and leads — ask a Salesforce admin for read access, then sync again", "forbidden", status, false, detail);
  }
  if (status === 404) return new SalesforceApiError("Salesforce couldn’t find what Orbit asked for — reconnect Salesforce", "not_found", status, false, detail);
  if (status >= 500) return new SalesforceApiError("Salesforce is having trouble — the next sync will try again", "server", status, true, detail);
  if (code === "INVALID_FIELD") {
    return new SalesforceApiError("Salesforce hides some contact fields from your user — Orbit will read the ones you can see", "invalid_field", status, false, detail);
  }
  return new SalesforceApiError("Salesforce turned down Orbit’s request — reconnect Salesforce, and tell us if it keeps happening", "bad_request", status, false, detail);
}

async function salesforceJson<T>(accessToken: string, url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await send(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, fetchImpl);
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw failure(res.status, json);
  return (json ?? {}) as T;
}

export type SalesforceIdentityInfo = {
  orgId: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
};

/** The identity URL from the token response: who connected, and in which org. */
export async function fetchSalesforceIdentity(accessToken: string, idUrl: string, fetchImpl: typeof fetch = fetch): Promise<SalesforceIdentityInfo> {
  const json = await salesforceJson<Record<string, unknown>>(accessToken, idUrl, fetchImpl);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const orgId = str(json.organization_id);
  const userId = str(json.user_id);
  if (!orgId || !userId) throw new SalesforceApiError("Salesforce didn’t say who connected — reconnect Salesforce", "bad_request", 200, false);
  return { orgId, userId, username: str(json.username), displayName: str(json.display_name), email: str(json.email) };
}

export type SalesforceQueryPage = { records: SalesforceRecord[]; done: boolean };

export async function querySalesforce(accessToken: string, instanceUrl: string, soql: string, fetchImpl: typeof fetch = fetch): Promise<SalesforceQueryPage> {
  let url: string;
  try {
    url = new URL(`/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`, instanceUrl).href;
  } catch {
    throw new SalesforceApiError(UNTRUSTED, "untrusted_host", null, false);
  }
  const json = await salesforceJson<{ records?: unknown; done?: unknown }>(accessToken, url, fetchImpl);
  const records = Array.isArray(json.records) ? (json.records as SalesforceRecord[]) : [];
  return { records, done: json.done !== false };
}

/** Best effort and time-boxed: a Salesforce outage must never block a disconnect. */
export async function revokeSalesforceToken(instanceUrl: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await send(
      new URL("/services/oauth2/revoke", instanceUrl).href,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }) },
      fetchImpl,
      5_000
    );
    return res.ok;
  } catch {
    return false;
  }
}
