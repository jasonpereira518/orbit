/**
 * A stand-in for the three AI providers Orbit talks to, with configurable, deterministic
 * latency, so AI-path benchmarks are reproducible and never spend a real key.
 *
 *   node latency/mock-providers.mjs            # listens on MOCK_AI_PORT (default 3999)
 *
 * Point the app at it with the base-URL variables the SDKs honour (no client in the app
 * sets its own baseURL):
 *   GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3999
 *   OPENAI_BASE_URL=http://127.0.0.1:3999/v1
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:3999
 * and give it a fake key (GEMINI_API_KEY=mock etc.; honoured as a managed key off Vercel).
 *
 * Delays (ms), all overridable by env. Defaults are the p50s measured by the repo's own eval
 * harness in docs/ai-evals/2026-10-14-* (Gemini BYOK), so a mocked chat turn costs what a
 * real one costs, minus variance:
 *   MOCK_TTFT_MS        time to first streamed token        default 900
 *   MOCK_TOKEN_MS       per streamed chunk (~4 tokens)      default 12
 *   MOCK_TOKENS         streamed chunks per answer          default 180   (~6s total at defaults... see below)
 *   MOCK_JSON_MS        non-streamed completion (parse, rerank, extract) default 900
 *   MOCK_JSON_LARGE_MS  a completion asked for >4k output tokens (capture details) default 4000
 *   MOCK_EMBED_MS       one embedding call                   default 215
 *   MOCK_STT_MS         one audio transcription              default 1500
 *
 * Every request is logged as one JSON line on stdout (`{t, provider, kind, model, ms, inTokens}`)
 * so a run can count model calls per user action and reconstruct the critical path.
 *
 * Content: answers are shaped to what Orbit's parsers expect (the e2e stub's recipes for
 * capture extraction and commitments), and everything else gets `{}` or prose — the app's
 * sanitizers fall back cleanly on unknown shapes, which is exactly the "model said something
 * useless" path a latency test should not depend on.
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_AI_PORT ?? 3999);
const D = (name, fallback) => Number(process.env[name] ?? fallback);
const DELAYS = {
  ttft: D("MOCK_TTFT_MS", 900),
  token: D("MOCK_TOKEN_MS", 12),
  tokens: D("MOCK_TOKENS", 180),
  json: D("MOCK_JSON_MS", 900),
  jsonLarge: D("MOCK_JSON_LARGE_MS", 4000),
  embed: D("MOCK_EMBED_MS", 215),
  stt: D("MOCK_STT_MS", 1500),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIMS = 1536;

const personNameIn = (text) => text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[1] ?? "Ada Lovelace";
const peopleIn = (text) => {
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g)) seen.add(m[1]);
  return [...seen].slice(0, 12);
};

function person(name, user) {
  return {
    name, company: null, role: null, presence: "participant", location: null, email: null,
    linkedin_url: null, met_at: null, topics: ["hiring"], action_items: [], follow_up_recommendation: null,
    follow_up_days: null, relationship_score_suggestion: 3, relevance: null, tags: [],
    summary: `${name} came up in these notes.`, key_facts: [], opportunities: [], shared_interests: [],
    suggested_next_message: null, confidence: 0.9, interaction_date: null, low_confidence_fields: [],
    source_excerpt: user.slice(0, 280),
  };
}

/** JSON answer for a non-streamed completion, keyed on the system prompt's wording. */
function jsonAnswer(system, user) {
  if (system.includes("You extract structured contact data")) {
    const names = peopleIn(user);
    return { shared_notes: [], interaction_date: null, mentions: [], people: (names.length ? names : [personNameIn(user)]).map((n) => person(n, user)) };
  }
  if (system.includes("You identify every distinct person")) {
    const names = peopleIn(user);
    return {
      shared_notes: [], interaction_date: null, met_at: null, mentions: [],
      people: (names.length ? names : [personNameIn(user)]).map((n) => ({ name: n, email: null, company: null, role: null, presence: "participant" })),
    };
  }
  if (system.includes("You extract structured contact fields for a batch")) {
    // The request lists the batch as "1. Name <email> @ Company — Role" lines; answer in the same order.
    const listed = [...user.matchAll(/^\d+\. ([^<@\u2014\n]+)/gm)].map((m) => m[1].trim()).filter(Boolean);
    const names = listed.length ? listed : peopleIn(user);
    return { people: (names.length ? names : [personNameIn(user)]).map((n) => person(n, user)) };
  }
  if (system.includes("You extract dated commitments")) return { commitments: [] };
  return {};
}

function fakeEmbedding(seed) {
  const out = new Array(DIMS);
  let x = (seed * 2654435761 + 12345) >>> 0;
  let norm = 0;
  for (let d = 0; d < DIMS; d++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[d] = (x / 0xffffffff) * 2 - 1;
    norm += out[d] * out[d];
  }
  norm = Math.sqrt(norm);
  return out.map((v) => Math.round((v / norm) * 1e4) / 1e4);
}
const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

const ANSWER = "Based on your network, the people worth talking to are the ones you met at the summit who mentioned hiring. ";
const chunksOf = (n) => Array.from({ length: n }, (_, i) => ANSWER.slice((i * 7) % ANSWER.length, (i * 7) % ANSWER.length + 7));

function log(entry) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function sse(res, events, { ttft, perChunk }) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  await sleep(ttft);
  for (const ev of events) {
    res.write(ev);
    await sleep(perChunk);
  }
  res.end();
}

const approxTokens = (s) => Math.round((s?.length ?? 0) / 4);

async function handle(req, res, raw) {
  const url = req.url ?? "";
  const started = performance.now();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const done = (provider, kind, model, extra = {}) =>
    log({ provider, kind, model, ms: Math.round(performance.now() - started), inTokens: approxTokens(raw), ...extra });

  // ---------- Gemini (@google/genai) ----------
  let m;
  if ((m = url.match(/\/models\/([^:]+):streamGenerateContent/))) {
    const chunks = chunksOf(DELAYS.tokens);
    const events = chunks.map((text, i) => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, ...(i === chunks.length - 1 ? { finishReason: "STOP" } : {}) }], usageMetadata: { promptTokenCount: approxTokens(raw), candidatesTokenCount: i + 1, totalTokenCount: approxTokens(raw) + i + 1 } })}\n\n`);
    await sse(res, events, { ttft: DELAYS.ttft, perChunk: DELAYS.token });
    return done("gemini", "stream", m[1]);
  }
  if ((m = url.match(/\/models\/([^:]+):generateContent/))) {
    const system = JSON.stringify({ ...body, contents: undefined });
    const user = (Array.isArray(body?.contents) ? body.contents : []).flatMap((c) => c.parts ?? []).map((p) => p.text ?? "").join("\n");
    const large = Number(body?.generationConfig?.maxOutputTokens ?? 0) > 4096;
    await sleep(large ? DELAYS.jsonLarge : DELAYS.json);
    const text = JSON.stringify(jsonAnswer(system, user));
    json(res, 200, { candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text }] } }], usageMetadata: { promptTokenCount: approxTokens(raw), candidatesTokenCount: approxTokens(text), totalTokenCount: approxTokens(raw) + approxTokens(text) } });
    return done("gemini", large ? "json-large" : "json", m[1]);
  }
  if ((m = url.match(/\/models\/([^:]+):batchEmbedContents/))) {
    await sleep(DELAYS.embed + 200);
    const reqs = body?.requests ?? [];
    json(res, 200, { embeddings: reqs.map((r) => ({ values: fakeEmbedding(hash(JSON.stringify(r?.content ?? r))) })) });
    return done("gemini", "embed-batch", m[1], { items: reqs.length });
  }
  if ((m = url.match(/\/models\/([^:]+):embedContent/))) {
    await sleep(DELAYS.embed);
    const contents = Array.isArray(body?.contents) ? body.contents : [body?.content ?? body?.contents ?? {}];
    json(res, 200, { embeddings: contents.map((c) => ({ values: fakeEmbedding(hash(JSON.stringify(c))) })) });
    return done("gemini", "embed", m[1], { items: contents.length });
  }

  // ---------- OpenAI ----------
  if (url.startsWith("/v1/chat/completions")) {
    const model = body?.model ?? "gpt";
    if (body?.stream) {
      const chunks = chunksOf(DELAYS.tokens);
      const events = chunks.map((text, i) => `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { content: text }, finish_reason: i === chunks.length - 1 ? "stop" : null }] })}\n\n`);
      events.push("data: [DONE]\n\n");
      await sse(res, events, { ttft: DELAYS.ttft, perChunk: DELAYS.token });
      return done("openai", "stream", model);
    }
    const system = (body?.messages ?? []).filter((x) => x.role === "system").map((x) => x.content).join("\n");
    const user = (body?.messages ?? []).filter((x) => x.role === "user").map((x) => (typeof x.content === "string" ? x.content : JSON.stringify(x.content))).join("\n");
    const large = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0) > 4096;
    await sleep(large ? DELAYS.jsonLarge : DELAYS.json);
    const content = JSON.stringify(jsonAnswer(system, user));
    json(res, 200, { id: "chatcmpl-mock", object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: approxTokens(raw), completion_tokens: approxTokens(content), total_tokens: 1 } });
    return done("openai", large ? "json-large" : "json", model);
  }
  if (url.startsWith("/v1/responses")) {
    await sleep(DELAYS.json);
    json(res, 200, { id: "resp-mock", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }], output_text: "{}", usage: { input_tokens: approxTokens(raw), output_tokens: 1 } });
    return done("openai", "responses", body?.model ?? "gpt");
  }
  if (url.startsWith("/v1/embeddings")) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
    await sleep(inputs.length > 1 ? DELAYS.embed + 200 : DELAYS.embed);
    json(res, 200, { object: "list", data: inputs.map((s, i) => ({ object: "embedding", index: i, embedding: fakeEmbedding(hash(String(s))) })), model: body?.model ?? "text-embedding-3-small", usage: { prompt_tokens: approxTokens(raw), total_tokens: approxTokens(raw) } });
    return done("openai", inputs.length > 1 ? "embed-batch" : "embed", body?.model ?? "embed", { items: inputs.length });
  }
  if (url.startsWith("/v1/audio/transcriptions")) {
    await sleep(DELAYS.stt);
    json(res, 200, { text: "This is a mocked transcript of the recording. We talked about hiring and agreed to follow up next week." });
    return done("openai", "stt", "whisper-1");
  }

  // ---------- Anthropic ----------
  if (url.startsWith("/v1/messages")) {
    const model = body?.model ?? "claude";
    if (body?.stream) {
      const chunks = chunksOf(DELAYS.tokens);
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const events = [
        ev("message_start", { message: { id: "msg-mock", type: "message", role: "assistant", model, content: [], usage: { input_tokens: approxTokens(raw), output_tokens: 0 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ...chunks.map((text) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: chunks.length } }),
        ev("message_stop", {}),
      ];
      await sse(res, events, { ttft: DELAYS.ttft, perChunk: DELAYS.token });
      return done("anthropic", "stream", model);
    }
    const system = typeof body?.system === "string" ? body.system : JSON.stringify(body?.system ?? "");
    const user = (body?.messages ?? []).map((x) => (typeof x.content === "string" ? x.content : JSON.stringify(x.content))).join("\n");
    const large = Number(body?.max_tokens ?? 0) > 4096;
    await sleep(large ? DELAYS.jsonLarge : DELAYS.json);
    const text = JSON.stringify(jsonAnswer(system, user));
    json(res, 200, { id: "msg-mock", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: approxTokens(raw), output_tokens: approxTokens(text) } });
    return done("anthropic", large ? "json-large" : "json", model);
  }

  if (url === "/health") return json(res, 200, { ok: true, delays: DELAYS });
  json(res, 404, { error: { message: `Not mocked: ${req.method} ${url}` } });
  done("none", "404", url);
}

createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { raw += c; });
  req.on("end", () => handle(req, res, raw).catch((err) => json(res, 500, { error: String(err) })));
}).listen(port, "127.0.0.1", () => console.error(`[mock-ai] http://127.0.0.1:${port} delays=${JSON.stringify(DELAYS)}`));
