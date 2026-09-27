/**
 * OAuth for the MCP server: how Claude and ChatGPT connect to Orbit without a pasted key.
 *
 * ## Clerk is the authorization server, Orbit is only the resource server
 *
 * Orbit issues no OAuth tokens and stores none. A client discovers the authorization server
 * from `/.well-known/oauth-protected-resource/api/mcp`, registers itself with Clerk (CIMD, or
 * Dynamic Client Registration where the client has no CIMD support), sends the user through
 * Clerk's consent screen, and returns with a Clerk OAuth access token (`oat_…`, or an RFC 9068
 * JWT). `@clerk/backend` verifies it here via `auth({ acceptsToken: "oauth_token" })`.
 *
 * That split is the whole reason this is short. There is no token table, no refresh rotation
 * and no consent UI in this repo — the parts of OAuth that are easy to get subtly wrong are
 * Clerk's problem, and Clerk is already the identity of record for every Orbit user.
 *
 * ## What an OAuth caller may do
 *
 * The grant comes from the token's own scopes, read by `oauthGrantFor`:
 *
 *   - `orbit:write` (or the umbrella `orbit:mcp`) → read and write;
 *   - `orbit:read` → read only — the assistant sees the network and can change nothing;
 *   - no Orbit scope at all → depends on `MCP_OAUTH_REQUIRE_SCOPES`.
 *
 * That last case is the one the security audit flagged: a dynamically registered client that
 * asked only for `openid email` used to get full CRM read AND write. With
 * `MCP_OAUTH_REQUIRE_SCOPES=1` such a token is refused outright. Unset, it keeps the old
 * coarse read+write grant — because until the Clerk instance publishes the `orbit:*` scopes
 * no client CAN ask for them, and flipping this first would disconnect every assistant.
 * The order is: define `orbit:read` and `orbit:write` in Clerk (Configure → OAuth
 * applications → Scopes), confirm new connections carry them, then set the flag.
 *
 * What no scope grants is sending — that is not a scope at all. An agent can only queue a
 * message, and the human approves it inside Orbit (see `server.ts`).
 *
 * ## Why the Clerk import is dynamic
 *
 * `@clerk/nextjs/server` pulls in `next/server`, and this module is reached from
 * `scripts/smoke-mcp-server.ts` through the route handler. A static import would drag the
 * Next request machinery into a `tsx` script — the trap recorded for low-level lib modules
 * elsewhere in this repo. It is also skipped entirely when Clerk is unconfigured, which is
 * the normal state of a local worktree.
 */
import { isClerkConfigured } from "@/lib/demo-account";
import { clerkFrontendApiHost } from "@/lib/security-headers";
import { getAppBaseUrl } from "@/lib/app-url";
import type { ApiKeyScope } from "@/lib/api/keys";

/** Orbit's own OAuth scopes, as published in the protected-resource metadata. */
export const ORBIT_OAUTH_SCOPES = ["orbit:read", "orbit:write"] as const;

/** The legacy coarse grant, for tokens without Orbit scopes while enforcement is off. */
export const OAUTH_CALLER_SCOPES: ApiKeyScope[] = ["read", "write"];

/**
 * What a token's scopes allow. Null means refuse: the token carries no Orbit scope and
 * enforcement is on. Pure — see the header for the policy and the rollout order.
 */
export function oauthGrantFor(
  tokenScopes: readonly string[] | null | undefined,
  requireScopes: boolean
): ApiKeyScope[] | null {
  const scopes = new Set(tokenScopes ?? []);
  if (scopes.has("orbit:write") || scopes.has("orbit:mcp")) return ["read", "write"];
  if (scopes.has("orbit:read")) return ["read"];
  return requireScopes ? null : OAUTH_CALLER_SCOPES;
}

export function oauthScopesRequired(): boolean {
  return process.env.MCP_OAUTH_REQUIRE_SCOPES === "1";
}

/**
 * The origin a client is actually talking to.
 *
 * NOT `getAppBaseUrl()`, which prefers the production URL by design — correct for a calendar
 * feed someone pastes into Google once, wrong here. RFC 9728 has the client check that the
 * `resource` it was handed matches the server it dialled, so a preview deployment answering
 * with the production URL fails that check and the connector never gets past discovery.
 *
 * The host comes from the request, which is attacker-controllable in general, so it is used
 * only when it is a Vercel preview host. Anything else falls back to the configured base URL,
 * which means an injected `Host` header can never redirect discovery somewhere else.
 */
export function resourceBaseUrl(request?: Request): string {
  const configured = getAppBaseUrl();
  if (!request) return configured;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return configured;
  if (host === new URL(configured).host) return configured;
  // Preview deployments are reached by two different names — the immutable deployment URL
  // and the branch alias — so matching the suffix covers both without enumerating either.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(host)) return `https://${host}`;
  return configured;
}

/** The MCP resource identifier, as it appears in protected-resource metadata. */
export function mcpResourceUrl(request?: Request): string {
  return `${resourceBaseUrl(request)}/api/mcp`;
}

/** Where a client looks to discover how to authenticate. Sent on every 401. */
export function resourceMetadataUrl(request?: Request): string {
  return `${resourceBaseUrl(request)}/.well-known/oauth-protected-resource/api/mcp`;
}

/** The setup guide, on whichever deployment answered. */
export function connectDocsUrl(request?: Request): string {
  return `${resourceBaseUrl(request)}/connect`;
}

/**
 * Clerk's Frontend API origin, which is also its OAuth issuer.
 *
 * The host is encoded in the publishable key, and `clerkFrontendApiHost` already decodes it
 * for the Content-Security-Policy — so this reuses that rather than parsing the same key a
 * second way. Two decoders of one key is two chances to disagree about which Clerk instance
 * this deployment talks to.
 */
export function clerkIssuerUrl(): string | null {
  const host = clerkFrontendApiHost(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return host ? `https://${host}` : null;
}

export type OAuthCaller = {
  userId: string;
  scopes: ApiKeyScope[];
  /** The OAuth client that was authorized, for telemetry. Absent on older Clerk tokens. */
  clientId: string | null;
};

/**
 * Verify a Clerk OAuth access token on the current request.
 *
 * Returns `null` rather than throwing when there is no valid OAuth token, so the caller can
 * fall through to the API-key path and report one combined failure. `auth()` reads the
 * request that `clerkMiddleware` populated, so this works only inside a route handler.
 */
export async function verifyOAuthCaller(): Promise<OAuthCaller | null> {
  if (!isClerkConfigured()) return null;
  try {
    const { auth } = await import("@clerk/nextjs/server");
    const result = await auth({ acceptsToken: "oauth_token" });
    // `subject` is the Clerk user id on a machine auth object; `userId` on some versions.
    const userId =
      ("subject" in result ? result.subject : null) ??
      ("userId" in result ? result.userId : null);
    if (!userId) return null;
    const clientId = "clientId" in result ? ((result.clientId as string) ?? null) : null;
    const tokenScopes = "scopes" in result && Array.isArray(result.scopes) ? (result.scopes as string[]) : [];
    const scopes = oauthGrantFor(tokenScopes, oauthScopesRequired());
    // A token with no Orbit scope while enforcement is on is not a caller at all: the same
    // 401 an unknown key gets, which sends a well-behaved client back through consent.
    if (!scopes) return null;
    return { userId, scopes, clientId };
  } catch {
    // A malformed or expired token is not an exception worth surfacing: the caller turns it
    // into the same 401 an unknown API key gets.
    return null;
  }
}
