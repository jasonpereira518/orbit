/**
 * HubSpot CRM connector: syncs contacts and engagements.
 *
 * Scopes: crm.objects.contacts.read, crm.objects.contacts.write, crm.schemas.contacts.read
 */
import {
  loadConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
  storeConnectorTokens,
} from "@/lib/connectors/connections";
import { refreshAccessToken, OAuthTokenError } from "@/lib/connectors/oauth";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { openIngestContext, finalizeIngest } from "@/lib/ingest/events";

const HUBSPOT_API = "https://api.hubapi.com";
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const PASS_BUDGET_MS = 90_000;

export class HubSpotReauthError extends Error {
  constructor(msg = "Reconnect HubSpot") {
    super(msg);
    this.name = "HubSpotReauthError";
  }
}

export async function freshHubSpotToken(
  conn: NonNullable<Awaited<ReturnType<typeof loadConnectorConnection>>>
): Promise<string> {
  if (!conn.accessToken) throw new HubSpotReauthError();
  const lapsing = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!lapsing) return conn.accessToken;
  if (!conn.refreshToken) throw new HubSpotReauthError();
  try {
    const t = await refreshAccessToken("hubspot", conn.refreshToken);
    await storeConnectorTokens(conn.id, {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenExpiresAt: t.expiresAt,
    });
    return t.accessToken;
  } catch (err) {
    if (err instanceof OAuthTokenError && err.needsReauth) {
      throw new HubSpotReauthError(err.message);
    }
    throw err;
  }
}

export async function hubspotRequest<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const url = `${HUBSPOT_API}${path}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 401) throw new HubSpotReauthError();
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; status?: string };
  if (!res.ok) {
    throw new Error(`HubSpot API ${path} returned ${res.status}: ${json.message ?? ""}`);
  }
  return json;
}

export async function syncHubSpot(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return;
  const started = Date.now();

  try {
    const token = await freshHubSpotToken(conn);

    if (conn.capabilities.includes("syncPeople")) {
      const ctx = await openIngestContext(conn.userId, { source: "hubspot", createsContacts: true });
      let after: string | undefined = conn.cursor?.hubspotContactsAfter ?? undefined;
      let more = false;

      do {
        const queryParams = new URLSearchParams({
          limit: "100",
          properties: "firstname,lastname,email,phone,company,jobtitle",
        });
        if (after) queryParams.set("after", after);

        const page = await hubspotRequest<{
          results: Array<{
            id: string;
            properties: Record<string, string | null>;
          }>;
          paging?: { next?: { after: string } };
        }>(token, `/crm/v3/objects/contacts?${queryParams.toString()}`);

        const people: PersonRecord[] = [];
        for (const c of page.results) {
          const first = c.properties.firstname?.trim();
          const last = c.properties.lastname?.trim();
          const fullName = [first, last].filter(Boolean).join(" ");
          if (fullName) {
            people.push({
              fullName,
              email: c.properties.email || null,
              phone: c.properties.phone || null,
              company: c.properties.company || null,
              title: c.properties.jobtitle || null,
            });
          }
        }

        if (people.length > 0) {
          await ingestPeople(ctx, people);
        }

        after = page.paging?.next?.after;
        if (after && Date.now() - started > PASS_BUDGET_MS) {
          more = true;
          break;
        }
      } while (after);

      await finalizeIngest(ctx, { recalibrate: !conn.cursor?.syncedThrough });

      await markConnectorSyncResult(connectionId, {
        ok: true,
        cursor: {
          ...conn.cursor,
          hubspotContactsAfter: more ? after : null,
          syncedThrough: new Date().toISOString(),
        },
        ...(more ? { nextSyncAt: new Date() } : {}),
      });
    } else {
      await markConnectorSyncResult(connectionId, { ok: true, cursor: conn.cursor });
    }
  } catch (err) {
    if (err instanceof HubSpotReauthError) {
      await markConnectorNeedsReauth(connectionId, err.message);
      return;
    }
    throw err;
  }
}
