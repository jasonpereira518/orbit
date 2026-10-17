// A slow / failing LLM provider, simulated locally. Builds the Anthropic and OpenAI clients
// the way src/lib/ai-access.ts does (`new Anthropic({ apiKey })`, `new OpenAI({ apiKey })`,
// no baseURL, so the SDKs honour *_BASE_URL) and calls them with the app's own deadline
// (`aiSignal()` from src/lib/ai.ts), against a local fake provider that hangs, answers 529
// "overloaded", answers 500, or answers slowly. Fake keys; no real provider is contacted.
//
//   npx tsx reliability/tests/llm-faults.mts
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";

let mode = "ok";
let attempts = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) void _;
  attempts++;
  if (mode === "hang") return;
  if (mode === "529" || mode === "500") {
    res.writeHead(Number(mode), { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "injected" } }));
  }
  if (mode === "slow") await new Promise((r) => setTimeout(r, 20_000));
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url?.includes("/messages")) {
    res.end(JSON.stringify({
      id: "msg_x", type: "message", role: "assistant", model: "fake",
      content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  } else {
    res.end(JSON.stringify({
      id: "x", object: "chat.completion", created: 0, model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_BASE_URL = base;
process.env.OPENAI_BASE_URL = `${base}/v1`;

const { aiSignal, AI_CALL_TIMEOUT_MS } = await import("../../src/lib/ai");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { default: OpenAI } = await import("openai");

async function run(provider: "anthropic" | "openai", m: string) {
  mode = m;
  attempts = 0;
  const started = Date.now();
  let outcome = "ok";
  try {
    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey: "sk-ant-fake-local" });
      await client.messages.create(
        { model: "claude-haiku-fake", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
        { signal: aiSignal() }
      );
    } else {
      const client = new OpenAI({ apiKey: "sk-fake-local" });
      await client.chat.completions.create(
        { model: "gpt-fake", messages: [{ role: "user", content: "hi" }] },
        { signal: aiSignal() }
      );
    }
  } catch (err) {
    outcome = `${(err as Error).name}: ${String((err as Error).message).slice(0, 90)}`;
  }
  const r = { provider, mode: m, ms: Date.now() - started, attemptsSeenByProvider: attempts, outcome };
  console.log(r);
  return r;
}

console.log(`app deadline AI_CALL_TIMEOUT_MS=${AI_CALL_TIMEOUT_MS}`);
const results = [];
for (const p of ["anthropic", "openai"] as const) {
  for (const m of ["ok", "529", "500", "slow", "hang"]) results.push(await run(p, m));
}
fs.writeFileSync("reliability/results/llm-faults.json", JSON.stringify(results, null, 2));
server.close();
process.exit(0);
