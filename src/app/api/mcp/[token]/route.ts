/**
 * The same MCP endpoint, with the credential in the URL.
 *
 * This exists for one concrete reason: claude.ai's custom-connector UI accepts a URL plus
 * optional OAuth client credentials, and has no field for a custom header — so a bearer key
 * cannot be supplied there at all. A path token is the same pattern Orbit already uses for
 * the calendar feed at `/api/calendar/[token]`, for the same reason: a client that cannot
 * hold a session still needs to authenticate.
 *
 * The tradeoff is real and worth stating: a URL is likelier to be logged, shared or pasted
 * than a header. Keys minted for this route are marked `kind: 'mcp_url'` so Settings can
 * present them differently and a user can revoke one without touching their API keys.
 */
import { handleMcpRequest } from "@/lib/mcp/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ token: string }> };

export async function POST(request: Request, ctx: Ctx) {
  // Next 16: route params are a Promise and must be awaited.
  const { token } = await ctx.params;
  return handleMcpRequest(request, { token });
}

export async function GET(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  return handleMcpRequest(request, { token });
}
