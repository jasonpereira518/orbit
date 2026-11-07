/**
 * Provider-enforced JSON output.
 *
 * Every structured call used to describe its shape in prose and trust the model: Gemini ran in
 * JSON mode, OpenAI in `json_object`, Anthropic in nothing at all, and the parse was lenient
 * enough to accept a wrong shape or a repaired fragment. All three providers can instead be
 * handed a JSON Schema and constrain the reply to it. A call opts in with a zod schema; the
 * result is still validated with zod afterwards, because "valid against the wire schema" and
 * "what this feature needs" are different questions.
 *
 * Pure: no SDKs, no env reads beyond the kill switch, no DB.
 */
import { z } from "zod";
import type { AiProvider } from "@/lib/ai-providers";

export type StructuredSchema = {
  /** Sent to OpenAI as the schema's name (letters, digits, `_` and `-`). */
  name: string;
  /**
   * The shape of the reply. Keep it plain: an object whose fields are all present, with
   * `.nullable()` for "none". Optional fields, unions and refinements are not all accepted by
   * every provider's strict mode; a schema one rejects falls back to prompt-only JSON.
   */
  zod: z.ZodType;
};

/** `ORBIT_AI_SCHEMA=off` sends every call back to prompt-only JSON, the way they all ran before. */
export function structuredOutputEnabled(): boolean {
  return process.env.ORBIT_AI_SCHEMA?.trim().toLowerCase() !== "off";
}

type JsonObject = Record<string, unknown>;

/** A JSON Schema every provider's strict mode accepts: objects closed, no `$schema` header. */
export function toWireSchema(schema: z.ZodType): JsonObject {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonObject;
  const { $schema: _header, ...rest } = raw;
  return closeObjects(rest) as JsonObject;
}

function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (!node || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) out[key] = closeObjects(value);
  if (out.type === "object" && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Claude models that accept `output_config.format`. An allowlist, as for `temperature`: a newer
 * id is treated as unsupported until it is added here, which costs a prompt-only reply, where
 * the opposite mistake costs a 400.
 */
const ANTHROPIC_STRUCTURED_FAMILIES = [
  "claude-haiku-4-5",
  "claude-haiku-5",
  "claude-sonnet-5",
  "claude-opus-4-5",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable",
  "claude-mythos",
];

export function anthropicSupportsStructuredOutput(model: string): boolean {
  return ANTHROPIC_STRUCTURED_FAMILIES.some((family) => model === family || model.startsWith(`${family}-`));
}

/**
 * Whether to send a schema on this call. OpenRouter is left on prompt-only JSON: its routing
 * layer fronts models of any provider and Orbit cannot say which accept a schema.
 */
export function structuredOutputAllowed(provider: AiProvider, model: string): boolean {
  if (!structuredOutputEnabled()) return false;
  if (provider === "openrouter") return false;
  if (provider === "anthropic") return anthropicSupportsStructuredOutput(model);
  return true;
}

/** The provider refused the schema itself (a 400 that names it), not the request. */
export function isSchemaRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== 400 && status !== 422) return false;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /schema|response_format|json_schema|output_config|structured/i.test(message);
}

/** Thrown inside the transport so the caller can retry the same call without a schema. */
export class SchemaRejectedError extends Error {
  constructor(readonly provider: AiProvider, readonly model: string) {
    super("The provider rejected the output schema");
    this.name = "SchemaRejectedError";
  }
}
