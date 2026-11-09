/**
 * A follow-up draft that AI cannot run for returns the refusal as data, so the sheet can show
 * the shared notice; thrown, production digests it into a generic failure.
 *
 * Run: npx tsx scripts/smoke-draft-follow-up-result.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-draft-result";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { contacts, userSettings } = await import("../src/db/schema");
  const { draftFollowUpResult, normalizePurpose } = await import("../src/lib/follow-up-drafts");
  check("normalizePurpose keeps the first line only", normalizePurpose("a\nb") === "a");
  check("normalizePurpose caps at 140", normalizePurpose("x".repeat(300)).length <= 140);
  check("normalizePurpose of a non-string is empty", normalizePurpose(42) === "" && normalizePurpose(undefined) === "");

  // A reply with no purpose key still returns the body.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/generativelanguage/.test(url)) return realFetch(input, init);
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ body: "Just a body." }) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
  }) as typeof fetch;
  const db = await getDb();
  const clean = async () => {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  };
  await clean();
  // Lifetime with no key: refused as key_required whatever keys the environment holds.
  await db.insert(userSettings).values({ userId: USER, lifetimePurchasedAt: new Date("2026-01-01T00:00:00Z") });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Draft", firstName: "Ada", lastName: "Draft" }).returning();
  try {
    const res = await draftFollowUpResult(USER, c.id, [], {});
    check("an AI refusal comes back as { ok: false } with the shared copy", res.ok === false && /API key/.test(res.error), res);
    await db.update(userSettings).set({
      lifetimePurchasedAt: null,
      aiProvider: "gemini",
      aiModel: "gemini-3.5-flash",
      geminiApiKeyEncrypted: (await import("../src/lib/crypto")).encrypt("fake-gemini"),
    }).where(eq(userSettings.userId, USER));
    const ok = await draftFollowUpResult(USER, c.id, [], {});
    check("a reply with no purpose still returns the body", ok.ok === true && ok.body === "Just a body." && ok.purpose === "", ok);
  } finally {
    await clean();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ndraft-follow-up-result: ok");
  process.exit(0);
});
