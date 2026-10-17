/**
 * The MCP endpoint's body cap holds without a Content-Length (audit M-02). A chunked request
 * used to be read whole by `request.clone().json()` before any size check could run.
 * Run: npx tsx scripts/smoke-mcp-body-cap.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { apiKeys } from "../src/db/schema";
import { generateApiKey } from "../src/lib/api/keys";
import { MAX_MCP_BODY_BYTES, handleMcpRequest } from "../src/lib/mcp/handle";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-mcp-body-cap-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();
  await db.delete(apiKeys).where(eq(apiKeys.userId, USER));
  await ensureUserSettings(USER);
  const key = generateApiKey("mcp_url");
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'smoke key', 'mcp_url', ${key.prefix}, ${key.keyHash}, '["read"]'::jsonb)
  `);

  // Chunked: the stream has no length, so no Content-Length header is set.
  let pulled = 0;
  const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 64) return controller.close();
      pulled++;
      controller.enqueue(chunk);
    },
  });
  const big = new Request("https://orbit.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  check("the oversized request carries no Content-Length", big.headers.get("content-length") === null);
  const res = await handleMcpRequest(big, { token: key.token });
  check("a 4 MB chunked body is refused with 413", res.status === 413, `status ${res.status}`);
  check(
    "reading stopped near the cap",
    pulled * chunk.byteLength <= MAX_MCP_BODY_BYTES + 4 * chunk.byteLength,
    `pulled ${(pulled * chunk.byteLength) / 1024} KB of a ${MAX_MCP_BODY_BYTES / 1024} KB cap`
  );

  const small = new Request("https://orbit.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const ok = await handleMcpRequest(small, { token: key.token });
  check("a normal request still goes through", ok.status === 200, `status ${ok.status} ${await ok.text().catch(() => "")}`.slice(0, 200));

  await db.delete(apiKeys).where(eq(apiKeys.userId, USER));
  if (failures > 0) throw new Error(`${failures} MCP body-cap check(s) failed`);
  console.log("\nAll MCP body-cap checks passed.");
});
