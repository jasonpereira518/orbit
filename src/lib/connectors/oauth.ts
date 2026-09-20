/**
 * One OAuth2 implementation for every connector that uses it.
 *
 * Google and Microsoft keep their own modules (`gmail.ts`, `outlook.ts`) — they predate this
 * and their quirks are load-bearing. Everything new goes through here, so a new provider is
 * a `OAUTH_PROVIDERS` entry rather than another copy of the same 200 lines.
 *
 * Pure enough to test: every network call takes an injectable `fetchImpl`, and nothing here
 * touches the database. The caller persists the result through
 * `upsertConnectorConnection`.
 */
import { createHmac, timingSafeEqual } from "crypto";

export type OAuthProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra authorize-time parameters a provider demands. */
  extraAuthParams?: Record<string, string>;
};

/**
 * One entry per OAuth2 connector. The two env names are read at call time, never at module
 * load, so an unconfigured provider is a clear runtime error rather than a boot failure.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  hubspot: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  },
  notion: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
    extraAuthParams: { owner: "user" },
  },
};

/** A token-level rejection. `needsReauth` means retrying will never help. */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly needsReauth: boolean
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

export type OAuthState = {
  userId: string;
  connectorId: string;
  /** Always an app-relative path — see `safeReturnTo`. */
  returnTo: string;
};

function stateSecret(): string {
  return process.env.ENCRYPTION_SECRET ?? "orbit-dev-secret-change-me-in-prod";
}

/**
 * Keep the return path app-relative.
 *
 * An absolute URL in `state` is an open redirect: the provider hands it straight back and
 * the callback would forward the user to it after a successful sign-in. `//host/path` is the
 * same attack wearing a disguise — browsers resolve a protocol-relative URL against the
 * current scheme, so `//evil.example` becomes `https://evil.example`.
 */
function safeReturnTo(value: string | undefined | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

export function signOAuthState(state: OAuthState): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, returnTo: safeReturnTo(state.returnTo) })
  ).toString("base64url");
  const mac = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function parseOAuthState(raw: string): OAuthState | null {
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a buffer-length mismatch rather than returning false, so an
  // attacker-controlled mac of the "wrong" length must be caught before it ever reaches
  // that call, not after.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!parsed.userId || !parsed.connectorId) return null;
    return { ...parsed, returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

function providerOrThrow(connectorId: string): OAuthProviderConfig {
  const provider = OAUTH_PROVIDERS[connectorId];
  if (!provider) throw new Error(`No OAuth config for connector "${connectorId}"`);
  return provider;
}

function clientCredentials(provider: OAuthProviderConfig): { id: string; secret: string } {
  const id = process.env[provider.clientIdEnv];
  const secret = process.env[provider.clientSecretEnv];
  if (!id || !secret) {
    throw new Error(`${provider.clientIdEnv} / ${provider.clientSecretEnv} are not configured`);
  }
  return { id, secret };
}

export function buildAuthorizeUrl(
  connectorId: string,
  opts: { userId: string; redirectUri: string; scopes: string[]; returnTo: string }
): string {
  const provider = providerOrThrow(connectorId);
  const { id } = clientCredentials(provider);
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set(
    "state",
    signOAuthState({ userId: opts.userId, connectorId, returnTo: opts.returnTo })
  );
  for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(
  provider: OAuthProviderConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // 4xx means the grant itself is bad; 5xx is the provider having a bad day and is worth
    // retrying, which is exactly the retryable/needs-reauth split the scheduler acts on.
    const needsReauth = res.status >= 400 && res.status < 500;
    throw new OAuthTokenError(
      json.error_description ?? json.error ?? `Token endpoint returned ${res.status}`,
      needsReauth
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scopes: json.scope ?? null,
  };
}

export async function exchangeCode(
  connectorId: string,
  code: string,
  redirectUri: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  return postToken(
    provider,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      client_secret: secret,
    }),
    opts.fetchImpl ?? fetch
  );
}

export async function refreshAccessToken(
  connectorId: string,
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  return postToken(
    provider,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
    }),
    opts.fetchImpl ?? fetch
  );
}
