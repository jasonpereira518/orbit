/**
 * A stand-in for the managed provider's API during Playwright runs. The dev server reaches
 * it via ANTHROPIC_BASE_URL (read by @anthropic-ai/sdk), so the app's real provider code
 * runs and only the network answer is canned. It still answers the Gemini `/generateContent`
 * shape too, for a run pointed back at GEMINI_API_KEY. Dependency-free on purpose.
 */
import { createServer } from "node:http";

const port = Number(process.env.AI_STUB_PORT ?? 3999);

/** The first "First Last" pair in the note: the person the flow under test wrote about. */
const personNameIn = (text) => text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[1] ?? "Ada Lovelace";

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return "";
};

const userTextOf = (body) => {
  const gemini = (Array.isArray(body?.contents) ? body.contents : [])
    .flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []))
    .map((p) => (typeof p?.text === "string" ? p.text : ""));
  const anthropic = (Array.isArray(body?.messages) ? body.messages : []).map((m) => textOf(m?.content));
  return [...gemini, ...anthropic].filter(Boolean).join("\n");
};

function answerFor(body) {
  // Everything but the conversation text, wherever the SDK put the system instruction.
  const rest = JSON.stringify({ ...body, contents: undefined, messages: undefined });
  const user = userTextOf(body);
  if (rest.includes("You extract structured contact data")) {
    const name = personNameIn(user);
    return {
      shared_notes: [], interaction_date: null, mentions: [],
      people: [{
        name, company: null, role: null, presence: "participant", location: null, email: null,
        linkedin_url: null, met_at: null, topics: [], action_items: [], follow_up_recommendation: null,
        follow_up_days: null, relationship_score_suggestion: 3, relevance: null, tags: [],
        summary: `${name} came up in these notes.`, key_facts: [], opportunities: [], shared_interests: [],
        suggested_next_message: null, confidence: 0.9, interaction_date: null, low_confidence_fields: [],
        source_excerpt: user.slice(0, 280),
      }],
    };
  }
  if (rest.includes("You extract dated commitments")) return { commitments: [] };
  return {};
}

function reply(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* an unreadable body gets the empty answer */ }
    if (req.method === "POST" && /\/v1\/messages(?:\?|$)/.test(req.url ?? "")) {
      return reply(res, 200, {
        id: "msg_e2e_stub",
        type: "message",
        role: "assistant",
        model: typeof body?.model === "string" ? body.model : "claude-3-5-haiku-latest",
        content: [{ type: "text", text: JSON.stringify(answerFor(body)) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (req.method === "POST" && /:generateContent(?:\?|$)/.test(req.url ?? "")) {
      const answer = answerFor(body);
      return reply(res, 200, {
        candidates: [{ index: 0, finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(answer) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    }
    return reply(res, 404, { error: { code: 404, message: `Not stubbed: ${req.method} ${req.url}`, status: "NOT_FOUND" } });
  });
}).listen(port, "127.0.0.1", () => console.log(`[ai-stub] listening on http://127.0.0.1:${port}`));
