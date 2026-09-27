/**
 * Connecting a CRM: where the Leads page sends a person, and what the OAuth callback does with
 * the code that comes back. HubSpot and Salesforce — the route handler is a thin shell over
 * `completeCrmConnect`, so the part with the security properties runs in a smoke.
 */
import type { ConnectorSyncCursor } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { getConnectorConnection, upsertConnectorConnection } from "@/lib/connectors/connections";
import {
  buildAuthorizeUrl,
  exchangeCode,
  isTrustedInstanceUrl,
  OAUTH_PROVIDERS,
  pkceVerifierForState,
  type OAuthState,
  type OAuthTokens,
} from "@/lib/connectors/oauth";
import { introspectHubspotToken } from "@/lib/crm/hubspot/api";
import { HUBSPOT_SCOPES } from "@/lib/crm/hubspot/mapping";
import { deleteCrmRecordsForConnector } from "@/lib/crm/records";
import { fetchSalesforceIdentity } from "@/lib/crm/salesforce/api";
import { cursorFromProgress, progressFromCursor, SALESFORCE_SCOPES } from "@/lib/crm/salesforce/mapping";
import type { CrmConnectorId } from "@/lib/crm/types";

export { isCrmConnectorId, type CrmConnectorId } from "@/lib/crm/types";

const SCOPES: Record<CrmConnectorId, readonly string[]> = { hubspot: HUBSPOT_SCOPES, salesforce: SALESFORCE_SCOPES };
const REDIRECT_ENV: Record<CrmConnectorId, string> = { hubspot: "HUBSPOT_REDIRECT_URI", salesforce: "SALESFORCE_REDIRECT_URI" };

export function crmCallbackPath(id: CrmConnectorId): string {
  return `/api/connectors/${id}/callback`;
}

/** Exactly the URL registered on the provider's app: an explicit override, else the app's base URL. */
export function crmRedirectUri(id: CrmConnectorId): string {
  const override = process.env[REDIRECT_ENV[id]]?.trim();
  return override || new URL(crmCallbackPath(id), getAppBaseUrl()).href;
}

export function crmAuthorizeUrl(
  userId: string,
  id: CrmConnectorId,
  returnTo: string,
  opts: { sandbox?: boolean } = {}
): string {
  return buildAuthorizeUrl(id, {
    userId,
    redirectUri: crmRedirectUri(id),
    scopes: [...SCOPES[id]],
    returnTo,
    ...(id === "salesforce" && opts.sandbox ? { variant: "sandbox" } : {}),
  });
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

type CrmAccount = {
  accountRef: string;
  label: string | null;
  instanceUrl: string | null;
  /** Facts the first sync needs from the connect; null resets the cursor. */
  cursorSeed: ConnectorSyncCursor | null;
};

async function identifyCrmAccount(connectorId: CrmConnectorId, tokens: OAuthTokens, fetchImpl: typeof fetch): Promise<CrmAccount> {
  if (connectorId === "hubspot") {
    const info = await introspectHubspotToken(tokens.accessToken, fetchImpl);
    return { accountRef: info.hubId, label: info.hubDomain, instanceUrl: null, cursorSeed: null };
  }
  const rawInstanceUrl = tokens.extra?.instance_url;
  if (!isTrustedInstanceUrl("salesforce", rawInstanceUrl)) throw new Error("Salesforce named an org host Orbit doesn’t trust");
  // Only the origin: every call builds its path on it, so a stray path or slash never rides along.
  const instanceUrl = new URL(rawInstanceUrl).origin;
  const idUrl = tokens.extra?.id;
  if (!idUrl) throw new Error("Salesforce’s token named no identity URL");
  // fetchSalesforceIdentity refuses an untrusted identity host before sending the token.
  const who = await fetchSalesforceIdentity(tokens.accessToken, idUrl, fetchImpl);
  const identity = { orgId: who.orgId, userId: who.userId };
  return {
    accountRef: who.orgId,
    label: who.username ?? who.displayName,
    instanceUrl,
    // Ruling 9: identity is fixed at connect; the sync reads it from here and never guesses.
    cursorSeed: cursorFromProgress(progressFromCursor(null), identity),
  };
}

export async function completeCrmConnect(input: {
  sessionUserId: string;
  connectorId: CrmConnectorId;
  code: string;
  state: OAuthState;
  rawState: string;
  fetchImpl?: typeof fetch;
}): Promise<{ label: string | null; accountRef: string; switchedAccount: boolean }> {
  // The signature proves Orbit minted the state. Only this proves THIS person started the
  // flow — without it, an attacker's authorize URL finished by a victim attaches the victim's
  // HubSpot to the attacker's account.
  if (input.state.userId !== input.sessionUserId || input.state.connectorId !== input.connectorId) {
    throw new CrmConnectError("The sign-in doesn’t match who started it", "state_mismatch");
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  // PKCE: the verifier is recomputed from the state this callback was handed (see
  // `pkceVerifierForState`). A state that yields none was never Orbit's to begin with.
  let codeVerifier: string | undefined;
  if (OAUTH_PROVIDERS[input.connectorId]?.pkce) {
    const verifier = pkceVerifierForState(input.rawState);
    if (!verifier) throw new CrmConnectError("The sign-in doesn’t match who started it", "state_mismatch");
    codeVerifier = verifier;
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode(input.connectorId, input.code, crmRedirectUri(input.connectorId), {
      fetchImpl,
      codeVerifier,
      variant: input.state.variant,
    });
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "exchange_failed");
  }

  let account: CrmAccount;
  try {
    account = await identifyCrmAccount(input.connectorId, tokens, fetchImpl);
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "identify_failed");
  }

  const previous = await getConnectorConnection(input.sessionUserId, input.connectorId);
  const switchedAccount = Boolean(previous?.accountRef && previous.accountRef !== account.accountRef);
  // Records synced from another account describe someone else's CRM.
  if (switchedAccount) await deleteCrmRecordsForConnector(input.sessionUserId, input.connectorId);

  await upsertConnectorConnection({
    userId: input.sessionUserId,
    connectorId: input.connectorId,
    authKind: "oauth2",
    label: account.label,
    accountRef: account.accountRef,
    instanceUrl: account.instanceUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    capabilities: ["syncPeople"],
    // Armed now: HubSpot's sync ships in this same change (the rule on ConnectorManifest.sync).
    nextSyncAt: new Date(),
    // Every connect starts a fresh window: the cursor caches the owner of whoever connected
    // last, and this may be a different user in the same account. The next sync re-identifies
    // and re-reads everything, which the idempotent upsert makes safe. A provider's seed (from
    // its identity call, above) carries what the first sync needs instead of null. Written in
    // the upsert itself, never a second statement: a claim landing between the two would pair
    // the new grant with the old identity.
    syncCursor: account.cursorSeed,
  });
  return { label: account.label, accountRef: account.accountRef, switchedAccount };
}
