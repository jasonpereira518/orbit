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
import {
  ApiAuthError,
  assertAccountUsable,
  requireApiCaller,
  touchApiKeyLastUsed,
} from "@/lib/api/auth";
import { deferTelemetry } from "@/lib/api/http";
import { getEntitlements } from "@/lib/entitlements";
import type { ApiKeyScope } from "@/lib/api/keys";
import { buildOrbitMcpServer } from "@/lib/mcp/server";
import { resourceMetadataUrl, verifyOAuthCaller } from "@/lib/mcp/oauth";
import { RATE_LIMITS, RateLimitedError, consumeBucket } from "@/lib/rate-limit";

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json", ...headers } }
  );
}

/**
 * The 401 an MCP client is supposed to receive.
 *
 * Without this header a client has nothing to go on but a failure. With it, Claude and
 * ChatGPT fetch the resource metadata, find Clerk, and start the sign-in flow — which is the
 * entire difference between "paste an API key" and "click Connect".
 */
function unauthorized(message: string): Response {
  return jsonRpcError(-32001, message, 401, {
    "www-authenticate": `Bearer realm="orbit", resource_metadata="${resourceMetadataUrl()}"`,
  });
}

type McpCaller = {
  userId: string;
  /** Null for an OAuth caller: there is no `api_keys` row to stamp. */
  keyId: string | null;
  scopes: ApiKeyScope[];
};

export async function handleMcpRequest(
  request: Request,
  opts: { token?: string } = {}
): Promise<Response> {
  if (request.headers.get("origin")) {
    return jsonRpcError(-32600, "Browser origins are not permitted.", 403);
  }

  let caller: McpCaller;
  try {
    // OAuth first, and only when no path token was supplied: a path token is by definition
    // an Orbit key, and asking Clerk about it would be a wasted round trip on every request
    // from an older connector.
    const oauth = opts.token ? null : await verifyOAuthCaller();
    if (oauth) {
      await assertAccountUsable(oauth.userId, { surface: "mcp" });
      caller = { userId: oauth.userId, keyId: null, scopes: oauth.scopes };
    } else {
      // "read" here: individual write tools are gated inside the server by the key's scopes,
      // so a read-only key connects successfully and simply sees fewer tools.
      const key = await requireApiCaller(request, {
        scope: "read",
        token: opts.token,
        surface: "mcp",
      });
      caller = { userId: key.userId, keyId: key.keyId, scopes: key.scopes };
    }
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.reason === "payment_required") return jsonRpcError(-32001, err.message, 402);
      // "No credential at all" is the normal first request of an OAuth handshake, not a
      // mistake, so it must not read like one: the key-centric wording from `auth.ts` would
      // tell a Claude user to go and find an API key they do not need.
      const missing = err.reason === "missing" || err.reason === "malformed";
      return unauthorized(
        missing ? "Sign in to Orbit to connect this assistant." : err.message
      );
    }
    return jsonRpcError(-32603, "Authentication failed.", 500);
  }

  // `getEntitlements` is request-cached, so this is the same read the auth check above
  // already paid for.
  const entitlements = await getEntitlements(caller.userId);
  try {
    await consumeBucket(
      "mcp",
      caller.userId,
      entitlements.plan === "free" ? RATE_LIMITS.mcpFree : RATE_LIMITS.mcp
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return jsonRpcError(-32000, err.message, 429);
    }
    throw err;
  }

  const keyId = caller.keyId;
  if (keyId) deferTelemetry(() => touchApiKeyLastUsed(keyId));

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
