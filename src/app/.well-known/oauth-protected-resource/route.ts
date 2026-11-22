/**
 * RFC 9728 protected-resource metadata fallback at the root level.
 *
 * Some OAuth clients (including ChatGPT and generic MCP clients) look for protected-resource
 * metadata at `/.well-known/oauth-protected-resource` rather than (or before) appending the
 * path segment `/api/mcp`.
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
      scopes_supported: [...ORBIT_OAUTH_SCOPES],
      resource_name: "Orbit",
      resource_documentation: connectDocsUrl(request),
    }),
    {
      headers: {
        "content-type": "application/json",
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
