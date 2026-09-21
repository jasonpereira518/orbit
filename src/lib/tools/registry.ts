/**
 * One definition per tool, for every surface that can call it.
 *
 * ============================================================================
 * READ THE SECURITY COMMENT AT THE TOP OF `src/lib/mcp/server.ts` FIRST.
 * ============================================================================
 *
 * It is the threat model for everything in this directory, and its two rules bind here just
 * as hard as they did when every tool was a closure inside that file: no tool sends, fetches
 * a URL or registers a webhook, and no tool approves a draft. Moving the definitions did not
 * move the boundary.
 *
 * WHY A REGISTRY. The tools were written for MCP, but Orbit's own chat needs the same
 * lookups — "what did we discuss", "who do I know at Acme", "what do I owe this person" —
 * and the lib functions underneath already take a `userId` and nothing else. Two copies of
 * "search the user's network and shape the result for a model" is two things to keep in step,
 * and the one that drifts is the one nobody is looking at.
 *
 * WHY SURFACES ARE NOT INTERCHANGEABLE. The same lookup is not equally safe everywhere.
 * `search_contacts` deliberately withholds `notes` over MCP: a search fans out over many
 * contacts at once, which makes it the highest-leverage way for text an attacker wrote into
 * a note to reach a model. In Orbit's own chat that text is already in the prompt — the
 * fence around it is the control there — so withholding it would cost grounding and buy
 * nothing. One tool, two answers, and `fields` is where the difference is written down
 * instead of living in somebody's memory.
 *
 * The projection is an ALLOWLIST and it is applied by the caller, not by the tool. A tool
 * that later returns a new field stays invisible on any surface whose allowlist does not
 * name it, so the failure mode of forgetting to update this file is under-exposure. That is
 * the direction a mistake should fall.
 */
import type { ZodRawShape } from "zod";
import type { ApiKeyScope } from "@/lib/api/keys";

/** Where a tool call came from. Not cosmetic — see the file comment. */
export type ToolSurface = "mcp" | "chat";

export type ToolContext = { surface: ToolSurface };

/**
 * An error a tool returns rather than throws — "no such contact", a paywall refusal.
 *
 * Information the caller can act on, so it is never fenced as untrusted data and never
 * projected: there is nothing in it but a message this code wrote.
 */
export type ToolError = { error: string };

export function toolError(message: string): ToolError {
  return { error: message };
}

export function isToolError(value: unknown): value is ToolError {
  return typeof value === "object" && value !== null && typeof (value as ToolError).error === "string";
}

export type OrbitTool = {
  name: string;
  title: string;
  description: string;
  /** The `inputSchema` shape MCP's `registerTool` takes, and the chat adapter converts. */
  inputSchema: ZodRawShape;
  annotations?: Record<string, boolean>;
  /** Surfaces allowed to call this tool at all. */
  surfaces: readonly ToolSurface[];
  /** `write` tools are hidden from a read-only key, exactly as before. */
  scope: ApiKeyScope;
  /**
   * What MCP fences the result under — "contacts", "reminders". Null for tools whose result
   * is a confirmation this code wrote ("created: true"), which carries no user text to fence.
   */
  resultLabel: string | null;
  /**
   * Per-surface field allowlist, applied to the returned record or array of records.
   *
   * Absent means the payload passes through whole: correct for a tool whose result is a
   * confirmation, or whose shape is nested enough that a flat allowlist would say nothing
   * useful. `scripts/smoke-tool-registry.ts` is the backstop that scans every MCP payload at
   * every depth for fields that must never fan out, so an absent allowlist is not an
   * unguarded one.
   */
  fields?: Partial<Record<ToolSurface, readonly string[]>>;
  run(userId: string, args: never, ctx: ToolContext): Promise<unknown>;
};

/**
 * Free-text fields an attacker can write to, which must never reach a model over MCP except
 * from `get_contact` — one person, asked for by id, truncated.
 *
 * Named here rather than inside the test so the rule is readable next to the tools it binds.
 */
export const MCP_FAN_OUT_DENIED_FIELDS = ["notes", "rawNotes", "raw_notes", "description"] as const;

/** Tools this surface may call, narrowed to the scopes the caller actually holds. */
export function toolsFor(
  all: readonly OrbitTool[],
  surface: ToolSurface,
  scopes: readonly ApiKeyScope[]
): OrbitTool[] {
  return all.filter((t) => t.surfaces.includes(surface) && scopes.includes(t.scope));
}

/**
 * Keep only the allowlisted keys, through an array or a single record.
 *
 * Deliberately shallow: it projects the record the tool returns, not the whole tree. A
 * nested shape (a roster's `people`, a contact's `interactions`) is shaped by the tool
 * itself, because a dotted path language here would be a second schema to keep in step with
 * the first.
 */
export function project<T>(value: T, allow: readonly string[] | undefined): unknown {
  if (!allow) return value;
  const allowed = new Set(allow);
  const one = (record: unknown) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return record;
    return Object.fromEntries(
      Object.entries(record as Record<string, unknown>).filter(([k]) => allowed.has(k))
    );
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/**
 * Run a tool for one surface: the tool's own answer, then the surface's allowlist.
 *
 * An error envelope skips the projection — it is this code's own message, and projecting it
 * would turn "no such contact" into an empty object.
 */
export async function runTool(
  tool: OrbitTool,
  userId: string,
  args: unknown,
  ctx: ToolContext
): Promise<unknown> {
  const result = await tool.run(userId, args as never, ctx);
  if (isToolError(result)) return result;
  return project(result, tool.fields?.[ctx.surface]);
}
