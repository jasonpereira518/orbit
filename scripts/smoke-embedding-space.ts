/**
 * Vectors from two embedding models are not comparable. The model that made each stored
 * vector is recorded, a vector another model made is queued to be made again, and a key change
 * clears the passage vectors it used to leave behind. Local PGlite, stubbed embeddings.
 * Run: npx tsx scripts/smoke-embedding-space.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, memoryChunks, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { reconcileEmbeddingSpace } from "../src/lib/embedding-backfill";
import { clearMemoryChunkVectors } from "../src/lib/memory-chunks";
import { computeContentHash, upsertContactEmbedding } from "../src/lib/search";

const USER = "smoke-embedding-space-user";
const OLD = "gemini-embedding-001";
const NEW = "text-embedding-3-small";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, USER));
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "openai", aiModel: "gpt-4.1-mini", openaiApiKeyEncrypted: encrypt("fake-openai") });

  const [oldC] = await db.insert(contacts).values({ userId: USER, fullName: "Old Space" }).returning();
  const [sameC] = await db.insert(contacts).values({ userId: USER, fullName: "Same Space" }).returning();
  const [legacyC] = await db.insert(contacts).values({ userId: USER, fullName: "Legacy Unstamped" }).returning();
  const row = (contactId: string, embeddingModel: string | null) => ({
    userId: USER, contactId, sourceType: "profile", sourceId: contactId, embedding: [1, 0], content: "x", contentHash: "h", embeddingModel,
  });
  await db.insert(contactEmbeddings).values([row(oldC!.id, OLD), row(sameC!.id, NEW), row(legacyC!.id, null)]);

  const chunk = (n: number, embeddingModel: string | null) => ({
    userId: USER, sourceKind: "interaction" as const, sourceId: oldC!.id, chunkIndex: n, content: `c${n}`, contentHash: `h${n}`,
    embedding: [1, 0], embeddedHash: `h${n}`, embeddingModel,
  });
  await db.insert(memoryChunks).values([chunk(0, OLD), chunk(1, NEW), chunk(2, null)]);

  console.log("Reconcile");
  await reconcileEmbeddingSpace(USER, NEW);
  const left = await db.select().from(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  const names = new Set(left.map((r) => r.contactId));
  check("a vector another model made is removed", !names.has(oldC!.id));
  check("one this model made is kept", names.has(sameC!.id));
  check("an unstamped legacy vector is left alone (unknown, not wrong)", names.has(legacyC!.id));
  const [oldAfter] = await db.select().from(contacts).where(eq(contacts.id, oldC!.id));
  const [sameAfter] = await db.select().from(contacts).where(eq(contacts.id, sameC!.id));
  check("the contact it belonged to is queued to be embedded again", oldAfter?.embeddingStaleAt != null);
  check("contacts whose vectors are fine are not", sameAfter?.embeddingStaleAt == null);

  const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.userId, USER));
  const by = (n: number) => chunks.find((c) => c.chunkIndex === n)!;
  check("a passage another model embedded is un-embedded, so it is pending again", by(0).embedding === null && by(0).embeddedHash === null);
  check("a passage this model embedded keeps its vector", by(1).embedding !== null && by(1).embeddedHash === "h1");
  check("an unstamped passage is left alone", by(2).embedding !== null);

  await reconcileEmbeddingSpace(USER, null);
  check("an account with no embedding model changes nothing", (await db.select().from(contactEmbeddings).where(eq(contactEmbeddings.userId, USER))).length === left.length);

  console.log("\nWrites carry the model");
  const stub = async () => [0.1, 0.2];
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  const content = "Founder at Halcyon";
  await upsertContactEmbedding(USER, legacyC!.id, "profile", content, legacyC!.id, stub as never);
  let stored = await db.query.contactEmbeddings.findFirst({ where: and(eq(contactEmbeddings.userId, USER), eq(contactEmbeddings.contactId, legacyC!.id)) });
  check("a new vector records the account's embedding model", stored?.embeddingModel === NEW, String(stored?.embeddingModel));

  await db.update(contactEmbeddings).set({ embeddingModel: OLD, contentHash: computeContentHash(content) }).where(eq(contactEmbeddings.id, stored!.id));
  let calls = 0;
  const counting = async () => { calls++; return [0.3, 0.4]; };
  const redone = await upsertContactEmbedding(USER, legacyC!.id, "profile", content, legacyC!.id, counting as never);
  stored = await db.query.contactEmbeddings.findFirst({ where: eq(contactEmbeddings.id, stored!.id) });
  check("the same text from another model's vector is embedded again", redone && calls === 1 && stored?.embeddingModel === NEW, `calls=${calls} model=${stored?.embeddingModel}`);
  const skipped = await upsertContactEmbedding(USER, legacyC!.id, "profile", content, legacyC!.id, counting as never);
  check("and once current, unchanged text is skipped as before", !skipped && calls === 1);

  console.log("\nA key change");
  await clearMemoryChunkVectors(USER);
  const cleared = await db.select().from(memoryChunks).where(eq(memoryChunks.userId, USER));
  check("clears every passage vector, whatever its stamp", cleared.every((c) => c.embedding === null && c.embeddedHash === null && c.embeddingModel === null));
  check("and keeps the passages themselves", cleared.length === 3);

  await db.delete(memoryChunks).where(eq(memoryChunks.userId, USER));
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll embedding-space checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
