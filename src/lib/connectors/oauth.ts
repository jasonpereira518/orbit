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
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { isAppRelativePath } from "@/lib/safe-path";

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
 * path — because that resolution happens downstream of this function, not inside it.
 *
 * Those folds (backslash to forward slash, tab and newline stripped from the whole input,
 * both BEFORE an authority is parsed) and the two checks that survive them now live in
 * `isAppRelativePath`. They used to live here, in a second hand-maintained copy alongside
 * `sanitizePath` in `feedback-submission.ts` — and that copy drifted, admitting every one of
 * the folds this one already rejected. One predicate, so there is nothing left to drift.
 *
 * The `/settings` fallback stays here on purpose. A redirect has to go somewhere, and that
 * is the decision the shared predicate deliberately declines to make: the feedback path
 * wants null for the same input, so it can record that it has no route rather than invent
 * one.
 */
function safeReturnTo(value: string | undefined | null): string {
  if (!value) return "/settings";
  return isAppRelativePath(value) ? value : "/settings";
}

export function signOAuthState(state: OAuthState): string {
  const payload: SignedStatePayload = {
    userId: state.userId,
    connectorId: state.connectorId,
    returnTo: safeReturnTo(state.returnTo),
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export function parseOAuthState(raw: string | null | undefined): OAuthState | null {
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
    if (!parsed.userId || !parsed.connectorId) return null;
    if (typeof parsed.iat !== "number" || Date.now() - parsed.iat > OAUTH_STATE_TTL_MS) {
      return null;
    }
    // Sanitized again here, independent of `signOAuthState` having already sanitized on the
    // way in: this is the check that actually protects the callback, since it runs on
    // whatever a validly-signed payload contains, not on whatever this module happened to
    // sign most recently.
    return {
      userId: parsed.userId,
      connectorId: parsed.connectorId,
      returnTo: safeReturnTo(parsed.returnTo),
    };
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
  url.searchParams.set(
    "state",
    signOAuthState({ userId: opts.userId, connectorId, returnTo: opts.returnTo })
  );
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

/** Caps how much of a provider's error text we fold into an Error message. */
function truncateProviderMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

async function postToken(
  provider: OAuthProviderConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetchImpl(provider.tokenUrl, {
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
    // it forever, so it is treated as needs-reauth rather than retryable.
    const needsReauth = res.ok ? true : res.status >= 400 && res.status < 500;
    const rawMessage = json.error_description ?? json.error ?? `Token endpoint returned ${res.status}`;
    throw new OAuthTokenError(truncateProviderMessage(rawMessage), needsReauth);
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
