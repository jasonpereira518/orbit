/**
 * A truncated model answer is an error, never a success.
 *
 * When a model runs out of output tokens mid-answer, `completeJson` (src/lib/ai.ts) used to
 * return the truncated JSON — patched shut by `repairTruncatedJson` — as a success: a capture
 * cut off inside the second person's name came back with a contact called "Gra". Pinned now:
 *
 *  - the providers' own max-tokens stop (OpenAI `finish_reason: "length"`, Anthropic
 *    `stop_reason: "max_tokens"`, Gemini `finishReason: "MAX_TOKENS"`) fails the call as
 *    `AI_INCOMPLETE_MESSAGE` before anything is parsed (`assertNotCutOff`);
 *  - `parseAiJson` no longer closes a dangling string, so a value cut off mid-string cannot
 *    be passed off as complete even without that signal. Braces after whole values are
 *    still closed.
 *
 * Like smoke-contract-llm.ts, this file names no provider host and reads no key variable:
 * smoke-ai-access.ts's source guard scans scripts/ for both.
 *
 * Run: npx tsx scripts/smoke-llm-truncated-json.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { completeJson, parseAiJson } from "../src/lib/ai";
import { DEFAULT_MODELS } from "../src/lib/ai-providers";
import { encrypt } from "../src/lib/crypto";
import { AI_INCOMPLETE_MESSAGE } from "../src/lib/errors";
import { checker } from "./smoke/check";
import { fakeUserId, makeContact, purgeUsers } from "./smoke/factories";
import { json, mockFetch, route } from "./smoke/http-mock";

const t = checker();
type P = "openai" | "anthropic" | "gemini";
const USERS: Record<P, string> = {
  openai: fakeUserId("trunc_openai"),
  anthropic: fakeUserId("trunc_anthropic"),
  gemini: fakeUserId("trunc_gemini"),
};
const KEY_COLUMN = { openai: "openaiApiKeyEncrypted", anthropic: "anthropicApiKeyEncrypted", gemini: "geminiApiKeyEncrypted" } as const;
const PATH: Record<P, RegExp> = { openai: /\/v1\/chat\/completions$/, anthropic: /\/v1\/messages$/, gemini: /:generateContent$/ };

const ADA = makeContact(0);
const GRACE = makeContact(1);
/** A capture answer cut off inside the second person's name, as a max-tokens stop leaves it. */
const CUT = `{"people":[{"fullName":"${ADA.fullName}","company":"${ADA.company}"},{"fullName":"${GRACE.fullName.slice(0, 3)}`;

/** The provider's answer with its own "ran out of tokens" finish signal. */
function truncated(p: P): Response {
  if (p === "openai")
    return json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1760000000,
      model: DEFAULT_MODELS.openai,
      choices: [{ index: 0, message: { role: "assistant", content: CUT, refusal: null }, logprobs: null, finish_reason: "length" }],
      usage: { prompt_tokens: 3000, completion_tokens: 700, total_tokens: 3700 },
    });
  if (p === "anthropic")
    return json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: DEFAULT_MODELS.anthropic,
      content: [{ type: "text", text: CUT }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 3000, output_tokens: 700 },
    });
  return json({
    candidates: [{ content: { role: "model", parts: [{ text: CUT }] }, finishReason: "MAX_TOKENS", index: 0 }],
    usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 700, totalTokenCount: 3700 },
    modelVersion: DEFAULT_MODELS.gemini,
  });
}

run(async () => {
  const db = await getDb();
  const all = Object.values(USERS);
  await purgeUsers(db, all);
  for (const p of Object.keys(USERS) as P[]) {
    await db.insert(userSettings).values({ userId: USERS[p], aiProvider: p, aiModel: DEFAULT_MODELS[p], [KEY_COLUMN[p]]: encrypt("test-llm-key-not-real-0000") });
  }

  console.log("parseAiJson on its own");
  {
    let parsed: unknown = null;
    let err: unknown = null;
    try {
      parsed = parseAiJson(CUT);
    } catch (e) {
      err = e;
    }
    t.check("the input really is cut off (JSON.parse rejects it)", (() => {
      try {
        JSON.parse(CUT);
        return false;
      } catch {
        return true;
      }
    })());
    t.check(
      "parseAiJson refuses to turn a value cut off mid-string into a complete-looking one",
      err !== null,
      `returned ${JSON.stringify(parsed)}`
    );
  }

  for (const p of Object.keys(USERS) as P[]) {
    console.log(`\n${p}: completeJson on a max-tokens stop`);
    const http = mockFetch([route("POST", PATH[p], () => truncated(p))]);
    let value: string | null = null;
    let err: unknown = null;
    try {
      value = await completeJson(USERS[p], { system: "Extract the people as JSON.", user: "Long meeting notes…", operation: "capture.parse", maxOutputTokens: 700 });
    } catch (e) {
      err = e;
    } finally {
      http.restore();
    }
    t.check(`${p}: the provider was called once`, http.calls.length === 1);
    const people = value ? (JSON.parse(value) as { people?: Array<{ fullName?: string }> }).people ?? [] : [];
    t.check(
      `${p} — a max-tokens stop fails as "${AI_INCOMPLETE_MESSAGE}"`,
      err instanceof Error && err.message === AI_INCOMPLETE_MESSAGE,
      `returned ${value}`
    );
    t.check(
      `${p} — the cut-off name never reaches the caller as a person ("${GRACE.fullName.slice(0, 3)}")`,
      !people.some((person) => person.fullName === GRACE.fullName.slice(0, 3)),
      `people: ${people.map((x) => x.fullName).join(", ")}`
    );
  }

  await purgeUsers(db, all);
  t.done("llm truncated json rejected");
});
