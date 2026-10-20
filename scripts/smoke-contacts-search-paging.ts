/**
 * A search on the contacts page lists name matches first in every sort, and keyset paging
 * (one row per page here) neither skips nor repeats anyone across the tier boundary.
 * Run: npx tsx scripts/smoke-contacts-search-paging.ts
 */
import "./smoke/_env";

import { and, eq, type SQL } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { contactsListSelection } from "../src/lib/contact-avatar-sql";
import { contactSearchCondition, nameMatchTierSql } from "../src/lib/contact-search-rank";
import {
  contactsCursorCondition,
  contactsCursorFor,
  contactsOrderBy,
  decodeContactsCursor,
  encodeContactsCursor,
  type ContactsCursor,
} from "../src/lib/contacts-page-cursor";
import type { ContactSort } from "../src/lib/contacts-page";
import { run } from "./smoke/_env";

const U = "smoke-contacts-search-paging-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** listContactsPage's query, one row per page (limit 1, fetch 2). */
async function walk(sort: ContactSort, q: string): Promise<string[]> {
  const db = await getDb();
  const tier = nameMatchTierSql(q);
  const seen: string[] = [];
  let raw: string | undefined;
  for (let i = 0; i < 20; i++) {
    const cursor = decodeContactsCursor(raw, sort, true);
    const conditions: SQL[] = [eq(contacts.userId, U), contactSearchCondition(q)];
    if (cursor) conditions.push(contactsCursorCondition(cursor, tier));
    const rows = await db
      .select({ ...contactsListSelection, nameTier: tier })
      .from(contacts)
      .where(and(...conditions))
      .orderBy(...contactsOrderBy(sort, tier))
      .limit(2);
    const page = rows.slice(0, 1);
    seen.push(...page.map((r) => r.fullName));
    if (rows.length <= 1) break;
    raw = encodeContactsCursor(contactsCursorFor(sort, page[0], true));
  }
  return seen;
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.insert(contacts).values([
    { userId: U, fullName: "Priya Raman", closeness: 95, updatedAt: new Date("2026-09-02T12:00:00Z") },
    { userId: U, fullName: "Priya Nair", closeness: 90, updatedAt: new Date("2026-09-01T12:00:00Z") },
    { userId: U, fullName: "Priyanka Das", closeness: 50, updatedAt: new Date("2026-09-03T12:00:00Z") },
    { userId: U, fullName: "Hassan Ali", closeness: 99, updatedAt: new Date("2026-09-04T12:00:00Z"), notes: "Met through Priya at the Durham founders dinner." },
  ]);

  const expect = {
    name: ["Priya Nair", "Priya Raman", "Priyanka Das", "Hassan Ali"],
    closeness: ["Priya Raman", "Priya Nair", "Priyanka Das", "Hassan Ali"],
    recent: ["Priya Raman", "Priya Nair", "Priyanka Das", "Hassan Ali"],
  } as const;
  for (const sort of ["name", "closeness", "recent"] as const) {
    const got = await walk(sort, "Priya");
    check(`${sort}: name tiers lead, the notes mention is last, nobody twice`, JSON.stringify(got) === JSON.stringify(expect[sort]), JSON.stringify(got));
  }

  const plain = encodeContactsCursor({ s: "name", k: "ali", n: "Hassan Ali", id: "00000000-0000-0000-0000-000000000000" });
  check("a cursor minted without a search is refused by a search", decodeContactsCursor(plain, "name", true) === null);
  check("and accepted without one", decodeContactsCursor(plain, "name", false) !== null);
  check("no search, no tier in the ORDER BY", contactsOrderBy("name", null).length === 3);

  // The default when searching (main's #188): one ranked page from hybrid search, no cursor.
  // The name tier leads the rank too, so a name match the ranking never produced (a short
  // query, or a literal-only hit) still sits above a prose-only row the ranking did produce.
  const tier = nameMatchTierSql("Priya");
  const byName = new Map((await db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(eq(contacts.userId, U))).map((r) => [r.fullName, r.id]));
  const rankedOnlyHassan = [byName.get("Hassan Ali")!];
  const relevance = await db
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.userId, U), contactSearchCondition("Priya")))
    .orderBy(...contactsOrderBy("relevance", tier, rankedOnlyHassan));
  check(
    "relevance: name tiers still lead a ranking that only produced the notes mention",
    JSON.stringify(relevance.map((r) => r.fullName)) === JSON.stringify(["Priya Nair", "Priya Raman", "Priyanka Das", "Hassan Ali"]),
    JSON.stringify(relevance.map((r) => r.fullName))
  );
  const noQuery = contactsOrderBy("relevance", null, rankedOnlyHassan);
  check("relevance without a search is rank, then name", noQuery.length === 4);
  check("relevance never takes a cursor", decodeContactsCursor(plain, "relevance", true) === null);

  // Cursor fields are all shape-checked (audit L-11): a tampered cursor starts over, it never
  // reaches a uuid cast or `new Date()` as a 500.
  const forge = (o: object) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  check("a cursor whose id is not a uuid is refused", decodeContactsCursor(forge({ s: "name", k: "a", n: "A", id: "x' or 1=1" }), "name", false) === null);
  check("a recent cursor with an unreadable date is refused", decodeContactsCursor(forge({ s: "recent", u: "garbage", id: "00000000-0000-0000-0000-000000000000" }), "recent", false) === null);
  check("a closeness cursor with a non-number score is refused", decodeContactsCursor(forge({ s: "closeness", c: "high", id: "00000000-0000-0000-0000-000000000000" }), "closeness", false) === null);
  check("a closeness cursor in the unscored tail (c=null) is accepted", decodeContactsCursor(forge({ s: "closeness", c: null, id: "00000000-0000-0000-0000-000000000000" }), "closeness", false) !== null);
  check("base64 garbage is refused", decodeContactsCursor("%%%not-base64", "name", false) === null);

  // The closeness walk reaches every contact when some are unscored (audit M-12). Bulk
  // imports leave closeness NULL until the hourly recalibration; NULLs sorted first and a
  // cursor built from one excluded every scored contact, so the list stopped at page one.
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.insert(contacts).values([
    ...Array.from({ length: 23 }, (_, i) => ({ userId: U, fullName: `Scored ${i}`, closeness: 10 + i })),
    ...Array.from({ length: 23 }, (_, i) => ({ userId: U, fullName: `Unscored ${i}`, closeness: null })),
  ]);
  const seen: { id: string; closeness: number | null }[] = [];
  let cursor: ContactsCursor | null = null;
  for (let page = 0; page < 20; page++) {
    const rows: { id: string; closeness: number | null }[] = await db
      .select({ id: contacts.id, closeness: contacts.closeness })
      .from(contacts)
      .where(and(eq(contacts.userId, U), cursor ? contactsCursorCondition(cursor, null) : undefined))
      .orderBy(...contactsOrderBy("closeness", null))
      .limit(10);
    seen.push(...rows);
    if (rows.length < 10) break;
    const last = rows[rows.length - 1]!;
    cursor = contactsCursorFor("closeness", { id: last.id, closeness: last.closeness, sortKey: null, fullName: "", updatedAt: new Date(), lastInteractionAt: null, nameTier: 0 }, false);
  }
  check("the closeness walk reaches all 46 contacts across pages", seen.length === 46 && new Set(seen.map((r) => r.id)).size === 46, `${seen.length} rows, ${new Set(seen.map((r) => r.id)).size} distinct`);
  const firstNull = seen.findIndex((r) => r.closeness === null);
  check("scored contacts come first, highest first; unscored ones last", firstNull === 23 && seen.slice(0, 23).every((r, i, a) => i === 0 || (a[i - 1]!.closeness ?? 0) >= (r.closeness ?? 0)), `first null at ${firstNull}`);

  await db.delete(contacts).where(eq(contacts.userId, U));
});
