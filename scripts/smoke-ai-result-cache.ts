/**
 * The AI answer cache (`src/lib/ai-result-cache.ts`): the same question is answered from
 * the table, a changed one never is, a bad answer is never replayed, and the cache can only
 * ever make a call cheaper — never fail it. Then the recruiter classifier end to end: a
 * re-scan of an unchanged sender costs no model call.
 *
 * Local PGlite, stubbed provider. Run: npx tsx scripts/smoke-ai-result-cache.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { pruneAiResultCache, withAiResultCache } from "../src/lib/ai-result-cache";
import { classifyRecruiterSender } from "../src/lib/recruiter-scan";

const USER = "smoke-ai-cache-user";
const OTHER = "smoke-ai-cache-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/generativelanguage/.test(url)) {
    modelCalls += 1;
    const verdict = { is_recruiter: true, confidence: 0.9, full_name: "Dana Holt", firm: "TalentBridge", companies_mentioned: ["Larkspur Robotics"], roles_discussed: ["Senior Backend Engineer"], summary: "Dana reached out about a backend role." };
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(verdict) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(aiResultCache).where(eq(aiResultCache.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
}

async function main() {
  await reset();
  const db = await getDb();
  let runs = 0;
  const answer = (v: string) => async () => {
    runs += 1;
    return v;
  };

  console.log("The cache");
  const first = await withAiResultCache(USER, "followup.draft", { q: "a" }, answer("one"), { ttlDays: 7 });
  const second = await withAiResultCache(USER, "followup.draft", { q: "a" }, answer("two"), { ttlDays: 7 });
  check("the same question twice runs the model once", runs === 1, `runs ${runs}`);
  check("  and replays the first answer", first === "one" && second === "one", `${first}/${second}`);

  await withAiResultCache(USER, "followup.draft", { q: "b" }, answer("three"), { ttlDays: 7 });
  check("a different question is a miss", runs === 2);
  await withAiResultCache(USER, "extension.parse", { q: "a" }, answer("four"), { ttlDays: 7 });
  check("the same inputs under another operation are a miss", runs === 3);
  await withAiResultCache(OTHER, "followup.draft", { q: "a" }, answer("five"), { ttlDays: 7 });
  check("another user never sees this user's answers", runs === 4);

  const regenerated = await withAiResultCache(USER, "followup.draft", { q: "a" }, answer("six"), { ttlDays: 7, fresh: true });
  const afterRegen = await withAiResultCache(USER, "followup.draft", { q: "a" }, answer("seven"), { ttlDays: 7 });
  check("fresh skips the read", regenerated === "six" && runs === 5);
  check("  but stores, so the next ask sees the latest answer", afterRegen === "six" && runs === 5);

  await withAiResultCache(USER, "recruiter.scan", { q: "bad" }, answer("{not json"), { ttlDays: 7, accept: () => false });
  await withAiResultCache(USER, "recruiter.scan", { q: "bad" }, answer("{not json"), { ttlDays: 7, accept: () => false });
  check("a rejected answer is never stored", runs === 7);
  const survived = await withAiResultCache(USER, "recruiter.scan", { q: "boom" }, answer("ok"), {
    ttlDays: 7,
    accept: () => {
      throw new Error("validator exploded");
    },
  });
  check("a validator that throws rejects, it does not fail the call", survived === "ok");

  await db
    .update(aiResultCache)
    .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
    .where(and(eq(aiResultCache.userId, USER), eq(aiResultCache.operation, "extension.parse")));
  await withAiResultCache(USER, "extension.parse", { q: "a" }, answer("fresh one"), { ttlDays: 7 });
  check("an answer past its TTL is a miss", runs === 9, `runs ${runs}`);

  process.env.ORBIT_AI_RESULT_CACHE = "off";
  await withAiResultCache(USER, "followup.draft", { q: "a" }, answer("eight"), { ttlDays: 7 });
  check("ORBIT_AI_RESULT_CACHE=off always runs the model", runs === 10);
  delete process.env.ORBIT_AI_RESULT_CACHE;

  await db.update(aiResultCache).set({ createdAt: new Date(Date.now() - 91 * 86_400_000) }).where(eq(aiResultCache.userId, OTHER));
  await pruneAiResultCache();
  const left = await db.select().from(aiResultCache).where(eq(aiResultCache.userId, OTHER));
  const kept = await db.select().from(aiResultCache).where(eq(aiResultCache.userId, USER));
  check("the sweep prunes answers older than the longest TTL", left.length === 0);
  check("  and keeps recent ones", kept.length > 0);

  console.log("\nA recruiter re-scan");
  await db.insert(userSettings).values({
    userId: USER, aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("smoke-cache-fake-key"),
  }).onConflictDoNothing();
  const sender = {
    senderName: "Dana Holt",
    senderEmail: "dana@talentbridge.example",
    firmGuess: "TalentBridge",
    messages: [{
      id: "m1", threadId: "t1", from: "Dana Holt <dana@talentbridge.example>", to: "me@example.com",
      subject: "Senior Backend Engineer at Larkspur", snippet: "Open to a chat?", internalDate: Date.parse("2026-08-01"),
      listUnsubscribe: "", listId: "", precedence: "", body: "Hi! I'm recruiting for a Senior Backend Engineer role at Larkspur Robotics.",
    }],
  };
  const v1 = await classifyRecruiterSender(USER, sender);
  const v2 = await classifyRecruiterSender(USER, sender);
  check("classifying an unchanged sender twice calls the model once", modelCalls === 1, `calls ${modelCalls}`);
  check("  with the same verdict", v1.isRecruiter && v2.isRecruiter && v2.firm === "TalentBridge");
  await classifyRecruiterSender(USER, {
    ...sender,
    messages: [...sender.messages, { ...sender.messages[0], id: "m2", subject: "Following up", body: "Any interest? The team is growing." }],
  });
  check("new mail from the sender is classified again", modelCalls === 2, `calls ${modelCalls}`);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AI result cache checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
