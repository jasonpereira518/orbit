/**
 * `mcp_connected` and `mcp_tool_called`: the product events for the MCP server.
 *
 * Both are telemetry about a request that is already being served, so neither may change its
 * outcome: every function here swallows its own failures (a schema error throws in
 * development by design, and is caught here so a tool call is never the casualty) and none
 * awaits anything.
 *
 * Nothing user-written reaches an event: the tool NAME (a closed registry, asserted against
 * the schema's pattern in `smoke-mcp-server`), the client enum, whether it worked, how long it
 * took and how many items it returned. Never arguments, never results.
 */
import { deterministicEventId } from "@/lib/product-event-ids";
import { track } from "@/lib/product-events";
import { reportError } from "@/lib/report-error";
import type { McpClient } from "@/lib/mcp/client";

/** (user, client, via) pairs this instance has announced. Bounded; the event id dedupes across instances. */
const announced = new Set<string>();
const ANNOUNCED_MAX = 5000;

/**
 * The first request from a (user, client) pair, over OAuth or an API key. The event id is
 * deterministic from the pair, so a cold instance or a retry inserts the same row at most once;
 * the in-memory set only saves the repeat inserts.
 */
export function trackMcpConnected(input: { userId: string; client: McpClient; via: "oauth" | "api_key" }): void {
  const key = `${input.userId}|${input.client}|${input.via}`;
  if (announced.has(key)) return;
  if (announced.size >= ANNOUNCED_MAX) announced.clear();
  announced.add(key);
  try {
    track(
      "mcp_connected",
      { client: input.client, via: input.via },
      {
        userId: input.userId,
        surface: "mcp",
        id: deterministicEventId("mcp_connected", input.userId, input.client, input.via),
      }
    );
  } catch (err) {
    reportError(err, { where: "mcp.track_connected", level: "warning" });
  }
}

/**
 * How many items a tool returned: an array's length, or the length of the one array a result
 * object holds. Anything else (a confirmation, a record) has no count and is left out.
 */
export function resultCountOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const arrays = Object.values(result as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).length;
  }
  return undefined;
}

export function trackMcpToolCalled(input: {
  userId: string;
  client: McpClient;
  tool: string;
  ok: boolean;
  durationMs: number;
  resultCount?: number;
}): void {
  try {
    track(
      "mcp_tool_called",
      {
        tool: input.tool,
        client: input.client,
        ok: input.ok,
        duration_ms: Math.max(0, Math.round(input.durationMs)),
        ...(input.resultCount !== undefined ? { result_count: input.resultCount } : {}),
      },
      { userId: input.userId, surface: "mcp" }
    );
  } catch (err) {
    reportError(err, { where: "mcp.track_tool_called", level: "warning" });
  }
}

/** Test seam. */
export function resetMcpAnnounced() {
  announced.clear();
}
