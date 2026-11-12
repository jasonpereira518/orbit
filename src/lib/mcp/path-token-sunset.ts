/**
 * Retiring `/api/mcp/[token]`, the MCP endpoint with the credential in the URL (FIX_PLAN 3.6).
 *
 * It is not removed yet: connectors configured with an `mcp_url` key would silently break.
 * Every response says it is going, the standard way a client can notice — `Deprecation`
 * (RFC 9745), `Sunset` (RFC 8594) and a `Link` to `/api/mcp`, which takes OAuth — and every
 * request logs a line, so the owner can see when traffic has stopped.
 *
 * SUNSET DATE: the one value to change. It is a date the owner commits to, not one the code
 * enforces; nothing stops working on it until the route is deleted by hand.
 */
export const MCP_PATH_TOKEN_DEPRECATED_AT = "2026-10-19";
export const MCP_PATH_TOKEN_SUNSET_AT = "2027-01-17";

export function pathTokenDeprecationHeaders(): Record<string, string> {
  const deprecated = Math.floor(Date.parse(`${MCP_PATH_TOKEN_DEPRECATED_AT}T00:00:00Z`) / 1000);
  return {
    Deprecation: `@${deprecated}`,
    Sunset: new Date(`${MCP_PATH_TOKEN_SUNSET_AT}T00:00:00Z`).toUTCString(),
    Link: '</api/mcp>; rel="successor-version"',
  };
}

/** The response with the deprecation headers added. Rebuilt, because a Response's headers may be immutable. */
export function withPathTokenDeprecation(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(pathTokenDeprecationHeaders())) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** One line per request, never the token. */
export function logPathTokenUse(method: string) {
  console.warn(`[mcp] deprecated path-token endpoint used (${method}); sunset ${MCP_PATH_TOKEN_SUNSET_AT}`);
}
