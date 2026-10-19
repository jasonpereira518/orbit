/**
 * A batch of outreach drafts: one bad draft is that prospect's alone, a failure every draft
 * would repeat stops the batch early, and a batch where nothing was drafted says why.
 * Local PGlite, stubbed Gemini. Run: npx tsx scripts/smoke-outreach-batch.ts
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { generateOutreachDraftsBatch, type DraftInput } from "../src/lib/outreach-drafts";

const USER = "smoke-outreach-batch-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Replies, one per model call, in order; "rate" answers 429. */
let script: Array<"ok" | "bad" | "rate"> = [];
let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/generativelanguage/.test(url)) return realFetch(input, init);
  calls++;
  const next = script.shift() ?? "ok";
  if (next === "rate") {
    return Response.json({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
  }
  const text = next === "bad" ? JSON.stringify({ subject: "Hi", body: 5 }) : JSON.stringify({ subject: "Hello", body: "A short, specific note." });
  return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}) as typeof fetch;

const input = (name: string): DraftInput => ({
  channel: "email", tone: "professional", messageIntent: "Intro", userGoals: [],
  prospect: { fullName: name, title: null, company: null, location: null },
});

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "gemini", aiModel: "gemini-3.8-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") });
  const four = ["A", "B", "C", "D"].map(input);

  script = ["ok", "bad", "ok", "ok"];
  calls = 0;
  const mixed = await generateOutreachDraftsBatch(USER, four, 1);
  check("one malformed draft is that prospect's alone", mixed.filter(Boolean).length === 3 && mixed[1] === null, JSON.stringify(mixed.map((m) => m !== null)));
  check("…and the others are still drafted", calls === 4);

  script = ["ok", "rate", "ok", "ok"];
  calls = 0;
  const limited = await generateOutreachDraftsBatch(USER, four, 1);
  check("a rate limit stops new drafts being started", calls === 2, String(calls));
  check("…keeping what was already drafted", limited[0] !== null && limited.slice(1).every((d) => d === null));

  script = ["rate"];
  let thrown: unknown = null;
  try {
    await generateOutreachDraftsBatch(USER, four, 1);
  } catch (err) {
    thrown = err;
  }
  check("when nothing was drafted the error is thrown, not an empty result", thrown instanceof Error);

  script = [];
  check("an empty batch is an empty result", (await generateOutreachDraftsBatch(USER, [], 1)).length === 0);

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach batch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
