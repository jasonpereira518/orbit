/**
 * The import detail sheet's people list: who an import added, and who it matched to someone
 * already in Orbit (`src/lib/imports/import-people.ts`).
 *
 * The split is derived, not stored — `contacts.created_at` against `imports.created_at` — so
 * this pins the edges that derivation has to get right: one person behind many rows counts
 * once, skipped/failed rows and deleted contacts are not listed, another user's contact
 * behind a forged row never leaks, people carried in `payload.contactIds` (a Drive doc's
 * extra names) are listed, and paging stops exactly at the end.
 *
 * Run: npx tsx scripts/smoke-import-people.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, importJobRows, imports } from "../src/db/schema";
import {
  IMPORT_PEOPLE_PAGE,
  countImportPeople,
  listImportPeople,
} from "../src/lib/imports/import-people";

const USER = "smoke-import-people-user";
const OTHER = "smoke-import-people-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await db.delete(imports).where(inArray(imports.userId, [USER, OTHER]));
}

async function main() {
  await reset();
  const db = await getDb();

  const importAt = new Date("2026-09-01T12:00:00Z");
  const before = new Date("2026-08-01T12:00:00Z");
  const after = new Date("2026-09-01T12:05:00Z");

  const [imp] = await db
    .insert(imports)
    .values({ userId: USER, importType: "linkedin_connections", status: "completed", createdAt: importAt })
    .returning();

  const mk = (userId: string, fullName: string, createdAt: Date, extra: Partial<typeof contacts.$inferInsert> = {}) =>
    db
      .insert(contacts)
      .values({ userId, fullName, createdAt, ...extra })
      .returning()
      .then((r) => r[0].id);

  const old = await mk(USER, "Olive Old", before, { title: "Designer", company: "Acme" });
  const fresh = await mk(USER, "Ben New", after, { company: "Globex" });
  const skippedOne = await mk(USER, "Sam Skipped", after);
  const gone = await mk(USER, "Gina Gone", after);
  const foreign = await mk(OTHER, "Oscar Other", after);
  const carried = await mk(USER, "Cara Carried", after);
  const carriedSkipped = await mk(USER, "Carl Skipped", after);

  let i = 0;
  const row = (contactId: string | null, status = "done", payload: object = {}) => ({
    importId: imp.id,
    userId: USER,
    rowIndex: i++,
    payload: payload as never,
    status,
    contactId,
  });
  await db.insert(importJobRows).values([
    row(old),
    row(fresh),
    row(fresh), // a second thread with the same person
    row(skippedOne, "skipped"),
    row(null, "failed"),
    row(gone),
    row(foreign), // forged: points at another user's contact
    row(null, "done", { contactIds: [carried] }), // a Drive doc: people ride the payload
    row(null, "skipped", { contactIds: [carriedSkipped] }), // not done, so not listed
  ]);
  await db.delete(contacts).where(eq(contacts.id, gone));

  const counts = await countImportPeople(USER, imp.id, importAt);
  check("counts two added, one already here", counts.added === 2 && counts.existing === 1, JSON.stringify(counts));

  const added = await listImportPeople(USER, imp.id, "added");
  const addedIds = added.people.map((p) => p.id).sort();
  check(
    "added lists the new person once, plus the one carried in a payload",
    added.people.length === 2 && JSON.stringify(addedIds) === JSON.stringify([fresh, carried].sort()),
    JSON.stringify(added),
  );
  check("company alone is the detail", added.people.find((p) => p.id === fresh)?.detail === "Globex");
  check("no more after two", added.hasMore === false);

  const existing = await listImportPeople(USER, imp.id, "existing");
  check("already-here lists the matched person", existing.people.length === 1 && existing.people[0].id === old);
  check("title and company read as a line", existing.people[0].detail === "Designer at Acme");

  const stranger = await listImportPeople(OTHER, imp.id, "added");
  check("another user sees nothing of this import", stranger.people.length === 0);

  // Paging: exactly one page, then one more.
  const bulk = await Promise.all(
    Array.from({ length: IMPORT_PEOPLE_PAGE + 1 }, (_, n) =>
      mk(USER, `Bulk ${String(n).padStart(3, "0")}`, after),
    ),
  );
  await db.insert(importJobRows).values(bulk.map((id) => row(id)));
  const page1 = await listImportPeople(USER, imp.id, "added");
  check("first page is full and offers more", page1.people.length === IMPORT_PEOPLE_PAGE && page1.hasMore);
  const page2 = await listImportPeople(USER, imp.id, "added", page1.people.length);
  check("second page holds the rest and stops", page2.people.length === 3 && !page2.hasMore, JSON.stringify(page2.people.map((p) => p.name)));
  const seen = new Set([...page1.people, ...page2.people].map((p) => p.id));
  check("pages don't overlap", seen.size === IMPORT_PEOPLE_PAGE + 3);

  await reset();
  console.log("smoke-import-people: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
