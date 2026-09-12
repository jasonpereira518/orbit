/**
 * Verifies content-hash skip and batched embedding writes against local PGlite.
 * Uses an injected stub embedder — no AI calls. Stop dev servers first.
 * Run: npx tsx scripts/smoke-embedding-writes.ts
 */
import "./smoke/_env";

import { eq, and } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactEmbeddings } from "../src/db/schema";
import { saveContactProfile } from "../src/lib/contact-profile";
import {
  computeContentHash,
  rebuildContactEmbedding,
  rebuildContactEmbeddingsBatch,
} from "../src/lib/search";

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

  // --- Immediate rebuild path must not drop profile text -------------------------
  //
  // The Task 5 fix-round-1 gap: `saveContactProfile` only flags `embeddingStaleAt` and
  // lets the backfill catch up eventually, but every ordinary contact write (an edit, a
  // note, an extension re-save, a brief regenerate) fires `rebuildContactEmbedding` /
  // `rebuildContactEmbeddingsBatch` immediately, on its own claim query. If THAT query's
  // `with:` is missing `profile`/`experiences`, a contact who already has a captured
  // profile gets its embedding overwritten with content that has silently lost the
  // headline, the About, and the career line the moment anything else about the contact
  // changes — even though the backfill path (proven separately in
  // smoke-embedding-backfill.ts) is completely healthy. This section drives both
  // immediate-rebuild entry points for real, not the backfill.
  const [batchContact] = await db
    .insert(contacts)
    .values([{ userId: U, fullName: "Batch Rebuild Contact" }])
    .returning();
  await saveContactProfile(U, batchContact.id, {
    source: "extension",
    sourceUrl: null,
    adapterVersion: "linkedin-2",
    capturedAt: new Date(),
    warnings: [],
    headline: "Batch Path Headline",
    about: "Batch path about text.",
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Batch Past Employer LLC", title: "Engineer",
        startYear: 2015, startMonth: null, endYear: 2019, endMonth: null,
        isCurrent: false, location: null, description: null, fieldOfStudy: null },
    ],
  });
  // `saveContactProfile` already flags the contact stale; drive the IMMEDIATE rebuild
  // path directly (as contact-writes.ts / extension/writes.ts do after an ordinary write)
  // rather than the backfill.
  await rebuildContactEmbeddingsBatch(U, [batchContact.id], stubEmbed);
  const batchRow = await db.query.contactEmbeddings.findFirst({
    where: and(
      eq(contactEmbeddings.userId, U),
      eq(contactEmbeddings.contactId, batchContact.id),
      eq(contactEmbeddings.sourceType, "profile")
    ),
  });
  check(
    "rebuildContactEmbeddingsBatch preserves profile headline",
    Boolean(batchRow?.content.includes("Batch Path Headline")),
    batchRow?.content ?? "no row"
  );
  check(
    "rebuildContactEmbeddingsBatch preserves the past employer via the career line",
    Boolean(batchRow?.content.includes("Batch Past Employer LLC")),
    batchRow?.content ?? "no row"
  );

  const [singleContact] = await db
    .insert(contacts)
    .values([{ userId: U, fullName: "Single Rebuild Contact" }])
    .returning();
  await saveContactProfile(U, singleContact.id, {
    source: "extension",
    sourceUrl: null,
    adapterVersion: "linkedin-2",
    capturedAt: new Date(),
    warnings: [],
    headline: "Single Path Headline",
    about: "Single path about text.",
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Single Past Employer LLC", title: "Engineer",
        startYear: 2012, startMonth: null, endYear: 2018, endMonth: null,
        isCurrent: false, location: null, description: null, fieldOfStudy: null },
    ],
  });
  // `rebuildContactEmbedding` (singular) is the OTHER immediate-rebuild entry point —
  // called from contact-writes.ts, extension/writes.ts, contact-brief.ts, and
  // actions/graph.ts on their own claim query, independent of the batch function above.
  // Unlike the batch function it has no test seam of its own before this fix round — it
  // calls the real `createEmbedding` via `upsertContactEmbedding`, which has no live AI
  // key in this environment and would otherwise catch that failure silently and return
  // false, making the claim-query fix unprovable here. `embed` is now injectable the same
  // way `embedFn` already is on the batch function, purely so this can be driven for real.
  const stubSingleEmbed = async (_userId: string, _text: string) => [1, 0.5, 0.25];
  await rebuildContactEmbedding(U, singleContact.id, stubSingleEmbed);
  const singleRow = await db.query.contactEmbeddings.findFirst({
    where: and(
      eq(contactEmbeddings.userId, U),
      eq(contactEmbeddings.contactId, singleContact.id),
      eq(contactEmbeddings.sourceType, "profile")
    ),
  });
  check(
    "rebuildContactEmbedding (singular) preserves profile headline",
    Boolean(singleRow?.content.includes("Single Path Headline")),
    singleRow?.content ?? "no row"
  );
  check(
    "rebuildContactEmbedding (singular) preserves the past employer via the career line",
    Boolean(singleRow?.content.includes("Single Past Employer LLC")),
    singleRow?.content ?? "no row"
  );

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
