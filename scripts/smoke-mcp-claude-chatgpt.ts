/**
 * Dedicated smoke test verifying Claude and ChatGPT connectivity to Orbit's MCP and OpenAPI surfaces:
 *
 * 1. Claude flow: OAuth 401 challenge, protected resource metadata, initialize handshake, tools/list, tools/call.
 * 2. ChatGPT flow: root & subpath metadata discovery, initialize handshake, tools/call, client attribution.
 * 3. Protocol resilience: requests with Accept: application/json, Accept: * / *, or missing Accept do not get 406.
 * 4. CORS preflight: OPTIONS on /api/mcp and .well-known routes returns 204.
 * 5. OpenID discovery: /.well-known/openid-configuration route exists and responds with CORS.
 * 6. OpenAPI for Custom GPT Actions: every endpoint in /api/v1/openapi.json has a unique operationId.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { productEvents } from "../src/db/schema";
import { generateApiKey } from "../src/lib/api/keys";
import { POST, OPTIONS } from "../src/app/api/mcp/route";
import { GET as GET_ROOT_RESOURCE, OPTIONS as OPTIONS_ROOT_RESOURCE } from "../src/app/.well-known/oauth-protected-resource/route";
import { GET as GET_SUBPATH_RESOURCE } from "../src/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as GET_OPENID_CONFIG, OPTIONS as OPTIONS_OPENID_CONFIG } from "../src/app/.well-known/openid-configuration/route";
import { GET as GET_OPENAPI } from "../src/app/api/v1/openapi.json/route";

const USER = "mcp-claude-chatgpt-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let rpcId = 0;

function mcpRequest(
  token: string | null,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("https://orbit.test/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function makeKey(
  userId: string,
  scopes: Array<"read" | "write"> = ["read", "write"]
): Promise<string> {
  const db = await getDb();
  const key = generateApiKey("api");
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${userId}, 'Claude and ChatGPT Test Key', 'api', ${key.prefix}, ${key.keyHash},
            ${JSON.stringify(scopes)}::jsonb)
  `);
  return key.token;
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM product_events WHERE user_id = ${USER}`);
  await db.execute(sql`
    INSERT INTO user_settings (user_id, comped_plan, comped_at)
    VALUES (${USER}, 'orbit', now())
    ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'orbit', comped_at = now()
  `);

  const rawKey = await makeKey(USER, ["read", "write"]);

  console.log("\n1. 401 challenge & OAuth discovery");

  const unauthRes = await POST(
    new Request("https://orbit.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    })
  );
  check("unauthenticated request returns 401", unauthRes.status === 401);
  const wwwAuth = unauthRes.headers.get("www-authenticate") ?? "";
  check("www-authenticate contains realm and resource_metadata",
    wwwAuth.startsWith('Bearer realm="orbit"') &&
    wwwAuth.includes('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"')
  );

  const subpathRes = await GET_SUBPATH_RESOURCE(new Request("https://orbit.test/.well-known/oauth-protected-resource/api/mcp"));
  check("subpath protected resource route answers", subpathRes.status === 200 || subpathRes.status === 503);
  check("subpath protected resource has CORS", subpathRes.headers.get("access-control-allow-origin") === "*");

  const rootRes = await GET_ROOT_RESOURCE(new Request("https://orbit.test/.well-known/oauth-protected-resource"));
  check("root protected resource route answers", rootRes.status === 200 || rootRes.status === 503);
  check("root protected resource has CORS", rootRes.headers.get("access-control-allow-origin") === "*");

  const rootOpt = await OPTIONS_ROOT_RESOURCE();
  check("root protected resource OPTIONS returns 204", rootOpt.status === 204);

  const openidRes = await GET_OPENID_CONFIG();
  check("openid-configuration route exists and answers", openidRes.status === 200 || openidRes.status === 503);
  check("openid-configuration has CORS", openidRes.headers.get("access-control-allow-origin") === "*");

  const openidOpt = await OPTIONS_OPENID_CONFIG();
  check("openid-configuration OPTIONS returns 204", openidOpt.status === 204);

  console.log("\n2. CORS & HTTP method handling on /api/mcp");

  const mcpOpt = await OPTIONS();
  check("OPTIONS /api/mcp returns 204", mcpOpt.status === 204);
  check("OPTIONS /api/mcp allows all origins and methods",
    mcpOpt.headers.get("access-control-allow-origin") === "*" &&
    (mcpOpt.headers.get("access-control-allow-methods") ?? "").includes("OPTIONS")
  );

  console.log("\n3. Accept header resilience (no 406 on missing / simple Accept)");

  const acceptsToTest = [
    { label: "Accept: application/json", header: "application/json" },
    { label: "Accept: */*", header: "*/*" },
    { label: "no Accept header", header: "" },
  ];

  for (const { label, header } of acceptsToTest) {
    const extraHeaders: Record<string, string> = {};
    if (header) extraHeaders.accept = header;
    const res = await POST(
      mcpRequest(
        rawKey,
        { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
        extraHeaders
      )
    );
    check(`${label} does not return 406`, res.status === 200, `got status ${res.status}`);
  }

  console.log("\n4. Claude integration flow");

  const claudeInit = await POST(
    mcpRequest(
      rawKey,
      {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "Claude", version: "1.0.0" },
          capabilities: {},
        },
      },
      { "user-agent": "Claude/2.0 (Anthropic)" }
    )
  );
  check("Claude initialize succeeds", claudeInit.status === 200);
  const claudeInitBody = await claudeInit.json();
  check("serverInfo identifies as orbit", claudeInitBody?.result?.serverInfo?.name === "orbit");

  const claudeTools = await POST(
    mcpRequest(
      rawKey,
      { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
      { "user-agent": "Claude/2.0 (Anthropic)" }
    )
  );
  check("Claude tools/list succeeds", claudeTools.status === 200);
  const claudeToolsBody = await claudeTools.json();
  const tools = (claudeToolsBody?.result?.tools ?? []) as Array<{ name: string }>;
  check("tools list includes search_contacts", tools.some((t) => t.name === "search_contacts"));

  const claudeCall = await POST(
    mcpRequest(
      rawKey,
      {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "search_contacts", arguments: { query: "test" } },
      },
      { "user-agent": "Claude/2.0 (Anthropic)" }
    )
  );
  check("Claude tools/call succeeds", claudeCall.status === 200);

  const claudeEvents = await db
    .select()
    .from(productEvents)
    .where(and(eq(productEvents.userId, USER), eq(productEvents.name, "mcp_tool_called")));
  check("tool call recorded client: 'claude'",
    claudeEvents.some((e) => (e.properties as { client?: string })?.client === "claude")
  );

  console.log("\n5. ChatGPT integration flow");

  const chatgptInit = await POST(
    mcpRequest(
      rawKey,
      {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "ChatGPT", version: "1.0.0" },
          capabilities: {},
        },
      },
      { "user-agent": "ChatGPT-User/1.0" }
    )
  );
  check("ChatGPT initialize succeeds", chatgptInit.status === 200);

  const chatgptCall = await POST(
    mcpRequest(
      rawKey,
      {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "get_network_overview", arguments: {} },
      },
      { "user-agent": "ChatGPT-User/1.0" }
    )
  );
  check("ChatGPT tools/call succeeds", chatgptCall.status === 200);

  const allEvents = await db
    .select()
    .from(productEvents)
    .where(and(eq(productEvents.userId, USER), eq(productEvents.name, "mcp_tool_called")));
  check("tool call recorded client: 'chatgpt'",
    allEvents.some((e) => (e.properties as { client?: string })?.client === "chatgpt")
  );

  console.log("\n6. OpenAPI spec for Custom GPT Actions");

  const openapiRes = await GET_OPENAPI();
  check("/api/v1/openapi.json returns 200", openapiRes.status === 200);
  const openapiSpec = await openapiRes.json();
  check("openapi version is 3.1.0", openapiSpec?.openapi === "3.1.0");

  const paths = (openapiSpec?.paths ?? {}) as Record<string, Record<string, { operationId?: string }>>;
  const operationIds: string[] = [];
  let allHaveOperationId = true;

  for (const [pathKey, methods] of Object.entries(paths)) {
    for (const [methodKey, op] of Object.entries(methods)) {
      if (typeof op === "object" && op !== null) {
        if (!op.operationId) {
          console.log(`Missing operationId on ${methodKey.toUpperCase()} ${pathKey}`);
          allHaveOperationId = false;
        } else {
          operationIds.push(op.operationId);
        }
      }
    }
  }

  check("all OpenAPI operations have an operationId", allHaveOperationId);
  const uniqueIds = new Set(operationIds);
  check("all operationIds are unique", uniqueIds.size === operationIds.length, `${operationIds.length} operations`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Claude and ChatGPT MCP/Plugin checks passed.");
});
