/**
 * Orbit's MCP endpoint, authenticated with a bearer API key.
 *
 * Works with Claude Code, Cursor, VS Code, n8n and Pipedream — anything that lets you set a
 * header. claude.ai's own connector UI does not, which is what `[token]/route.ts` is for.
 *
 * Under `/api/` rather than `/mcp` deliberately: `src/proxy.ts` already matches
 * `/(api|trpc)(.*)` and `PUBLIC_ROUTES` reasons entirely in `/api/…` prefixes, so anywhere
 * else means a second exemption pattern to keep in sync forever.
 */
import { handleMcpRequest } from "@/lib/mcp/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}
