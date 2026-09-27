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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { safeReturnPath } from "@/lib/safe-return-path";
import { isTrustedSalesforceUrl } from "@/lib/crm/salesforce/mapping";

export type OAuthProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra authorize-time parameters a provider demands. */
  extraAuthParams?: Record<string, string>;
  /**
   * RFC 7636 S256. The verifier is never stored: it is derived from the state's nonce with a
   * server-only key (`pkceVerifierForState`), so the callback recomputes it from the state it
   * is handed and an observer of the authorize URL cannot.
   */
  pkce?: boolean;
  /** Alternate login hosts, chosen by a signed `OAuthState.variant` (Salesforce's sandbox). */
  variants?: Record<string, { authorizeUrl: string; tokenUrl: string }>;
  /** For providers whose token endpoint lives on the account's own host: the path on it. */
  instanceTokenPath?: string;
  /** Which account hosts may be sent this provider's tokens. Absent = none. */
  trustInstanceUrl?: (url: string) => boolean;
};

/**
 * One entry per OAuth2 connector. The two env names are read at call time, never at module
 * load, so an unconfigured provider is a clear runtime error rather than a boot failure.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  hubspot: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    // HubSpot's dated OAuth API; the undated v1 endpoints stop working on 2027-02-16.
    tokenUrl: "https://api.hubapi.com/oauth/2026-09/token",
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  },
  salesforce: {
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    clientIdEnv: "SALESFORCE_CLIENT_ID",
    clientSecretEnv: "SALESFORCE_CLIENT_SECRET",
    // External Client Apps are created with "Require PKCE" on; the web server flow still
    // sends the secret too ("Require Secret for Web Server Flow").
    pkce: true,
    variants: {
      sandbox: {
        authorizeUrl: "https://test.salesforce.com/services/oauth2/authorize",
        tokenUrl: "https://test.salesforce.com/services/oauth2/token",
      },
    },
    // The org's My Domain answers refreshes for production and sandboxes alike.
    instanceTokenPath: "/services/oauth2/token",
    trustInstanceUrl: isTrustedSalesforceUrl,
  },
  // Notion is deliberately NOT wired up here. Its token endpoint requires HTTP Basic
  // client-credential auth plus a JSON request body, and returns neither `refresh_token`
  // nor `expires_in` — none of which `postToken`'s form-encoded-body-with-secret-in-the-body
  // shape can produce. Whoever ships the Notion connector adds `tokenAuth`/`tokenBody` knobs
  // to `OAuthProviderConfig` and a second `postToken` code path then; building that ahead of
  // a real caller is just unused surface area today.
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

/**
 * The signature on a signed state proves it was minted by Orbit and has not been tampered
 * with, and — via its embedded `iat` — that it is still fresh. It proves NOTHING about who is
 * presenting it back at the callback.
 *
 * Concretely: an attacker can run the ordinary connect flow under their OWN account and
 * obtain a validly-signed state naming their own `userId`, then hand the resulting authorize
 * URL to a victim. If the victim completes the provider's consent screen, the callback would
 * be handed a perfectly valid, unexpired, correctly-signed state whose `userId` names the
 * attacker — and the victim's grant would land on the attacker's account.
 *
 * The callback route MUST compare `state.userId` against the caller's own authenticated
 * session and reject a mismatch. Never attach the returned grant to `state.userId` on trust
 * alone — that is the one property a signature over `state` cannot provide by itself.
 *
 * The `nonce` in `SignedStatePayload` makes each minted state UNIQUE; it does not make it
 * single-use. Nothing is recorded server-side at signing time and nothing is consumed at the
 * callback, so a state that leaks — out of a referrer, a proxy log, a shared screenshot of
 * the authorize URL — stays replayable for the whole 30-minute TTL. That is tolerable only
 * because the userId comparison above is what actually authorizes the attach; if a callback
 * ever starts trusting `state` for anything the session cannot confirm, the nonce has to
 * become a recorded, consumed-on-use value (a row, or a signed cookie set at sign time) and
 * this comment is the reason.
 */
export type OAuthState = {
  userId: string;
  connectorId: string;
  /** Always an app-relative path — see `safeReturnTo`. */
  returnTo: string;
  /** A provider's alternate login host (`OAuthProviderConfig.variants`). Signed like the rest. */
  variant?: string;
};

/** What actually gets signed: `OAuthState` plus the replay defenses described below. */
type SignedStatePayload = OAuthState & {
  /**
   * Defeats state replay. Without this, `signOAuthState` is deterministic for identical
   * inputs, so one valid state is valid forever and reusable by anyone who obtains it —
   * including across the account-attach scenario documented on `OAuthState`.
   */
  nonce: string;
  /** Unix ms the state was issued, checked against `OAUTH_STATE_TTL_MS` on parse. */
  iat: number;
  variant?: string;
};

/**
 * How long a signed state is honored after issuance.
 *
 * A real OAuth consent screen can legitimately sit open for a while — a provider's own MFA
 * step, an account picker, someone getting pulled away mid-flow — so this has to be
 * generous. 30 minutes covers that without leaving a leaked or forwarded authorize URL
 * exploitable indefinitely, which is what a state with no expiry at all would mean.
 */
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ENCRYPTION_SECRET must be set in production — refusing to sign OAuth state with a default key."
      );
    }
    return "orbit-dev-secret-change-me-in-prod";
  }
  return secret;
}

/**
 * Domain separation for the state signature.
 *
 * `ENCRYPTION_SECRET` is the app's one long-lived key: `src/lib/crypto.ts` encrypts stored
 * credentials with it, and anything else that needs a MAC would reach for it too. Signing
 * `state` with the raw key means two unrelated purposes share one signing oracle — a payload
 * that happens to be valid for both would carry a signature valid for both. Deriving a
 * per-purpose subkey costs one HMAC and makes that unrepresentable.
 *
 * The label is part of the signature, so changing it invalidates every state in flight (30
 * minutes' worth). Version it rather than editing it.
 */
const STATE_HMAC_LABEL = "orbit:connector-oauth-state:v1";

function stateKey(): Buffer {
  return createHmac("sha256", stateSecret()).update(STATE_HMAC_LABEL).digest();
}

/**
 * Keep the return path app-relative.
 *
 * An absolute URL in `state` is an open redirect: the provider hands it straight back and
 * the callback would forward the user to it after a successful sign-in. The check has to
 * survive not just an absolute URL but everything `new URL(value, origin)` can fold into one
 * — which is exactly how both existing OAuth callbacks (`gmail`/`outlook`) resolve a return
 * path — because that resolution happens downstream of this function, not inside it:
 *
 *   - `//evil.example` is a protocol-relative network-path reference: WHATWG URL parsing
 *     treats a value starting with two slash-or-backslash characters as a fresh authority.
 *   - `/\evil.example` and `/\/evil.example` reach the same state, because for a special
 *     scheme (http/https) the parser folds backslash to forward slash throughout — a leading
 *     "/\" is exactly as much a network-path reference as "//".
 *   - `/\t/evil.example` and `/\n/evil.example` reach it too: the URL spec strips every
 *     ASCII tab and newline from the whole input before parsing anything else, so the tab
 *     disappears and the remaining characters collapse into "//evil.example".
 *
 * Hence the shared `safeReturnPath`, which the Gmail and Outlook OAuth starts and the
 * feedback path all use: the first two characters can never both be slash-or-backslash, no
 * backslash may appear anywhere, and no control character may either. A third copy of that
 * reasoning is a third thing to drift.
 *
 * The `/settings` fallback stays here. A redirect has to go somewhere, which is the one
 * decision the shared guard declines to make — the feedback path wants null for the same
 * input, so it can record that it has no route rather than invent one.
 */
function safeReturnTo(value: string | undefined | null): string {
  return safeReturnPath(value) ?? "/settings";
}

function mintState(state: OAuthState): { raw: string; nonce: string } {
  const payload: SignedStatePayload = {
    userId: state.userId,
    connectorId: state.connectorId,
    returnTo: safeReturnTo(state.returnTo),
    ...(state.variant ? { variant: state.variant } : {}),
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(encoded).digest("base64url");
  return { raw: `${encoded}.${mac}`, nonce: payload.nonce };
}

export function signOAuthState(state: OAuthState): string {
  return mintState(state).raw;
}

/**
 * Verifies the signature, checks freshness, and sanitizes — independent of whatever
 * `signOAuthState` already did on the way in, since this is what actually protects the
 * callback: it runs on whatever a validly-signed payload contains, not on whatever this
 * module happened to sign most recently. Returns the raw payload (including `nonce`), which
 * `parseOAuthState` trims down and `pkceVerifierForState` uses directly.
 */
function readSignedState(raw: string | null | undefined): SignedStatePayload | null {
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a buffer-length mismatch rather than returning false, so an
  // attacker-controlled mac of the "wrong" length must be caught before it ever reaches
  // that call, not after.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as Partial<SignedStatePayload>;
    if (!parsed.userId || !parsed.connectorId || !parsed.nonce) return null;
    if (typeof parsed.iat !== "number" || Date.now() - parsed.iat > OAUTH_STATE_TTL_MS) {
      return null;
    }
    return {
      userId: parsed.userId,
      connectorId: parsed.connectorId,
      returnTo: safeReturnTo(parsed.returnTo),
      ...(typeof parsed.variant === "string" && /^[a-z]{1,32}$/.test(parsed.variant)
        ? { variant: parsed.variant }
        : {}),
      nonce: parsed.nonce,
      iat: parsed.iat,
    };
  } catch {
    return null;
  }
}

export function parseOAuthState(raw: string | null | undefined): OAuthState | null {
  const payload = readSignedState(raw);
  if (!payload) return null;
  return {
    userId: payload.userId,
    connectorId: payload.connectorId,
    returnTo: payload.returnTo,
    ...(payload.variant ? { variant: payload.variant } : {}),
  };
}

/**
 * Its own label, never the state key: see STATE_HMAC_LABEL on why purposes don't share a key.
 */
const PKCE_HMAC_LABEL = "orbit:connector-oauth-pkce:v1";

function pkceVerifierForNonce(nonce: string): string {
  const key = createHmac("sha256", stateSecret()).update(PKCE_HMAC_LABEL).digest();
  // 32 bytes → 43 base64url characters: inside RFC 7636's 43–128 and its unreserved alphabet.
  return createHmac("sha256", key).update(nonce).digest("base64url");
}

/** The PKCE verifier for a state this server signed — null when the state is invalid or expired. */
export function pkceVerifierForState(raw: string | null | undefined): string | null {
  const payload = readSignedState(raw);
  return payload ? pkceVerifierForNonce(payload.nonce) : null;
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

/** The app's client id and secret, read at call time. Throws when either is missing. */
export function oauthClientCredentials(connectorId: string): { id: string; secret: string } {
  return clientCredentials(providerOrThrow(connectorId));
}

/** Whether this server can run the connector's OAuth flow at all — for the UI, never a throw. */
export function isOAuthConfigured(connectorId: string): boolean {
  const provider = OAUTH_PROVIDERS[connectorId];
  if (!provider) return false;
  return Boolean(process.env[provider.clientIdEnv]?.trim() && process.env[provider.clientSecretEnv]?.trim());
}

function variantOrThrow(
  connectorId: string,
  provider: OAuthProviderConfig,
  variant: string | undefined
): { authorizeUrl: string; tokenUrl: string } {
  if (!variant) return { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl };
  const hosts = provider.variants?.[variant];
  if (!hosts) throw new Error(`Connector "${connectorId}" has no "${variant}" login host`);
  return hosts;
}

export function buildAuthorizeUrl(
  connectorId: string,
  opts: { userId: string; redirectUri: string; scopes: string[]; returnTo: string; variant?: string }
): string {
  const provider = providerOrThrow(connectorId);
  const { id } = clientCredentials(provider);
  const host = variantOrThrow(connectorId, provider, opts.variant);
  const url = new URL(host.authorizeUrl);
  // Applied first, not last: a provider's `extraAuthParams` must never be able to silently
  // overwrite a parameter we control. `URLSearchParams.set` replaces any existing value at
  // that key, so whichever of `client_id`/`redirect_uri`/`response_type`/`scope`/`state` we
  // set below always wins over a same-named entry a config accidentally or maliciously adds.
  for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  const state = mintState({
    userId: opts.userId,
    connectorId,
    returnTo: opts.returnTo,
    ...(opts.variant ? { variant: opts.variant } : {}),
  });
  url.searchParams.set("state", state.raw);
  if (provider.pkce) {
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(pkceVerifierForNonce(state.nonce)).digest("base64url")
    );
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  /**
   * Every other scalar field of the token response, as strings — HubSpot's `hub_id` is the
   * one P4 reads. Optional so a hand-built token (a refresh stub in a smoke) need not carry it.
   */
  extra?: Record<string, string>;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** RFC 6749's space-separated string. */
  scope?: string;
  /** HubSpot's array instead. */
  scopes?: unknown;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
};

const KNOWN_TOKEN_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "expires_in",
  "scope",
  "scopes",
  "token_type",
  "id_token",
  "error",
  "error_description",
]);

/** Caps how much of a provider's error text we fold into an Error message. */
function truncateProviderMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

async function postToken(
  tokenUrl: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // A rejected fetch (DNS/TCP/TLS failure) and the 15s timeout firing both land here as a
    // raw TypeError/DOMException, not an HTTP response. Neither says anything about the
    // grant — the provider or the network is having a bad moment — so this is exactly the
    // "5xx-shaped", retryable half of the split the scheduler acts on, never needs-reauth.
    const message =
      err instanceof Error ? err.message : "Network error contacting token endpoint";
    throw new OAuthTokenError(truncateProviderMessage(message), false);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // 4xx means the grant itself is bad; 5xx is the provider having a bad day and is worth
    // retrying, which is exactly the retryable/needs-reauth split the scheduler acts on. A
    // 2xx response with no access_token is neither — it's a provider deliberately sending a
    // malformed success envelope, and retrying that on a backoff ladder would just repeat
    // it forever, so it is treated as needs-reauth rather than retryable. 408 and 429 are
    // the two 4xx that say nothing about the grant — a timeout and throttling — so they
    // retry like a 5xx instead of costing the person a reconnect.
    const needsReauth = res.ok
      ? true
      : res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    const rawMessage = json.error_description ?? json.error ?? `Token endpoint returned ${res.status}`;
    throw new OAuthTokenError(truncateProviderMessage(rawMessage), needsReauth);
  }
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (KNOWN_TOKEN_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number") extra[key] = String(value);
  }
  const scopes =
    typeof json.scope === "string"
      ? json.scope
      : Array.isArray(json.scopes)
        ? json.scopes.filter((s): s is string => typeof s === "string").join(" ")
        : null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scopes: scopes || null,
    extra,
  };
}

export async function exchangeCode(
  connectorId: string,
  code: string,
  redirectUri: string,
  opts: { fetchImpl?: typeof fetch; codeVerifier?: string; variant?: string } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  const { tokenUrl } = variantOrThrow(connectorId, provider, opts.variant);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: id,
    client_secret: secret,
  });
  if (opts.codeVerifier) body.set("code_verifier", opts.codeVerifier);
  return postToken(tokenUrl, body, opts.fetchImpl ?? fetch);
}

/** Whether `url` is a host this provider's tokens may be sent to (Salesforce's `instance_url`). */
export function isTrustedInstanceUrl(
  connectorId: string,
  url: string | null | undefined
): url is string {
  const provider = OAUTH_PROVIDERS[connectorId];
  return Boolean(url && provider?.trustInstanceUrl?.(url));
}

export async function refreshAccessToken(
  connectorId: string,
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch; instanceUrl?: string | null } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  let tokenUrl = provider.tokenUrl;
  if (provider.instanceTokenPath && opts.instanceUrl) {
    // A stored host that fails the check was never written by Orbit's own connect: refuse to
    // hand it the refresh token, and ask for a reconnect that stores a good one.
    if (!isTrustedInstanceUrl(connectorId, opts.instanceUrl)) {
      throw new OAuthTokenError("The stored account host isn’t one Orbit trusts", true);
    }
    tokenUrl = new URL(provider.instanceTokenPath, opts.instanceUrl).href;
  }
  return postToken(
    tokenUrl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
    }),
    opts.fetchImpl ?? fetch
  );
}
