/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: when a model runs out of output tokens mid-answer, `completeJson` returns the
 * truncated JSON — patched shut — as a SUCCESS. A capture whose answer was cut off inside the
 * second person's name comes back as `{"people":[{"fullName":"Ada Lovelace"},{"fullName":"Gra"}]}`:
 * a contact called "Gra", a company called "Glob", a summary that stops mid-word. Nothing tells
 * the caller or the person that the answer was incomplete; schema validation passes because the
 * repaired strings are still strings.
 *
 * Defect: `parseAiJson` (src/lib/ai.ts:~494) falls back to `repairTruncatedJson` (~448), which
 * closes any dangling string, array and object; `completeJson` (~537) never looks at the
 * provider's own "I was cut off" signal before parsing — OpenAI `finish_reason: "length"`,
 * Anthropic `stop_reason: "max_tokens"`, Gemini `finishReason: "MAX_TOKENS"` are all ignored.
 * The codebase already met this failure once: the comment on `transcribeNotePage` (~1139)
 * records that "`repairTruncatedJson` then quietly patched the broken JSON into
 * plausible-looking text", and the fix there was to split the request rather than to stop
 * accepting the patch. `AI_INCOMPLETE_MESSAGE` ("The AI’s answer got cut off — try again")
 * exists for exactly this case but is only reached when the repair itself fails.
 *
 * Trigger path: any `completeJson` caller with a bounded `maxOutputTokens` on a long input —
 * capture parsing of dense notes (`capture.parse`), the recruiter classifier (700 tokens),
 * contact briefs — via `completeJson` → `normalizeJsonResponse` → `parseAiJson`.
 *
 * A fix (treat a length/max-tokens finish as `AI_INCOMPLETE_MESSAGE`, and do not let the
 * repair turn a cut-off string value into a complete one) makes each `knownBug` hold; the
 * script then exits 0 and belongs in the pglite tier.
 *
 * Like smoke-contract-llm.ts, this file names no provider host and reads no key variable:
 * smoke-ai-access.ts's source guard scans scripts/ for both.
 *
 * Run: npx tsx scripts/smoke-bug-llm-truncated-json-accepted.ts   (exits 3 while the bug exists)
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
    t.knownBug(
      "BUG: parseAiJson turns a value cut off mid-string into a complete-looking one",
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
    t.knownBug(
      `BUG: ${p} — a truncated answer is returned as success instead of "${AI_INCOMPLETE_MESSAGE}"`,
      err instanceof Error && err.message === AI_INCOMPLETE_MESSAGE,
      `returned ${value}`
    );
    t.knownBug(
      `BUG: ${p} — the cut-off name reaches the caller as a person ("${GRACE.fullName.slice(0, 3)}")`,
      !people.some((person) => person.fullName === GRACE.fullName.slice(0, 3)),
      `people: ${people.map((x) => x.fullName).join(", ")}`
    );
  }

  await purgeUsers(db, all);
  t.done("llm truncated json accepted (known bug)");
});
