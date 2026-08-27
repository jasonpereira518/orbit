/**
 * Verifies content-hash skip and batched embedding writes against local PGlite.
 * Uses an injected stub embedder — no AI calls. Stop dev servers first.
 * Run: npx tsx scripts/smoke-embedding-writes.ts
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactEmbeddings } from "../src/db/schema";
import { computeContentHash, rebuildContactEmbeddingsBatch } from "../src/lib/search";

const U = "smoke-embedwrites-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));

  const inserted = await db.insert(contacts).values([
    { userId: U, fullName: "Ada Lovelace", company: "Analytical Engines" },
    { userId: U, fullName: "Grace Hopper", company: "Navy Research" },
  ]).returning();
  const ids = inserted.map((c) => c.id);

  check("hash is deterministic", computeContentHash("abc") === computeContentHash("abc"));
  check("hash differs on content", computeContentHash("abc") !== computeContentHash("abd"));

  let embedCalls = 0;
  let embeddedTexts = 0;
  const stubEmbed = async (_userId: string, texts: string[]) => {
    embedCalls += 1;
    embeddedTexts += texts.length;
    return texts.map((_, i) => [i + 1, 0.5, 0.25]);
  };

  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("first rebuild embeds both contacts", embeddedTexts === 2);

  const rows = await db.query.contactEmbeddings.findMany({
    where: and(eq(contactEmbeddings.userId, U), eq(contactEmbeddings.sourceType, "profile")),
  });
  check("two profile rows written", rows.length === 2);
  check("content_hash populated", rows.every((r) => typeof r.contentHash === "string" && r.contentHash!.length === 64));

  // Second rebuild with unchanged content: zero embedding work.
  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("unchanged rebuild embeds nothing", embeddedTexts === 2);

  // Change one contact; only that one re-embeds.
  await db.update(contacts).set({ notes: "Now writes compilers." }).where(eq(contacts.id, ids[0]));
  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("only changed contact re-embeds", embeddedTexts === 3);

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
