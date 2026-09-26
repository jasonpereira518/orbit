/**
 * HubSpot's HTTP half: one request path with the error taxonomy the sync acts on, and the
 * four calls P4 makes. Every call takes `fetchImpl`, so no smoke reaches the network.
 *
 * A 401 becomes `ConnectorAuthError` and nothing else does: `openConnectorAuth` refreshes once
 * on it. HubSpot's own guidance is to refresh on `expires_in` rather than trust a 401, which
 * is what the proactive half of `openConnectorAuth` does — the reactive half is the net.
 */
import { ConnectorAuthError } from "@/lib/connectors/auth-errors";
import { oauthClientCredentials } from "@/lib/connectors/oauth";
import { HUBSPOT_API_BASE, HUBSPOT_API_VERSION, type HubspotContactResult } from "./mapping";

export type HubspotErrorKind = "rate_limited" | "forbidden" | "not_found" | "bad_request" | "server" | "network";

export class HubspotApiError extends Error {
  constructor(
    message: string,
    readonly kind: HubspotErrorKind,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "HubspotApiError";
  }
}

const TIMEOUT_MS = 15_000;
const V = HUBSPOT_API_VERSION;

async function send(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HubspotApiError(`HubSpot didn’t answer — ${detail}`.slice(0, 300), "network", null, true);
  }
}

function failure(status: number, body: { message?: unknown }): Error {
  const detail = typeof body.message === "string" ? body.message.slice(0, 200).replace(/\.$/, "") : "";
  if (status === 401) return new ConnectorAuthError(`HubSpot refused the access token${detail ? ` — ${detail}` : ""}`);
  if (status === 429) {
    return new HubspotApiError("HubSpot is rate-limiting this account — the next sync picks up where this one stopped", "rate_limited", 429, true);
  }
  if (status === 403) {
    return new HubspotApiError("HubSpot says this connection can’t read contacts or owners — reconnect HubSpot and approve every permission", "forbidden", 403, false);
  }
  if (status === 404) return new HubspotApiError(`HubSpot couldn’t find that${detail ? ` — ${detail}` : ""}`, "not_found", 404, false);
  if (status >= 500) return new HubspotApiError(`HubSpot returned ${status} — the next sync will try again`, "server", status, true);
  return new HubspotApiError(`HubSpot rejected the request (${status})${detail ? ` — ${detail}` : ""}`, "bad_request", status, false);
}

async function hubspotJson<T>(
  accessToken: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  fetchImpl: typeof fetch
): Promise<T> {
  const res = await send(
    `${HUBSPOT_API_BASE}${path}`,
    {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
    fetchImpl
  );
  const json = (await res.json().catch(() => ({}))) as { message?: unknown };
  if (!res.ok) throw failure(res.status, json);
  return json as T;
}

function oauthForm(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

export type HubspotTokenInfo = {
  hubId: string;
  hubDomain: string | null;
  userId: string | null;
  userEmail: string | null;
  scopes: string[];
};

export async function introspectHubspotToken(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<HubspotTokenInfo> {
  const { id, secret } = oauthClientCredentials("hubspot");
  const res = await send(
    `${HUBSPOT_API_BASE}/oauth/${V}/token/introspect`,
    oauthForm({ client_id: id, client_secret: secret, token: accessToken, token_type_hint: "access_token" }),
    fetchImpl
  );
  const json = (await res.json().catch(() => ({}))) as {
    active?: boolean;
    hub_id?: string | number;
    hub_domain?: string;
    user_id?: string | number;
    user?: string;
    scopes?: unknown;
    message?: unknown;
  };
  if (!res.ok) throw failure(res.status, json);
  if (json.active === false) throw new ConnectorAuthError("HubSpot says this access token is no longer active");
  if (json.hub_id === undefined || json.hub_id === null) {
    throw new HubspotApiError("HubSpot’s token details named no account", "bad_request", res.status, false);
  }
  return {
    hubId: String(json.hub_id),
    hubDomain: typeof json.hub_domain === "string" ? json.hub_domain : null,
    userId: json.user_id === undefined || json.user_id === null ? null : String(json.user_id),
    userEmail: typeof json.user === "string" ? json.user : null,
    scopes: Array.isArray(json.scopes) ? json.scopes.filter((s): s is string => typeof s === "string") : [],
  };
}

/** The owner record for the person who connected — its `id` is what contacts are filtered on. */
export async function findHubspotOwner(
  accessToken: string,
  who: { userId: string | null; email: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string } | null> {
  if (who.userId) {
    try {
      const owner = await hubspotJson<{ id?: string | number | null }>(
        accessToken,
        `/crm/owners/${V}/${encodeURIComponent(who.userId)}?idProperty=userId`,
        { method: "GET" },
        fetchImpl
      );
      if (owner.id !== undefined && owner.id !== null) return { id: String(owner.id) };
    } catch (err) {
      if (!(err instanceof HubspotApiError && err.kind === "not_found")) throw err;
    }
  }
  if (who.email) {
    const list = await hubspotJson<{ results?: Array<{ id?: string | number | null }> }>(
      accessToken,
      `/crm/owners/${V}?email=${encodeURIComponent(who.email)}&limit=1`,
      { method: "GET" },
      fetchImpl
    );
    const first = list.results?.[0];
    if (first?.id !== undefined && first.id !== null) return { id: String(first.id) };
  }
  return null;
}

export type HubspotSearchPage = { total: number; results: HubspotContactResult[]; nextAfter: string | null };

export async function searchHubspotContacts(
  accessToken: string,
  body: object,
  fetchImpl: typeof fetch = fetch
): Promise<HubspotSearchPage> {
  const json = await hubspotJson<{
    total?: number;
    results?: HubspotContactResult[];
    paging?: { next?: { after?: string } };
  }>(accessToken, `/crm/objects/${V}/contacts/search`, { method: "POST", body }, fetchImpl);
  return {
    total: typeof json.total === "number" ? json.total : 0,
    results: Array.isArray(json.results) ? json.results : [],
    nextAfter: json.paging?.next?.after ?? null,
  };
}

/** Best effort and time-boxed: a HubSpot outage must never block a disconnect. */
export async function revokeHubspotToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const { id, secret } = oauthClientCredentials("hubspot");
    const res = await send(
      `${HUBSPOT_API_BASE}/oauth/${V}/token/revoke`,
      oauthForm({ client_id: id, client_secret: secret, token: refreshToken, token_type_hint: "refresh_token" }),
      fetchImpl,
      5_000
    );
    return res.ok;
  } catch {
    return false;
  }
}
