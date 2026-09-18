/**
 * A stand-in for the Gemini REST API during Playwright runs. The dev server reaches it via
 * GOOGLE_GEMINI_BASE_URL (read by @google/genai), so the app's real provider code runs and
 * only the network answer is canned. Dependency-free on purpose.
 */
import { createServer } from "node:http";

const port = Number(process.env.AI_STUB_PORT ?? 3999);

/** The first "First Last" pair in the note: the person the flow under test wrote about. */
const personNameIn = (text) => text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[1] ?? "Ada Lovelace";

const userTextOf = (body) =>
  (Array.isArray(body?.contents) ? body.contents : [])
    .flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []))
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n");

function answerFor(body) {
  // Everything but the user's text, wherever the SDK put the system instruction.
  const rest = JSON.stringify({ ...body, contents: undefined });
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
    if (req.method === "POST" && /:generateContent(?:\?|$)/.test(req.url ?? "")) {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* an unreadable body gets the empty answer */ }
      return reply(res, 200, {
        candidates: [{ index: 0, finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(answerFor(body)) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    }
    return reply(res, 404, { error: { code: 404, message: `Not stubbed: ${req.method} ${req.url}`, status: "NOT_FOUND" } });
  });
}).listen(port, "127.0.0.1", () => console.log(`[ai-stub] listening on http://127.0.0.1:${port}`));
