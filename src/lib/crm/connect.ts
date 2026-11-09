/**
 * Connecting a CRM: where the Leads page sends a person, and what the OAuth callback does with
 * the code that comes back. The route handler is a thin shell over `completeCrmConnect`, so the
 * part with the security properties runs in a smoke.
 */
import { getAppBaseUrl } from "@/lib/app-url";
import { getConnectorConnection, resetConnectorCursor, upsertConnectorConnection } from "@/lib/connectors/connections";
import { buildAuthorizeUrl, exchangeCode, type OAuthState } from "@/lib/connectors/oauth";
import { introspectHubspotToken } from "@/lib/crm/hubspot/api";
import { HUBSPOT_SCOPES } from "@/lib/crm/hubspot/mapping";
import { deleteCrmRecordsForConnector } from "@/lib/crm/records";

export type CrmConnectorId = "hubspot";

export function isCrmConnectorId(id: string): id is CrmConnectorId {
  return id === "hubspot";
}

const SCOPES: Record<CrmConnectorId, readonly string[]> = { hubspot: HUBSPOT_SCOPES };
const REDIRECT_ENV: Record<CrmConnectorId, string> = { hubspot: "HUBSPOT_REDIRECT_URI" };

export function crmCallbackPath(id: CrmConnectorId): string {
  return `/api/connectors/${id}/callback`;
}

/** Exactly the URL registered on the provider's app: an explicit override, else the app's base URL. */
export function crmRedirectUri(id: CrmConnectorId): string {
  const override = process.env[REDIRECT_ENV[id]]?.trim();
  return override || new URL(crmCallbackPath(id), getAppBaseUrl()).href;
}

export function crmAuthorizeUrl(userId: string, id: CrmConnectorId, returnTo: string): string {
  return buildAuthorizeUrl(id, { userId, redirectUri: crmRedirectUri(id), scopes: [...SCOPES[id]], returnTo });
}

export class CrmConnectError extends Error {
  constructor(
    message: string,
    readonly kind: "state_mismatch" | "exchange_failed" | "identify_failed"
  ) {
    super(message);
    this.name = "CrmConnectError";
  }
}

export async function completeCrmConnect(input: {
  sessionUserId: string;
  connectorId: CrmConnectorId;
  code: string;
  state: OAuthState;
  fetchImpl?: typeof fetch;
}): Promise<{ label: string | null; accountRef: string; switchedAccount: boolean }> {
  // The signature proves Orbit minted the state. Only this proves THIS person started the
  // flow — without it, an attacker's authorize URL finished by a victim attaches the victim's
  // HubSpot to the attacker's account.
  if (input.state.userId !== input.sessionUserId || input.state.connectorId !== input.connectorId) {
    throw new CrmConnectError("The sign-in doesn’t match who started it", "state_mismatch");
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(input.connectorId, input.code, crmRedirectUri(input.connectorId), { fetchImpl });
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "exchange_failed");
  }

  let info: Awaited<ReturnType<typeof introspectHubspotToken>>;
  try {
    info = await introspectHubspotToken(tokens.accessToken, fetchImpl);
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "identify_failed");
  }

  const previous = await getConnectorConnection(input.sessionUserId, input.connectorId);
  const switchedAccount = Boolean(previous?.accountRef && previous.accountRef !== info.hubId);
  // Records synced from another HubSpot account describe someone else's CRM.
  if (switchedAccount) await deleteCrmRecordsForConnector(input.sessionUserId, input.connectorId);

  await upsertConnectorConnection({
    userId: input.sessionUserId,
    connectorId: input.connectorId,
    authKind: "oauth2",
    label: info.hubDomain,
    accountRef: info.hubId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    capabilities: ["syncPeople"],
    // Armed now: HubSpot's sync ships in this same change (the rule on ConnectorManifest.sync).
    nextSyncAt: new Date(),
  });
  // Every connect starts a fresh window: the cursor caches the owner of whoever connected
  // last, and this may be a different HubSpot user in the same portal. The next sync
  // re-identifies and re-reads everything, which the idempotent upsert makes safe.
  await resetConnectorCursor(input.sessionUserId, input.connectorId);
  return { label: info.hubDomain, accountRef: info.hubId, switchedAccount };
}
