/**
 * Authorization-server metadata, proxied from Clerk.
 *
 * Current MCP clients discover the authorization server from the protected-resource document
 * next door and then fetch Clerk directly, so strictly this route is redundant. It exists for
 * the clients that still follow the earlier draft and look for this document on the *resource*
 * origin — a group that included shipping versions of several editors. Proxying costs one
 * cached fetch and removes a whole class of "connects in Claude, fails in X" reports.
 *
 * The body is passed through untouched: every endpoint inside it is an absolute Clerk URL, so
 * rewriting anything here could only break the flow.
 */
import { clerkIssuerUrl } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

export async function GET() {
  const issuer = clerkIssuerUrl();
  if (!issuer) {
    return new Response(
      JSON.stringify({ error: "OAuth is not configured on this deployment." }),
      { status: 503, headers: { "content-type": "application/json", ...CORS } }
    );
  }

  try {
    const upstream = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      // Clerk's metadata changes about never; a short cache keeps a burst of connecting
      // clients from turning into a burst of outbound requests.
      next: { revalidate: 3600 },
    });
    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: "The authorization server is not reachable." }),
        { status: 502, headers: { "content-type": "application/json", ...CORS } }
      );
    }
    return new Response(await upstream.text(), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
        ...CORS,
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "The authorization server is not reachable." }),
      { status: 502, headers: { "content-type": "application/json", ...CORS } }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
