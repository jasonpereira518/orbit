/**
 * Which assistant is calling the MCP server, as a CLOSED enum: `claude`, `chatgpt` or `other`.
 *
 * Orbit used to throw this away: `verifyOAuthCaller` read Clerk's `clientId` and nothing used
 * it, so "how many people connected Claude vs ChatGPT" was unanswerable (audit D9). This maps
 * what is known about the caller to the enum the analytics schema allows, and nothing else
 * about the caller ever leaves this file: no client name, no id, no user agent is recorded.
 *
 * CONSERVATIVE BY DESIGN. Three signals, strongest first, each matched on a whole word:
 *   1. Clerk's OAuth `clientId`. With a client-ID-metadata-document client this is the
 *      metadata URL (a claude.ai or openai.com host); with dynamic registration it is opaque
 *      and says nothing, so it is also remembered per instance once another signal names it.
 *   2. The `clientInfo.name` an MCP `initialize` request carries. Stateless transport means
 *      only the initialize request has it, so it is seen once per connection.
 *   3. The User-Agent of the request, the only signal every tool call has.
 * A signal that matches BOTH assistants, or neither, abstains. No signal at all is `other`.
 * A wrong "other" costs a miscounted row; a wrong "claude" would be a false fact, so when in
 * doubt it is `other`.
 *
 * Pure apart from the small per-instance cache; no database, no framework.
 */
import { MCP_CLIENTS } from "@/lib/product-event-schemas";

export type McpClient = (typeof MCP_CLIENTS)[number];

const CLAUDE = /(^|[^a-z0-9])(claude|anthropic)([^a-z0-9]|$)/i;
const CHATGPT = /(^|[^a-z0-9])(chatgpt|openai)([^a-z0-9]|$)/i;

/** The assistant a piece of text names, or null when it names neither or both. */
function classify(text: string | null | undefined): Exclude<McpClient, "other"> | null {
  if (!text) return null;
  const sample = text.slice(0, 300);
  const claude = CLAUDE.test(sample);
  const chatgpt = CHATGPT.test(sample);
  if (claude === chatgpt) return null;
  return claude ? "claude" : "chatgpt";
}

/** Opaque ids learned from a stronger signal on an earlier request. Bounded; per instance. */
const learned = new Map<string, Exclude<McpClient, "other">>();
const LEARNED_MAX = 500;

export function mcpClientFrom(input: {
  clientId?: string | null;
  clientName?: string | null;
  userAgent?: string | null;
}): McpClient {
  const fromId = classify(input.clientId);
  const found =
    fromId ?? classify(input.clientName) ?? classify(input.userAgent) ?? (input.clientId ? learned.get(input.clientId) ?? null : null);
  if (found && input.clientId && !fromId) {
    if (learned.size >= LEARNED_MAX) learned.clear();
    learned.set(input.clientId, found);
  }
  return found ?? "other";
}

/** `clientInfo.name` from a parsed `initialize` request (or batch), else null. */
export function initializeClientName(body: unknown): string | null {
  const list = Array.isArray(body) ? body : [body];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const m = message as { method?: unknown; params?: { clientInfo?: { name?: unknown } } };
    if (m.method === "initialize" && typeof m.params?.clientInfo?.name === "string") {
      return m.params.clientInfo.name.slice(0, 100);
    }
  }
  return null;
}

/** Test seam. */
export function resetMcpClientCache() {
  learned.clear();
}
