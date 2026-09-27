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
import type { Entitlements } from "@/lib/entitlements";
import type { ApiKeyScope } from "@/lib/api/keys";
import { buildOrbitMcpServer } from "@/lib/mcp/server";
import { resourceMetadataUrl, verifyOAuthCaller } from "@/lib/mcp/oauth";
import { RATE_LIMITS, RateLimitedError, consumeBucket } from "@/lib/rate-limit";
import { recordAiSecurityEvent } from "@/lib/ai-security";

/**
 * JSON-RPC messages one HTTP request may carry.
 *
 * The SDK's transport still accepts JSON-RPC BATCHES (an array body), which the 2025-06 MCP
 * spec dropped and no mainstream client sends. Before this cap, the rate limit counted
 * HTTP requests — so one request carrying five hundred `tools/call` messages was one unit of
 * a 120-a-minute budget, and a looping or hijacked agent could write thousands of notes or
 * stage thousands of drafts a minute. The cap bounds a request; `countToolCalls` below makes
 * each call inside it pay for itself.
 */
export const MAX_MCP_BATCH = 10;

/** Largest request body accepted. A tool call's biggest argument is a 5,000-char note. */
export const MAX_MCP_BODY_BYTES = 256 * 1024;

/**
 * How many messages a JSON-RPC body carries, and how many of them are tool calls.
 * Pure, so the batch rules can be pinned without a transport. Unparseable bodies count as
 * one message and are left for the transport to reject with its own parse error.
 */
export function countToolCalls(body: unknown): { messages: number; toolCalls: number } {
  const list = Array.isArray(body) ? body : [body];
  const toolCalls = list.filter(
    (m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call"
  ).length;
  return { messages: list.length, toolCalls };
}

/** Read the body without consuming it for the transport. Null when there is none or it is not JSON. */
async function peekJson(request: Request): Promise<unknown> {
  if (request.method !== "POST") return null;
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

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
function unauthorized(message: string, request: Request): Response {
  return jsonRpcError(-32001, message, 401, {
    // Derived from the request, so a preview deployment points at its own metadata rather
    // than production's — see `resourceBaseUrl`.
    "www-authenticate": `Bearer realm="orbit", resource_metadata="${resourceMetadataUrl(request)}"`,
  });
}

type McpCaller = {
  userId: string;
  /** Null for an OAuth caller: there is no `api_keys` row to stamp. */
  keyId: string | null;
  scopes: ApiKeyScope[];
  entitlements: Entitlements;
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
      const entitlements = await assertAccountUsable(oauth.userId, { surface: "mcp" });
      caller = { userId: oauth.userId, keyId: null, scopes: oauth.scopes, entitlements };
    } else {
      // "read" here: individual write tools are gated inside the server by the key's scopes,
      // so a read-only key connects successfully and simply sees fewer tools.
      const key = await requireApiCaller(request, {
        scope: "read",
        token: opts.token,
        surface: "mcp",
      });
      caller = {
        userId: key.userId,
        keyId: key.keyId,
        scopes: key.scopes,
        entitlements: key.entitlements,
      };
    }
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.reason === "payment_required") return jsonRpcError(-32001, err.message, 402);
      // "No credential at all" is the normal first request of an OAuth handshake, not a
      // mistake, so it must not read like one: the key-centric wording from `auth.ts` would
      // tell a Claude user to go and find an API key they do not need.
      const missing = err.reason === "missing" || err.reason === "malformed";
      return unauthorized(
        missing ? "Sign in to Orbit to connect this assistant." : err.message,
        request
      );
    }
    return jsonRpcError(-32603, "Authentication failed.", 500);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_MCP_BODY_BYTES) {
    return jsonRpcError(-32600, "Request body too large.", 413);
  }
  const { messages, toolCalls } = countToolCalls(await peekJson(request));
  if (messages > MAX_MCP_BATCH) {
    void recordAiSecurityEvent({
      kind: "batch_rejected",
      userId: caller.userId,
      surface: "mcp",
      detail: { messages, toolCalls },
    });
    return jsonRpcError(-32600, `At most ${MAX_MCP_BATCH} messages per request.`, 400);
  }

  // Resolved by the auth check from the settings row it already read. (`getEntitlements`
  // here would read it again: `cache()` does not deduplicate outside a React render.)
  const { entitlements } = caller;
  try {
    // Charged per tool call, not per HTTP request — see `MAX_MCP_BATCH`.
    await consumeBucket(
      "mcp",
      caller.userId,
      entitlements.plan === "free" ? RATE_LIMITS.mcpFree : RATE_LIMITS.mcp,
      Math.max(1, toolCalls)
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
