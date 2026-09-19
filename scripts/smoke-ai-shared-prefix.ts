/**
 * `completeJson`'s `sharedPrefix` changes the bill, never the prompt: every provider still
 * receives exactly `prefix + user`, Anthropic gets a cache breakpoint on the prefix, OpenAI
 * a stable prompt_cache_key — and the capture parse only shares its notes prefix when a
 * second detail batch will actually read it (a single batch would pay the 1.25× cache write
 * for nothing).
 *
 * Local PGlite, stubbed providers (the real SDKs build the requests). Run:
 *   npx tsx scripts/smoke-ai-shared-prefix.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { completeJson, parseMultiPersonNotesWithAI } from "../src/lib/ai";
import { AI_OPERATIONS } from "../src/lib/ai-operations";

const USER = "smoke-shared-prefix-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Sent = { host: "gemini" | "openai" | "anthropic"; body: Record<string, unknown> };
const sent: Sent[] = [];
/** What the stubbed model answers next, by call order within a test. */
let replies: string[] = [];

function nextReply(): string {
  return replies.shift() ?? '{"ok":true}';
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  const body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (/generativelanguage/.test(url)) {
    sent.push({ host: "gemini", body });
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: nextReply() }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
  }
  if (/api\.openai\.com/.test(url)) {
    sent.push({ host: "openai", body });
    return Response.json({
      id: "c1", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: nextReply() }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  if (/api\.anthropic\.com/.test(url)) {
    sent.push({ host: "anthropic", body });
    return Response.json({
      id: "m1", type: "message", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn",
      content: [{ type: "text", text: nextReply() }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function setProvider(provider: "gemini" | "openai" | "anthropic") {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  const model = { gemini: "gemini-3.5-flash", openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-5" }[provider];
  await db.insert(userSettings).values({
    userId: USER,
    aiProvider: provider,
    aiModel: model,
    geminiApiKeyEncrypted: encrypt("fake-gemini"),
    openaiApiKeyEncrypted: encrypt("fake-openai"),
    anthropicApiKeyEncrypted: encrypt("fake-anthropic"),
  });
}

/** The user-message text a request carried, however the provider shapes it. */
function userText(s: Sent): string {
  if (s.host === "gemini") {
    const contents = s.body.contents as Array<{ parts: Array<{ text: string }> }>;
    return contents.flatMap((c) => c.parts.map((p) => p.text)).join("");
  }
  const messages = s.body.messages as Array<{ role: string; content: string | Array<{ text: string }> }>;
  const user = messages.find((m) => m.role === "user")!;
  return typeof user.content === "string" ? user.content : user.content.map((b) => b.text).join("");
}

async function main() {
  const prefix = "FULL NOTES:\nMet six people at the fintech mixer.\n\n";
  const call = (withPrefix: boolean) =>
    completeJson(USER, {
      operation: "capture.parse.details",
      system: "Return JSON.",
      user: "EXTRACT FULL DETAILS FOR THESE PEOPLE ONLY:\n1. Ada",
      ...(withPrefix ? { sharedPrefix: { text: prefix, cacheKey: "capture.details:abc" } } : {}),
    });

  console.log("The prompt is unchanged; only the caching hints differ");
  for (const provider of ["gemini", "openai", "anthropic"] as const) {
    await setProvider(provider);
    sent.length = 0;
    await call(false);
    await call(true);
    const [plain, shared] = sent;
    check(`${provider}: the model reads prefix + user either way`, userText(shared) === prefix + userText(plain), userText(shared));
    check(`${provider}: without a prefix, no caching hints`, JSON.stringify(plain.body).indexOf("cache_control") < 0 && !("prompt_cache_key" in plain.body));
    if (provider === "anthropic") {
      const content = (shared.body.messages as Array<{ content: Array<{ text: string; cache_control?: unknown }> }>)[0].content;
      check("anthropic: the prefix block carries the cache breakpoint", content[0].text === prefix && Boolean(content[0].cache_control));
      check("anthropic: the per-call tail does not", content.length === 2 && !content[1].cache_control);
    }
    if (provider === "openai") {
      check("openai: a stable prompt_cache_key is sent", shared.body.prompt_cache_key === "capture.details:abc");
    }
  }

  console.log("\nThe capture parse shares its notes only across two or more detail batches");
  const person = (name: string) => ({ name, presence: "participant" });
  const identify = (names: string[]) =>
    JSON.stringify({ shared_notes: [], interaction_date: null, met_at: null, people: names.map(person), mentions: [] });
  const details = (names: string[]) =>
    JSON.stringify({ people: names.map((name) => ({ name, source_excerpt: `${name} said hello.` })) });
  const notes = `${"A long note about the fintech mixer. ".repeat(80)}`; // over the two-pass threshold

  await setProvider("anthropic");
  sent.length = 0;
  const six = ["Ada Byron", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov", "Donald Knuth"];
  replies = [identify(six), details(six.slice(0, 4)), details(six.slice(4))];
  const parsed = await parseMultiPersonNotesWithAI(USER, notes);
  const detailCalls = sent.slice(1);
  const blocks = detailCalls.map((s) => (s.body.messages as Array<{ content: Array<{ text: string; cache_control?: unknown }> | string }>)[0].content);
  check("six people → two detail batches", detailCalls.length === 2, String(detailCalls.length));
  check("  each carries the same cached notes block", blocks.every((b) => Array.isArray(b) && Boolean(b[0].cache_control)) && JSON.stringify((blocks[0] as Array<{ text: string }>)[0].text) === JSON.stringify((blocks[1] as Array<{ text: string }>)[0].text));
  check("  and the parse still returns everyone", parsed.people.length === 6);

  sent.length = 0;
  const three = six.slice(0, 3);
  replies = [identify(three), details(three)];
  await parseMultiPersonNotesWithAI(USER, notes);
  const single = sent[1];
  check("three people → one batch, no cache write it would never read", JSON.stringify(single.body).indexOf("cache_control") < 0);
  check("  and the notes are still in the prompt", userText(single).startsWith("FULL NOTES:\n"));

  console.log("\nThinking levels reach the wire only when the registry sets one");
  {
    const spec = AI_OPERATIONS["capture.parse.details"] as { thinking?: string };
    const bodyOf = async (provider: "gemini" | "openai", model?: string) => {
      await setProvider(provider);
      if (model) {
        const db = await getDb();
        await db.update(userSettings).set({ aiModel: model }).where(eq(userSettings.userId, USER));
      }
      sent.length = 0;
      await call(false);
      return JSON.stringify(sent[0].body);
    };

    spec.thinking = undefined;
    check("gemini: no level set → no thinkingConfig", !(await bodyOf("gemini")).includes("thinkingConfig"));
    spec.thinking = "low";
    check("gemini: a registry level reaches the request", (await bodyOf("gemini")).includes('"thinkingLevel":"LOW"'));
    const classic = JSON.parse(await bodyOf("openai"));
    check("openai gpt-4o-mini: unchanged request (temperature, max_tokens)", "temperature" in classic && "max_tokens" in classic && !("reasoning_effort" in classic));
    const reasoning = JSON.parse(await bodyOf("openai", "gpt-5-mini"));
    check(
      "openai gpt-5-mini: effort sent, no temperature, max_completion_tokens",
      reasoning.reasoning_effort === "low" && !("temperature" in reasoning) && "max_completion_tokens" in reasoning
    );
    spec.thinking = undefined;
  }

  await getDb().then((db) => db.delete(userSettings).where(eq(userSettings.userId, USER)));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll shared-prefix checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
