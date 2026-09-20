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
 * ## Why an OAuth caller gets read and write
 *
 * Clerk's dynamic clients arrive with whatever default scopes the instance publishes, and a
 * client may omit scopes entirely. Deriving Orbit's permissions from that would mean a user
 * whose assistant cannot log a meeting, with no setting anywhere in Orbit to fix it.
 *
 * So the grant is deliberately coarse: connecting an assistant is consent to read and write,
 * exactly like a write-scoped API key, and the consent screen names Orbit. What this does NOT
 * grant is sending — that is not a scope at all. An agent can only queue a message, and the
 * human approves it inside Orbit (see `server.ts`). Nothing an OAuth token can do reaches the
 * outside world on its own, which is what makes a coarse grant defensible.
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

/** The scopes an OAuth-connected assistant holds. See the header for why this is flat. */
export const OAUTH_CALLER_SCOPES: ApiKeyScope[] = ["read", "write"];

/** The MCP resource identifier, as it appears in protected-resource metadata. */
export function mcpResourceUrl(): string {
  return `${getAppBaseUrl()}/api/mcp`;
}

/** Where a client looks to discover how to authenticate. Sent on every 401. */
export function resourceMetadataUrl(): string {
  return `${getAppBaseUrl()}/.well-known/oauth-protected-resource/api/mcp`;
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
    return { userId, scopes: OAUTH_CALLER_SCOPES, clientId };
  } catch {
    // A malformed or expired token is not an exception worth surfacing: the caller turns it
    // into the same 401 an unknown API key gets.
    return null;
  }
}
