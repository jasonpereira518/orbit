/**
 * OpenID Connect configuration metadata, proxied from Clerk.
 *
 * Many OAuth 2.0 / 2.1 clients (such as ChatGPT, custom GPT actions, and various assistant
 * connectors) query `/.well-known/openid-configuration` on the resource origin or issuer
 * when discovering authorization and token endpoints.
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
    const upstream = await fetch(`${issuer}/.well-known/openid-configuration`, {
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
