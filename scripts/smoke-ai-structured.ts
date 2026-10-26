/**
 * Provider-enforced JSON output: the schema reaches each provider in its own field, a provider
 * or model that cannot take one is not sent one, and a schema a provider refuses falls back to
 * the prompt-only call (once, and remembered). Local PGlite, stubbed providers.
 * Run: npx tsx scripts/smoke-ai-structured.ts
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { completeJson } from "../src/lib/ai";
import { anthropicSupportsStructuredOutput, isSchemaRejection, toWireSchema } from "../src/lib/ai-structured";

const USER = "smoke-ai-structured-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---- the pure parts ---- */
const draft = z.object({ subject: z.string().nullable(), body: z.string(), tags: z.array(z.object({ k: z.string() })) });
const wire = toWireSchema(draft) as { $schema?: unknown; additionalProperties?: unknown; properties: { tags: { items: { additionalProperties?: unknown } } } };
check("the wire schema has no $schema header", wire.$schema === undefined);
check("objects are closed, including nested ones", wire.additionalProperties === false && wire.properties.tags.items.additionalProperties === false);
check("Claude models that take a schema", ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"].every(anthropicSupportsStructuredOutput));
check("…and ones that do not", !anthropicSupportsStructuredOutput("claude-sonnet-4-5") && !anthropicSupportsStructuredOutput("claude-sonnet-4-6"));
check("a 400 naming the schema is a rejection", isSchemaRejection(Object.assign(new Error("Invalid schema for response_format"), { status: 400 })));
check("a 400 about something else is not", !isSchemaRejection(Object.assign(new Error("max_tokens too large"), { status: 400 })));
check("a 500 is not", !isSchemaRejection(Object.assign(new Error("schema"), { status: 500 })));

/* ---- on the wire ---- */
type Sent = { host: "gemini" | "openai" | "anthropic"; body: Record<string, any> };
const sent: Sent[] = [];
let rejectSchema = false;
const REPLY = JSON.stringify({ title: "A title" });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  const body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, any>) : {};
  const refuse = (hasSchema: boolean) => rejectSchema && hasSchema;
  const badSchema = () => Response.json({ error: { code: 400, message: "Invalid JSON schema for response_format", status: "INVALID_ARGUMENT", type: "invalid_request_error" } }, { status: 400 });
  if (/generativelanguage/.test(url)) {
    sent.push({ host: "gemini", body });
    if (refuse(Boolean(body.generationConfig?.responseJsonSchema))) return badSchema();
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: REPLY }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });
  }
  if (/api\.openai\.com/.test(url)) {
    sent.push({ host: "openai", body });
    if (refuse(body.response_format?.type === "json_schema")) return badSchema();
    return Response.json({ id: "c", object: "chat.completion", created: 0, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
  }
  if (/api\.anthropic\.com/.test(url)) {
    sent.push({ host: "anthropic", body });
    if (refuse(Boolean(body.output_config?.format))) return badSchema();
    return Response.json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: REPLY }], usage: { input_tokens: 5, output_tokens: 5 } });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function setModel(provider: "gemini" | "openai" | "anthropic" | "openrouter", model: string) {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER, aiProvider: provider, aiModel: model,
    geminiApiKeyEncrypted: encrypt("fake-gemini"), openaiApiKeyEncrypted: encrypt("fake-openai"), anthropicApiKeyEncrypted: encrypt("fake-anthropic"),
  });
}
const ask = (schema = true, operation: "chat.title" | "followup.draft" = "chat.title") =>
  completeJson(USER, { operation, system: "Return JSON.", user: "hi", ...(schema ? { schema: { name: "chat_title", zod: z.object({ title: z.string() }) } } : {}) });

async function main() {
  await setModel("gemini", "gemini-3.8-flash");
  sent.length = 0;
  await ask();
  const g = sent[0]!.body.generationConfig;
  check("gemini: the schema is sent as responseJsonSchema, beside JSON mode", g.responseMimeType === "application/json" && g.responseJsonSchema?.properties?.title?.type === "string", JSON.stringify(g));
  sent.length = 0;
  await ask(false);
  check("gemini: a call with no schema sends none", sent[0]!.body.generationConfig.responseJsonSchema === undefined);

  await setModel("openai", "gpt-4o-mini");
  sent.length = 0;
  await ask();
  const rf = sent[0]!.body.response_format;
  check("openai: json_schema, strict, named", rf.type === "json_schema" && rf.json_schema.strict === true && rf.json_schema.name === "chat_title" && rf.json_schema.schema.additionalProperties === false, JSON.stringify(rf));

  await setModel("anthropic", "claude-haiku-5-5");
  sent.length = 0;
  await ask();
  const oc = sent[0]!.body.output_config;
  check("anthropic: output_config.format carries the schema", oc?.format?.type === "json_schema" && oc.format.schema.properties.title.type === "string", JSON.stringify(oc));
  check("…and keeps the effort Haiku 5.x already got", oc?.effort === "low", JSON.stringify(oc));

  // chat.title is fast tier (a Sonnet 4.5 account is routed to Haiku 4.5, which takes a schema);
  // followup.draft runs on the account's own model.
  await setModel("anthropic", "claude-sonnet-4-5");
  sent.length = 0;
  await ask(true, "followup.draft");
  check("anthropic: a model without structured output is not sent one", sent[0]!.body.model === "claude-sonnet-4-5" && sent[0]!.body.output_config === undefined, JSON.stringify(sent[0]!.body.output_config));

  process.env.ORBIT_AI_SCHEMA = "off";
  await setModel("gemini", "gemini-3.8-flash");
  sent.length = 0;
  await ask();
  check("ORBIT_AI_SCHEMA=off sends none", sent[0]!.body.generationConfig.responseJsonSchema === undefined);
  delete process.env.ORBIT_AI_SCHEMA;

  console.log("\nA provider that refuses the schema");
  await setModel("gemini", "gemini-3.1-flash-lite");
  rejectSchema = true;
  sent.length = 0;
  const out = await ask();
  check("the call still answers", out === REPLY, out);
  check("by retrying once without the schema", sent.length === 2 && sent[1]!.body.generationConfig.responseJsonSchema === undefined, String(sent.length));
  sent.length = 0;
  await ask();
  check("and is not asked with a schema again", sent.length === 1 && sent[0]!.body.generationConfig.responseJsonSchema === undefined, String(sent.length));
  rejectSchema = false;

  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll structured-output checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
