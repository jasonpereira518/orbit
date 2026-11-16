/**
 * The arguments of one `orbit_tool` call, however the model wrote them.
 *
 * The function declares `input` as a JSON string, but models often send an object, an empty
 * value, or a double-encoded string. Before this, anything but a JSON-object string threw inside
 * the browser and every lookup came back as "the CRM lookup failed" without ever reaching the
 * server. Pure (scripts/smoke-voice-tool-input.ts).
 */
export type ToolInput = { args: Record<string, unknown> } | { error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeToolInput(raw: unknown, depth = 0): ToolInput {
  if (raw === undefined || raw === null) return { args: {} };
  if (isRecord(raw)) return { args: raw };
  if (typeof raw !== "string") return { error: "input must be a JSON object of the tool's arguments" };
  const text = raw.trim();
  if (!text) return { args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "input is not valid JSON; send a JSON object of the tool's arguments" };
  }
  // Double-encoded (a JSON string of a JSON string) is common too; one level only.
  if (typeof parsed === "string" && depth === 0) return normalizeToolInput(parsed, 1);
  if (parsed === null) return { args: {} };
  return isRecord(parsed) ? { args: parsed } : { error: "input must be a JSON object, not a list or a value" };
}

/** The whole `orbit_tool` call: `{tool, input}` as a JSON string (Deepgram) or an object. */
export function normalizeToolCall(raw: unknown): { tool: string; input: unknown } | { error: string } {
  let call: unknown = raw;
  if (typeof raw === "string") {
    try {
      call = JSON.parse(raw);
    } catch {
      return { error: "orbit_tool arguments are not valid JSON" };
    }
  }
  if (!isRecord(call) || typeof call.tool !== "string" || !call.tool.trim())
    return { error: "orbit_tool needs tool (a name from the catalog) and input (its arguments)" };
  return { tool: call.tool.trim(), input: call.input };
}
