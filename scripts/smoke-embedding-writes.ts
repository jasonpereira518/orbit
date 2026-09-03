/**
 * Verifies content-hash skip and batched embedding writes against local PGlite.
 * Uses an injected stub embedder — no AI calls. Stop dev servers first.
 * Run: npx tsx scripts/smoke-embedding-writes.ts
 */
import "./smoke/_env";

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

  // --- Split logic: content over the 8,000-char embedding truncation gets its "notes"
  // pulled into a separate row, and that split un-does itself when notes shrink back. ---

  const [turing] = await db
    .insert(contacts)
    .values([{ userId: U, fullName: "Alan Turing", company: "Bletchley Park" }])
    .returning();
  const turingId = turing.id;

  const longNotesA = "N".repeat(8100);
  await db.update(contacts).set({ notes: longNotesA }).where(eq(contacts.id, turingId));

  const callsBeforeSplit = embedCalls;
  const textsBeforeSplit = embeddedTexts;
  await rebuildContactEmbeddingsBatch(U, [turingId], stubEmbed);
  check("split rebuild issues exactly one embedding batch call", embedCalls - callsBeforeSplit === 1);
  check("split rebuild embeds exactly two texts (profile + notes)", embeddedTexts - textsBeforeSplit === 2);

  const splitRows = await db.query.contactEmbeddings.findMany({
    where: and(eq(contactEmbeddings.userId, U), eq(contactEmbeddings.contactId, turingId)),
  });
  check("split writes two rows", splitRows.length === 2);
  const profileRow = splitRows.find((r) => r.sourceType === "profile");
  const notesRow = splitRows.find((r) => r.sourceType === "notes");
  check("profile row exists after split", Boolean(profileRow));
  check("notes row exists after split", Boolean(notesRow));
  check(
    "profile row content does not contain the notes text",
    Boolean(profileRow) && !profileRow!.content.includes(longNotesA)
  );
  check(
    "both split rows have 64-char content hashes",
    profileRow?.contentHash?.length === 64 && notesRow?.contentHash?.length === 64
  );

  // Notes-only change while still over threshold: only the notes row re-embeds.
  const longNotesB = "M".repeat(8100);
  await db.update(contacts).set({ notes: longNotesB }).where(eq(contacts.id, turingId));
  const textsBeforeNotesEdit = embeddedTexts;
  await rebuildContactEmbeddingsBatch(U, [turingId], stubEmbed);
  check("notes-only edit re-embeds exactly one text", embeddedTexts - textsBeforeNotesEdit === 1);

  const afterNotesEdit = await db.query.contactEmbeddings.findMany({
    where: and(eq(contactEmbeddings.userId, U), eq(contactEmbeddings.contactId, turingId)),
  });
  check("still two rows after notes-only edit", afterNotesEdit.length === 2);

  // Shrink notes back under the threshold: the split un-does itself.
  const shortNotes = "Cracked Enigma.";
  await db.update(contacts).set({ notes: shortNotes }).where(eq(contacts.id, turingId));
  const textsBeforeShrink = embeddedTexts;
  await rebuildContactEmbeddingsBatch(U, [turingId], stubEmbed);
  check("shrink re-embeds exactly one text (profile only)", embeddedTexts - textsBeforeShrink === 1);

  const afterShrink = await db.query.contactEmbeddings.findMany({
    where: and(eq(contactEmbeddings.userId, U), eq(contactEmbeddings.contactId, turingId)),
  });
  check("notes row is gone after shrink", !afterShrink.some((r) => r.sourceType === "notes"));
  const profileAfterShrink = afterShrink.find((r) => r.sourceType === "profile");
  check(
    "profile row now contains the short notes",
    Boolean(profileAfterShrink) && profileAfterShrink!.content.includes(shortNotes)
  );

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
