/**
 * The shared MCP request handler, used by both the bearer and path-token routes.
 *
 * ## Stateless is required, not a simplification
 *
 * `sessionIdGenerator: undefined` puts the transport in stateless mode. That is not a
 * shortcut: Vercel instances share no memory, so a session created on one invocation is
 * invisible to the next, and a stateful transport would answer 404 to a session id it had
 * itself issued moments earlier. The SDK's own documentation describes its session state as
 * in-memory.
 *
 * ## The Origin check
 *
 * The transport's built-in DNS-rebinding options are deprecated in favour of external
 * middleware, so the check lives here: if an `Origin` header is present at all, refuse.
 * Legitimate MCP clients are server-side and send none. A browser page cannot suppress it.
 * So its presence means a web page is trying to drive the user's MCP server using whatever
 * credential the browser will attach — which is exactly the attack the deprecated option
 * existed to stop.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiAuthError, requireApiCaller, touchApiKeyLastUsed } from "@/lib/api/auth";
import { deferTelemetry } from "@/lib/api/http";
import { buildOrbitMcpServer } from "@/lib/mcp/server";
import { RATE_LIMITS, RateLimitedError, consumeBucket } from "@/lib/rate-limit";

function jsonRpcError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } }
  );
}

export async function handleMcpRequest(
  request: Request,
  opts: { token?: string } = {}
): Promise<Response> {
  if (request.headers.get("origin")) {
    return jsonRpcError(-32600, "Browser origins are not permitted.", 403);
  }

  let caller;
  try {
    // "read" here: individual write tools are gated inside the server by the key's scopes,
    // so a read-only key connects successfully and simply sees fewer tools.
    caller = await requireApiCaller(request, { scope: "read", token: opts.token });
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return jsonRpcError(-32001, err.message, err.reason === "payment_required" ? 402 : 401);
    }
    return jsonRpcError(-32603, "Authentication failed.", 500);
  }

  try {
    await consumeBucket("mcp", caller.userId, RATE_LIMITS.mcp);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return jsonRpcError(-32000, "Too many requests.", 429);
    }
    throw err;
  }

  deferTelemetry(() => touchApiKeyLastUsed(caller.keyId));

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildOrbitMcpServer(caller.userId, { scopes: caller.scopes });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // One server per request, so nothing survives to leak between users.
    await server.close().catch(() => null);
  }
}
