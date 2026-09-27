/**
 * A valid access token for every provider call a sync makes.
 *
 * Mirrors `getValidAccessToken` in `src/lib/gmail.ts` for the generic connector table:
 * refresh a token that is about to lapse BEFORE the call (proactive), refresh once more if the
 * provider refuses it anyway (reactive — clocks drift, tokens get revoked), and past that, or
 * when the provider refuses the refresh itself, mark the connection `needs_reauth` so the
 * person is told to reconnect instead of the scheduler retrying a dead grant for days.
 *
 * A retryable failure (the token endpoint timing out, a 5xx) is NOT a reason to reconnect: it
 * propagates unchanged so the scheduler backs off. That split is the whole point of
 * `OAuthTokenError.needsReauth`.
 *
 * Providers that never say when a token expires (Salesforce) have a null `tokenExpiresAt`, so
 * only the reactive half runs for them.
 */
import {
  markConnectorNeedsReauth,
  updateConnectorTokens,
  type ClaimedConnectorConnection,
} from "@/lib/connectors/connections";
import {
  OAuthTokenError,
  isTrustedInstanceUrl,
  refreshAccessToken,
  type OAuthTokens,
} from "@/lib/connectors/oauth";
import { ConnectorAuthError, ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";

export { ConnectorAuthError, ConnectorNeedsReauthError };

/** Refresh this long before the stored expiry, so a token never lapses mid-request. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export type ConnectorAuth = {
  /** Run one provider call with a valid token. */
  call<T>(fn: (accessToken: string) => Promise<T>): Promise<T>;
};

export type ConnectorAuthDeps = {
  now?: () => Date;
  refresh?: (connectorId: string, refreshToken: string, instanceUrl: string | null) => Promise<OAuthTokens>;
  persist?: typeof updateConnectorTokens;
  markNeedsReauth?: typeof markConnectorNeedsReauth;
};

const RECONNECT = "Reconnect to keep syncing";

export function openConnectorAuth(
  conn: ClaimedConnectorConnection,
  deps: ConnectorAuthDeps = {}
): ConnectorAuth {
  const now = deps.now ?? (() => new Date());
  const refresh =
    deps.refresh ??
    ((id: string, token: string, instanceUrl: string | null) => refreshAccessToken(id, token, { instanceUrl }));
  const persist = deps.persist ?? updateConnectorTokens;
  const markNeedsReauth = deps.markNeedsReauth ?? markConnectorNeedsReauth;
  let reactiveUsed = false;

  async function giveUp(reason: string): Promise<never> {
    await markNeedsReauth(conn.id, `${reason} — ${RECONNECT}`);
    throw new ConnectorNeedsReauthError(reason);
  }

  async function renew(reason: string): Promise<string> {
    if (!conn.refreshToken) return giveUp(reason);
    let tokens: OAuthTokens;
    try {
      tokens = await refresh(conn.connectorId, conn.refreshToken, conn.instanceUrl);
    } catch (err) {
      if (err instanceof OAuthTokenError && err.needsReauth) return giveUp(err.message);
      throw err;
    }
    // Salesforce names the org's host on every refresh; an org moved to a new instance says so here.
    const movedTo = tokens.extra?.instance_url;
    const instanceUrl =
      movedTo && movedTo !== conn.instanceUrl && isTrustedInstanceUrl(conn.connectorId, movedTo)
        ? movedTo
        : null;
    await persist(conn.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      instanceUrl,
    });
    conn.accessToken = tokens.accessToken;
    if (tokens.refreshToken) conn.refreshToken = tokens.refreshToken;
    conn.tokenExpiresAt = tokens.expiresAt;
    if (instanceUrl) conn.instanceUrl = instanceUrl;
    return tokens.accessToken;
  }

  async function current(): Promise<string> {
    if (!conn.accessToken) return renew("The stored access token is unreadable");
    const expires = conn.tokenExpiresAt?.getTime();
    if (expires !== undefined && expires - TOKEN_REFRESH_SKEW_MS <= now().getTime()) {
      return renew("The access token expired");
    }
    return conn.accessToken;
  }

  return {
    async call<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
      const token = await current();
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ConnectorAuthError)) throw err;
        if (reactiveUsed) return giveUp(err.message);
        reactiveUsed = true;
        const renewed = await renew(err.message);
        try {
          return await fn(renewed);
        } catch (again) {
          if (again instanceof ConnectorAuthError) return giveUp(again.message);
          throw again;
        }
      }
    },
  };
}
