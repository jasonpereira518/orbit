/**
 * The knowledge base: what it counts, and how far its search reaches.
 *
 * Two things were quietly untrue on this page.
 *
 * The stats were derived from the same 500-row sample the page rendered, so "Messages"
 * stopped at 500 however many the user had — a number presented as a total. They are now
 * counted in the database.
 *
 * The search ran in the browser over whichever entries had been shipped (300 interactions,
 * plus contact-derived rows). Anything older simply could not be found: the user typed a
 * word they knew was in a note, and the page said "No matches for that search" while the
 * row sat in the table. It now filters in SQL, so the search reaches everything and the
 * page cap applies to the RESULTS rather than to what is searchable.
 *
 * The third thing here is parity. Legacy `interaction_type` values (`meeting_note`,
 * `coffee`, `linkedin`, `sms`) have to bucket the same way in the SQL that counts them as in
 * the TypeScript that labels them, or a stat disagrees with the list under it. The SQL
 * builds its IN-lists by running `knownInteractionTypeValues()` through the same
 * normalizer, and the checks below hold that end to end.
 *
 * Run: npx tsx scripts/smoke-knowledge.ts
 */
import "./smoke/_env";
Object.assign(process.env, { NODE_ENV: "development" });
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { getKnowledgeBase } from "../src/actions/knowledge";
import { KNOWLEDGE_PAGE_SIZE } from "../src/lib/knowledge-page";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const USER = "demo-user";
/** Comfortably past the page size, so "searchable" and "shipped" cannot be confused. */
const BULK = KNOWLEDGE_PAGE_SIZE + 40;
const NEEDLE = "zarquon-partial-index";

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [contact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Hassan Ali", company: "Notion" })
    .returning();

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // The needle is the OLDEST row, so it falls outside any page the server ships.
  await db.insert(interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "note",
    interactionDate: daysAgo(BULK + 100),
    rawNotes: `We talked about ${NEEDLE} and how it changes the query plan.`,
  });

  await db.insert(interactions).values(
    Array.from({ length: BULK }, (_, i) => ({
      userId: USER,
      contactId: contact.id,
      interactionType: "linkedin_message",
      interactionDate: daysAgo(i + 1),
      rawNotes: `message ${i}`,
    }))
  );

  // One of each legacy spelling, to pin SQL/TS bucketing parity.
  await db.insert(interactions).values([
    { userId: USER, contactId: contact.id, interactionType: "meeting_note", interactionDate: daysAgo(2), rawNotes: "legacy meeting note" },
    { userId: USER, contactId: contact.id, interactionType: "coffee", interactionDate: daysAgo(3), rawNotes: "legacy coffee" },
    { userId: USER, contactId: contact.id, interactionType: "sms", interactionDate: daysAgo(4), rawNotes: "legacy sms" },
  ]);

  section("Counts come from the database, not from a sample");

  const base = await getKnowledgeBase();
  check(
    "messages are counted past the old 500-row sample",
    base.stats.messages === BULK + 1,
    `got ${base.stats.messages}, expected ${BULK + 1} (${BULK} linkedin_message + 1 legacy sms)`
  );
  check(
    "legacy meeting spellings count as meetings",
    base.stats.meetings === 2,
    `got ${base.stats.meetings} — meeting_note and coffee both bucket as meetings`
  );
  check(
    "and the rest as notes",
    base.stats.notes === 1,
    `got ${base.stats.notes} — the one real note; the contact carries none of its own`
  );
  check("people is a real count", base.stats.people === 1);
  check(
    "the entries total covers every kind, not just the interaction ones",
    base.stats.entriesTotal === BULK + 4,
    `got ${base.stats.entriesTotal}, expected ${BULK + 4} — deriving it from messages+notes+meetings omitted summaries and key facts, which rendered as "Showing 94 of 64 items"`
  );
  check(
    "and it is never smaller than what the page shows",
    base.stats.entriesTotal >= base.entries.length
  );

  section("The page still ships a page");

  check(
    "entries are capped",
    base.entries.length <= KNOWLEDGE_PAGE_SIZE + 10,
    `got ${base.entries.length}`
  );
  check(
    "newest first",
    base.entries.length > 1 &&
      new Date(base.entries[0].date!).getTime() >=
        new Date(base.entries[base.entries.length - 1].date!).getTime()
  );

  section("Search reaches past what the page shipped");

  const shipped = base.entries.some((e) => e.snippet.includes(NEEDLE));
  check(
    "the needle is NOT in the default page",
    !shipped,
    "if it were shipped anyway, the next check would pass without proving anything"
  );

  const found = await getKnowledgeBase({ q: NEEDLE });
  check(
    "but searching finds it",
    found.entries.some((e) => e.snippet.includes(NEEDLE)),
    `got ${found.entries.length} entries — this is the bug: the row existed and the page said "No matches"`
  );
  check(
    "stats still describe the whole base, not the result",
    found.stats.messages === base.stats.messages,
    "the header counts answer 'what does Orbit know', which a search does not change"
  );

  section("Searching by person, and by kind");

  const byName = await getKnowledgeBase({ q: "Hassan" });
  check("a contact's name matches their knowledge", byName.entries.length > 0);

  const notesOnly = await getKnowledgeBase({ kind: "note" });
  check(
    "a kind filter returns only that kind",
    notesOnly.entries.length > 0 && notesOnly.entries.every((e) => e.kind === "note"),
    `got kinds ${[...new Set(notesOnly.entries.map((e) => e.kind))].join(",")}`
  );

  const nothing = await getKnowledgeBase({ q: "no-such-term-anywhere" });
  check("a genuine miss is empty", nothing.entries.length === 0);
  check("and says so without lying about the totals", nothing.stats.people === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll knowledge-base checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
