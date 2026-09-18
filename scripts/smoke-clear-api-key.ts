/**
 * Clearing one provider's key: only that key goes, and embeddings made by a provider that
 * is no longer the embedding backend are dropped, as saving a new key already does.
 * Drives the server action as demo mode's `demo-user`.
 *
 * Run: npx tsx scripts/smoke-clear-api-key.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off"; // no demo workspace seeding
process.env.VERCEL = "1"; // env provider keys must not count as "usable"

import { count, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, userSettings } from "../src/db/schema";
import { clearApiKey } from "../src/actions/settings";
import { encrypt } from "../src/lib/crypto";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function seed() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER,
    aiProvider: "anthropic",
    anthropicApiKeyEncrypted: encrypt("sk-ant-test"),
    openaiApiKeyEncrypted: encrypt("sk-openai-test"),
    geminiApiKeyEncrypted: encrypt("AIza-test"),
  });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Embedded Person" }).returning();
  await db.insert(contactEmbeddings).values({
    userId: USER, contactId: c.id, sourceType: "profile", sourceId: c.id, embedding: [0.1, 0.2], content: "Embedded Person",
  });
}

async function embeddingCount() {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  return row?.n ?? 0;
}

run(async () => {
  await seed();
  let result: Awaited<ReturnType<typeof clearApiKey>> | null = null;
  let thrown: unknown = null;
  try {
    result = await clearApiKey("openai");
  } catch (err) {
    thrown = err;
  }
  check("runs outside a request (no revalidatePath throw)", thrown === null, String(thrown));
  const db = await getDb();
  const s = (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) }))!;
  check("the OpenAI key is gone", s.openaiApiKeyEncrypted === null);
  check("the other keys stay", Boolean(s.geminiApiKeyEncrypted) && Boolean(s.anthropicApiKeyEncrypted));
  check("the selected provider is unchanged", s.aiProvider === "anthropic");
  check("the backend moved OpenAI → Gemini, so it reports a reset", result?.embeddingReset === true, JSON.stringify(result));
  check("…and the OpenAI-space vectors are gone", (await embeddingCount()) === 0);

  await seed();
  const same = await clearApiKey("anthropic");
  check("clearing a key that does not embed keeps the vectors", same.embeddingReset === false && (await embeddingCount()) === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll clear-key checks passed.");
});
