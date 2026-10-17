/**
 * Contract tests for the three LLM providers behind `completeJson` (src/lib/ai.ts), with the
 * real SDKs (OpenAI, Anthropic, Gemini) talking to a mocked HTTP layer.
 *
 * Each account is BYOK on one provider (a fake, obviously-not-real key in `user_settings`), so
 * the real AI gate resolves the grant and builds the real client; only `globalThis.fetch` is
 * fake. Responses are shaped like each provider's wire format — a `chat.completion` with
 * `choices[].message.content`, an Anthropic `message` with `content[]` blocks, a Gemini
 * `GenerateContentResponse` with `candidates[].content.parts[]`.
 *
 * What `completeJson` promises its callers, pinned per provider:
 *   - a JSON answer comes back as normalized JSON, including one wrapped in ```json fences;
 *   - prose instead of JSON is "The AI’s answer got cut off — try again", never a SyntaxError;
 *   - an empty answer (no text block, empty content, no candidates) is "Empty AI response";
 *   - a 200 that is an error body with no `choices`/`content` is a plain, friendly Error — not
 *     the raw `TypeError: Cannot read properties of undefined` it starts life as;
 *   - 429, 500 and a network failure become `AI_FAILURE_COPY` for that provider, with no
 *     provider body or key in the message.
 * Every failure is checked to be a plain `Error` (not TypeError/ZodError/SyntaxError) whose
 * message carries no raw JSON.
 *
 * SDK retries: OpenAI and Anthropic retry 429/5xx twice by default with backoff. The mocked
 * error answers carry `x-should-retry: false`, which both SDKs honour, so no test sleeps. A
 * thrown network error has no header to carry that, so those cases run with `setTimeout`
 * collapsed to 0 ms for their duration — the SDKs' own retries still happen (and are counted).
 * Gemini's SDK does not retry unless `retryOptions` is set, which Orbit does not set.
 *
 * Also pinned: `parseAiJson` directly, and the contact brief degrading to its deterministic
 * text when the model omits required fields (`summary`/`standing`) — the ZodError seen in e2e
 * logs is caught inside `generateAndStoreContactBrief`, and capture's `after()` hook adds its
 * own `.catch`, so it never breaks the person's capture.
 *
 * What is wrong today — a TRUNCATED answer is repaired into plausible-looking JSON and returned
 * as success — is `scripts/smoke-bug-llm-truncated-json-accepted.ts`.
 *
 * This file must not name provider hosts or read provider key variables in code: the source
 * guard in smoke-ai-access.ts scans scripts/ for both. Routes match on API paths only.
 *
 * Run: npx tsx scripts/smoke-contract-llm.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactBriefs, contacts, userSettings } from "../src/db/schema";
import { completeJson, parseAiJson } from "../src/lib/ai";
import type { AiOperationId } from "../src/lib/ai-operations";
import { DEFAULT_MODELS } from "../src/lib/ai-providers";
import { generateAndStoreContactBrief } from "../src/lib/contact-brief";
import { encrypt } from "../src/lib/crypto";
import { AI_INCOMPLETE_MESSAGE, friendlyError } from "../src/lib/errors";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";
import { json, mockFetch, route, status } from "./smoke/http-mock";

const t = checker();

type P = "openai" | "anthropic" | "gemini";
const LABEL: Record<P, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini" };
const USERS: Record<P, string> = {
  openai: fakeUserId("llm_openai"),
  anthropic: fakeUserId("llm_anthropic"),
  gemini: fakeUserId("llm_gemini"),
};
const KEY_COLUMN = { openai: "openaiApiKeyEncrypted", anthropic: "anthropicApiKeyEncrypted", gemini: "geminiApiKeyEncrypted" } as const;
const FAKE_KEY = "test-llm-key-not-real-0000";

/** Path patterns only — see the header. */
const PATH: Record<P, RegExp> = {
  openai: /\/v1\/chat\/completions$/,
  anthropic: /\/v1\/messages$/,
  gemini: /:generateContent$/,
};
const NO_RETRY = { "x-should-retry": "false" };

/**
 * What undici actually throws on a reset connection: a bare "fetch failed" with the cause
 * attached. Not the http-mock's `networkError`, whose message embeds the request URL — Gemini's
 * URL contains "/models/", and the classifier would (only in the test) read that as "model
 * unavailable".
 */
const resetConnection = (): never => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
};

/** A successful answer whose text is `text`, in each provider's wire shape. */
function answer(p: P, text: string | null, finish?: string): Response {
  if (p === "openai")
    return json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1760000000,
      model: DEFAULT_MODELS.openai,
      choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null }, logprobs: null, finish_reason: finish ?? "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    });
  if (p === "anthropic")
    return json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: DEFAULT_MODELS.anthropic,
      content: text === null ? [] : [{ type: "text", text }],
      stop_reason: finish ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 40 },
    });
  return json({
    candidates: text === null ? [] : [{ content: { role: "model", parts: [{ text }] }, finishReason: finish ?? "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
    modelVersion: DEFAULT_MODELS.gemini,
  });
}

/** A 200 that is really an error envelope: no choices / content / candidates. */
function errorEnvelope(p: P): Response {
  if (p === "openai") return json({ error: { message: "The server had an error processing your request.", type: "server_error", param: null, code: null } });
  if (p === "anthropic") return json({ type: "error", error: { type: "api_error", message: "Internal server error" } });
  return json({ error: { code: 500, message: "An internal error has occurred.", status: "INTERNAL" } });
}

function rateLimited(p: P): Response {
  if (p === "openai")
    return status(429, { error: { message: "Rate limit reached for gpt-4.1-mini on requests per min (RPM): Limit 3, Used 3.", type: "requests", code: "rate_limit_exceeded" } }, NO_RETRY);
  if (p === "anthropic") return status(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, NO_RETRY);
  return status(429, { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, NO_RETRY);
}

function serverError(p: P): Response {
  if (p === "anthropic") return status(500, { type: "error", error: { type: "api_error", message: "Internal server error" } }, NO_RETRY);
  if (p === "openai") return status(500, { error: { message: "The server had an error while processing your request.", type: "server_error" } }, NO_RETRY);
  return status(500, { error: { code: 500, message: "An internal error has occurred.", status: "INTERNAL" } }, NO_RETRY);
}

const ask = (userId: string, operation: AiOperationId = "capture.parse") =>
  completeJson(userId, { system: "Return the person as JSON.", user: "Met Ada at the fair.", operation });

async function outcome(fn: () => Promise<string>): Promise<{ value: string | null; err: unknown }> {
  try {
    return { value: await fn(), err: null };
  } catch (err) {
    return { value: null, err };
  }
}

/** Collapse every timer to 0 ms while `fn` runs, so an SDK's own retry backoff costs nothing. */
async function withFastTimers<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => real(cb, 0, ...args)) as unknown as typeof setTimeout;
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

/** A failure the person can be shown: plain Error, Orbit's words, no provider body. */
function isFriendly(err: unknown): boolean {
  if (!(err instanceof Error) || err.constructor !== Error) return false;
  if (/[{}]|TypeError|ZodError|SyntaxError|Cannot read|undefined|test-llm-key/.test(err.message)) return false;
  return err.message === "Empty AI response" || friendlyError(err, "\u0000fallback") === err.message;
}

run(async () => {
  const db = await getDb();
  const all = Object.values(USERS);
  await purgeUsers(db, all);
  for (const p of Object.keys(USERS) as P[]) {
    await db.insert(userSettings).values({ userId: USERS[p], aiProvider: p, aiModel: DEFAULT_MODELS[p], [KEY_COLUMN[p]]: encrypt(FAKE_KEY) });
  }

  console.log("parseAiJson");
  {
    t.check("plain JSON", JSON.stringify(parseAiJson('{"a":1}')) === '{"a":1}');
    t.check("```json fences are stripped", JSON.stringify(parseAiJson('```json\n{"a":[1,2]}\n```')) === '{"a":[1,2]}');
    t.check("bare ``` fences are stripped", JSON.stringify(parseAiJson('```\n{"a":1}\n```')) === '{"a":1}');
    t.check("leading prose and trailing commentary are cut away", JSON.stringify(parseAiJson('Sure! Here it is: {"a":"}"} Hope that helps.')) === '{"a":"}"}');
    t.check("a top-level array parses", JSON.stringify(parseAiJson("[1,2,3]")) === "[1,2,3]");
    let thrown: unknown = null;
    try {
      parseAiJson("I'm sorry, I can't help with that.");
    } catch (e) {
      thrown = e;
    }
    t.check("prose with no JSON throws 'Failed to parse AI JSON', not a SyntaxError", thrown instanceof Error && thrown.constructor === Error && thrown.message.startsWith("Failed to parse AI JSON"), String(thrown));
  }

  for (const p of Object.keys(USERS) as P[]) {
    const user = USERS[p];
    const label = LABEL[p];
    console.log(`\n${label}`);

    {
      const http = mockFetch([route("POST", PATH[p], () => answer(p, '{"fullName":"Ada Lovelace","company":"Acme Analytics"}'))]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: a JSON answer comes back normalized`, r.value === '{"fullName":"Ada Lovelace","company":"Acme Analytics"}', String(r.value ?? r.err));
        const sent = http.calls[0];
        const sentKey = sent?.headers["x-api-key"] ?? sent?.headers["x-goog-api-key"] ?? sent?.headers.authorization?.replace(/^Bearer /, "");
        t.check(`${label}: the user's own key went on the wire, once`, sentKey === FAKE_KEY && http.calls.length === 1, `${http.calls.length} call(s)`);
        t.check(`${label}: JSON mode is asked for`, p === "anthropic" || /json_object|application\/json/.test(sent?.body ?? ""));
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], () => answer(p, '```json\n{\n  "fullName": "Ada Lovelace"\n}\n```'))]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: a fenced answer is unwrapped`, r.value === '{"fullName":"Ada Lovelace"}', String(r.value ?? r.err));
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], () => answer(p, '{"fullName":"Ada Lovelace"}'))]);
      try {
        const r = await outcome(() => ask(user));
        // completeJson is schema-agnostic on purpose: a missing field is the caller's to judge
        // (see the contact brief below), so a well-formed partial object passes through intact.
        t.check(`${label}: JSON missing fields the caller wanted is returned as-is (the caller validates)`, r.value === '{"fullName":"Ada Lovelace"}');
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], () => answer(p, "I'm sorry, but I can't share details about real people."))]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: prose instead of JSON → the cut-off copy`, r.err instanceof Error && r.err.message === AI_INCOMPLETE_MESSAGE && isFriendly(r.err), String(r.err));
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], () => answer(p, p === "openai" ? "" : null, p === "gemini" ? "SAFETY" : undefined))]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: an empty answer → "Empty AI response", not success`, r.err instanceof Error && r.err.message === "Empty AI response", String(r.err ?? r.value));
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], () => errorEnvelope(p))]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: a 200 error envelope (no choices/content) is a friendly error, not a TypeError`, r.value === null && isFriendly(r.err), String(r.err ?? r.value));
      } finally {
        http.restore();
      }
    }
    for (const [what, reply] of [
      ["429", () => rateLimited(p)],
      ["500", () => serverError(p)],
    ] as const) {
      const http = mockFetch([route("POST", PATH[p], reply)]);
      try {
        const r = await outcome(() => ask(user));
        t.check(`${label}: ${what} → friendly copy naming ${label}`, isFriendly(r.err) && (r.err as Error).message.includes(label), String(r.err ?? r.value));
        t.check(`${label}: ${what} is not retried behind the caller's back (x-should-retry honoured)`, http.calls.length === 1, `${http.calls.length} call(s)`);
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", PATH[p], resetConnection)]);
      try {
        const r = await withFastTimers(() => outcome(() => ask(user)));
        t.check(
          `${label}: a network failure → friendly copy (not "model unavailable")`,
          isFriendly(r.err) && !/isn’t available/.test((r.err as Error).message),
          String(r.err ?? r.value)
        );
        const expected = p === "gemini" ? 1 : 3;
        t.check(`${label}: attempts on a network failure = ${expected} (SDK default retries)`, http.calls.length === expected, `${http.calls.length} call(s)`);
      } finally {
        http.restore();
      }
    }
  }

  console.log("\nContact brief: the model omits summary/standing");
  {
    const user = USERS.openai;
    const contact = await insertContact(db, user, 3, { notes: "Met at the infra meetup; wants intros to platform founders." });
    const http = mockFetch([
      route("POST", PATH.openai, () => answer("openai", '{"next_step":"Send the intro list","goal_fit":[]}')),
      route("POST", /\/v1\/embeddings$/, () => json({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array.from({ length: 8 }, () => 0.1) }], model: "text-embedding-3-small", usage: { prompt_tokens: 5, total_tokens: 5 } })),
    ]);
    let out: Awaited<ReturnType<typeof generateAndStoreContactBrief>> = null;
    let err: unknown = null;
    try {
      out = await generateAndStoreContactBrief(user, contact.id, { force: true });
    } catch (e) {
      err = e;
    } finally {
      http.restore();
    }
    const brief = await db.query.contactBriefs.findFirst({ where: eq(contactBriefs.contactId, contact.id) });
    t.check("the model was asked", http.calls.some((c) => PATH.openai.test(c.url)));
    t.check("the ZodError does not escape generateAndStoreContactBrief", err === null, String(err));
    t.check("…the deterministic summary stands in", Boolean(out?.summary?.trim()) && out?.aiError === null, JSON.stringify(out));
    t.check("…and the stored brief is marked as not model-written (so it is retried later)", brief !== undefined && brief.model === null && brief.inputHash === null, JSON.stringify({ model: brief?.model, hash: brief?.inputHash }));
    await db.delete(contactBriefs).where(eq(contactBriefs.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }

  await purgeUsers(db, all);
  t.done("llm contract");
});
