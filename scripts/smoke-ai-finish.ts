/**
 * Why a model stopped: the per-provider mapping, and what `completeJson` does with a reply
 * that was cut off or refused. Local PGlite, stubbed Gemini. Run: npx tsx scripts/smoke-ai-finish.ts
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { completeJson, createEmbedding } from "../src/lib/ai";
import { AI_REFUSAL_MESSAGE, AiFinishError, anthropicFinish, geminiFinish, openaiFinish, openaiResponsesFinish } from "../src/lib/ai-finish";
import { AI_INCOMPLETE_MESSAGE, classifyAiError } from "../src/lib/errors";

const USER = "smoke-ai-finish-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---- the mapping, per provider ---- */
check("gemini STOP", geminiFinish({ candidates: [{ finishReason: "STOP" }] }) === "stop");
check("gemini MAX_TOKENS", geminiFinish({ candidates: [{ finishReason: "MAX_TOKENS" }] }) === "length");
check("gemini SAFETY", geminiFinish({ candidates: [{ finishReason: "SAFETY" }] }) === "safety");
check("gemini blocked prompt", geminiFinish({ promptFeedback: { blockReason: "OTHER" } }) === "safety");
check("gemini with no reason reads as stop", geminiFinish({ candidates: [{}] }) === "stop");
check("openai length", openaiFinish({ finish_reason: "length" }) === "length");
check("openai content_filter", openaiFinish({ finish_reason: "content_filter" }) === "safety");
check("openai refusal text wins over a stop", openaiFinish({ finish_reason: "stop", message: { refusal: "I can't help with that" } }) === "refusal");
check("openai responses incomplete by cap", openaiResponsesFinish({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) === "length");
check("anthropic max_tokens", anthropicFinish("max_tokens") === "length");
check("anthropic refusal", anthropicFinish("refusal") === "refusal");
check("anthropic end_turn", anthropicFinish("end_turn") === "stop");
check("anthropic pause_turn is not a failure", anthropicFinish("pause_turn") === "other");

/* ---- classification ---- */
check("a truncation is classified, not 'other'", classifyAiError(new AiFinishError("truncated", AI_INCOMPLETE_MESSAGE)) === "truncated");
check("a refusal is classified, not 'other'", classifyAiError(new AiFinishError("refusal", AI_REFUSAL_MESSAGE)) === "refusal");

/* ---- completeJson against a stubbed Gemini ---- */
type Reply = { finishReason: string; text: string };
let queue: Reply[] = [];
const seenCaps: number[] = [];
/** HTTP statuses to answer before the scripted reply, one per request; 0 = no failure. */
let failFirst: number[] = [];
let embedRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/generativelanguage/.test(url)) return realFetch(input, init);
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (/embedContent|batchEmbed/.test(url)) {
    embedRequests++;
    return Response.json({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }, { status: 503 });
  }
  const failure = failFirst.shift();
  if (failure) return Response.json({ error: { code: failure, message: "transient", status: "UNAVAILABLE" } }, { status: failure });
  const body = (typeof raw === "string" ? JSON.parse(raw) : {}) as { generationConfig?: { maxOutputTokens?: number } };
  seenCaps.push(body.generationConfig?.maxOutputTokens ?? -1);
  const next = queue.shift() ?? { finishReason: "STOP", text: "{}" };
  return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: next.text }] }, finishReason: next.finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}) as typeof fetch;

async function run(replies: Reply[], maxOutputTokens = 512): Promise<{ out?: string; err?: unknown }> {
  queue = [...replies];
  seenCaps.length = 0;
  try {
    return { out: await completeJson(USER, { operation: "chat.title", system: "s", user: "u", maxOutputTokens }) };
  } catch (err) {
    return { err };
  }
}

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "gemini", aiModel: "gemini-3.8-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") });
  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));

  const ok = await run([{ finishReason: "STOP", text: '{"title":"Hello"}' }]);
  check("a normal reply passes through", ok.out === '{"title":"Hello"}' && seenCaps.length === 1);

  const retried = await run([
    { finishReason: "MAX_TOKENS", text: '{"title":"Hel' }, // repairable, which is exactly the trap
    { finishReason: "STOP", text: '{"title":"Hello there"}' },
  ]);
  check("a reply cut off at the cap is asked again, not repaired", retried.out === '{"title":"Hello there"}', String(retried.err));
  check("…with twice the room", seenCaps.length === 2 && seenCaps[1] === seenCaps[0]! * 2, JSON.stringify(seenCaps));

  const twice = await run([
    { finishReason: "MAX_TOKENS", text: '{"title":"Hel' },
    { finishReason: "MAX_TOKENS", text: '{"title":"Hello th' },
  ]);
  check("cut off twice is an honest error, not a fragment", twice.err instanceof AiFinishError && twice.err.kind === "truncated" && twice.out === undefined, String(twice.out));
  check("…in the words the app already uses", twice.err instanceof Error && twice.err.message === AI_INCOMPLETE_MESSAGE);
  check("…after exactly one retry", seenCaps.length === 2, JSON.stringify(seenCaps));

  const refused = await run([{ finishReason: "SAFETY", text: "" }]);
  check("a safety stop is a refusal error", refused.err instanceof AiFinishError && refused.err.kind === "refusal");
  check("…and is never retried", seenCaps.length === 1);

  // Gemini's SDK does not retry on its own; the client is configured to, like the other two.
  failFirst = [503, 429];
  const transient = await run([{ finishReason: "STOP", text: '{"title":"After retries"}' }]);
  check("a transient 503 then a 429 are retried, and the third try answers", transient.out === '{"title":"After retries"}' && failFirst.length === 0, String(transient.err));
  failFirst = [503, 503, 503];
  const exhausted = await run([{ finishReason: "STOP", text: "{}" }]);
  check("but not forever: three failures is an error", exhausted.err !== undefined && failFirst.length === 0, String(exhausted.out));

  embedRequests = 0;
  try { await createEmbedding(USER, "hello"); } catch { /* the stub answers 503 */ }
  check("an embedding is not retried by the SDK as well as by its own backoff", embedRequests === 1, String(embedRequests));

  await new Promise((r) => setTimeout(r, 400)); // usage rows are written after the response
  const rows = await db.select().from(usageEvents).where(eq(usageEvents.userId, USER));
  const kinds = rows.map((r) => `${r.success ? "ok" : r.errorKind}`).sort();
  check("each attempt is its own ledger row, failures carry their kind", kinds.filter((k) => k === "truncated").length === 3 && kinds.filter((k) => k === "refusal").length === 1, kinds.join(","));

  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll finish-reason checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
