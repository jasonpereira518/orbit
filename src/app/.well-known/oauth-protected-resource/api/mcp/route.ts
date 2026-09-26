/**
 * RFC 9728 protected-resource metadata: "this MCP endpoint is protected, and here is who
 * issues its tokens".
 *
 * The path is not free-form. A client takes the resource URL it was given
 * (`https://app/api/mcp`), inserts `/.well-known/oauth-protected-resource` after the origin
 * and keeps the rest of the path — so this file has to live under `api/mcp/` to be found.
 * `handleMcpRequest` names the same URL in the `WWW-Authenticate` header of every 401.
 *
 * CORS is wide open here on purpose: this document is public by design, contains no user
 * data, and is fetched by a browser-side client (claude.ai) from its own origin. That is a
 * different surface from `/api/mcp` itself, which refuses any request carrying an `Origin`.
 */
import { clerkIssuerUrl, connectDocsUrl, mcpResourceUrl, ORBIT_OAUTH_SCOPES } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

export async function GET(request: Request) {
  const issuer = clerkIssuerUrl();
  if (!issuer) {
    // No Clerk, no authorization server to point at — which is the normal state of a local
    // worktree. Saying so beats publishing metadata that names nothing.
    return new Response(
      JSON.stringify({ error: "OAuth is not configured on this deployment." }),
      { status: 503, headers: { "content-type": "application/json", ...CORS } }
    );
  }

  return new Response(
    JSON.stringify({
      resource: mcpResourceUrl(request),
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      // What a client should ask for at consent; `oauthGrantFor` maps them to read/write.
      scopes_supported: [...ORBIT_OAUTH_SCOPES],
      resource_name: "Orbit",
      resource_documentation: connectDocsUrl(request),
    }),
    {
      headers: {
        "content-type": "application/json",
        // The body now names the host that asked, so a shared cache must key on it —
        // otherwise a preview could be served production's document, or the reverse.
        "cache-control": "public, max-age=300",
        vary: "host, x-forwarded-host",
        ...CORS,
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
