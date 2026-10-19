/**
 * The research step's Anthropic rounds ask for automatic prompt caching, so the second round
 * reads the first round's system prompt and tool definitions instead of paying for them again,
 * and the ledger prices the cache read and write. Local PGlite, stubbed Anthropic.
 * Run: npx tsx scripts/smoke-tool-driver-cache.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { createToolDriver } from "../src/lib/ai-tools";

const USER = "smoke-tool-driver-cache-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const bodies: Array<Record<string, any>> = [];
const usages = [
  { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0 },
  { input_tokens: 300, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/api\.anthropic\.com/.test(url)) return realFetch(input, init);
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  bodies.push(typeof raw === "string" ? JSON.parse(raw) : {});
  return Response.json({
    id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: "done" }], usage: usages[bodies.length - 1] ?? usages[1],
  });
}) as typeof fetch;

async function main() {
  const db = await getDb();
  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "anthropic", aiModel: "claude-haiku-5-5", anthropicApiKeyEncrypted: encrypt("fake-anthropic") });

  const driver = await createToolDriver({
    userId: USER,
    operation: "chat.gather",
    system: "You research.",
    user: "who?",
    tools: [{ name: "search_notes", description: "Search notes", inputSchema: { query: z.string() } }],
  });
  await driver.step(new AbortController().signal);
  await driver.step(new AbortController().signal);

  check("each round asks for automatic prompt caching", bodies.length === 2 && bodies.every((b) => b.cache_control?.type === "ephemeral"), JSON.stringify(bodies.map((b) => b.cache_control)));
  check("the system prompt and the tools are in the cached prefix, ahead of the messages", bodies[0]!.system !== undefined && Array.isArray(bodies[0]!.tools));

  await new Promise((r) => setTimeout(r, 400));
  const rows = await db.select().from(usageEvents).where(eq(usageEvents.userId, USER));
  const [first, second] = rows.sort((a, b) => (a.cachedInputTokens ?? 0) - (b.cachedInputTokens ?? 0));
  check("the ledger records the second round's cache read", (second?.cachedInputTokens ?? 0) === 4000, JSON.stringify(rows.map((r) => r.cachedInputTokens)));
  check("and the read round costs far less than the write round", (second?.estimatedCostMicros ?? Infinity) < (first?.estimatedCostMicros ?? 0) , JSON.stringify(rows.map((r) => r.estimatedCostMicros)));

  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll tool-driver cache checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
