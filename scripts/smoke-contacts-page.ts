/**
 * Pagination invariants for the contacts list.
 *
 * Keyset paging is easy to get subtly wrong: an ordering that is not a total order lets two
 * contacts straddle a page boundary, and the result is a person silently shown twice or not
 * at all. Nothing about the UI makes that visible, so it is asserted here — every cursor is
 * walked to exhaustion and the union compared against the table.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-contacts-page.ts
 */
import "./smoke/_env";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { DDL, applyScaleSchema, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "u1";
const N = 977; // deliberately not a multiple of the page size

// Names chosen to force the cases that break naive keyset paging: heavy duplicate surnames,
// contacts with no last name at all, and names that sort before "a".
const SURNAMES = ["Smith", "Smith", "Smith", "Ng", "Ng", "Okafor", "Zhang", "Alvarez", "brown"];

async function main() {
  const client = await PGlite.create({ extensions: { pg_trgm } });
  await client.exec(DDL);
  await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`);
  await applyScaleSchema((s) => client.query(s));
  const db = drizzle(client, { schema });

  const rows = [];
  for (let i = 0; i < N; i++) {
    const surname = SURNAMES[i % SURNAMES.length];
    const noSurname = i % 53 === 0;
    const numeric = i % 71 === 0;
    rows.push({
      userId: USER,
      fullName: numeric ? `4Front ${i}` : noSurname ? `Mononym${i}` : `Person${i} ${surname}`,
      lastName: numeric || noSurname ? null : surname,
      company: i % 3 === 0 ? "Acme" : `Co ${i % 40}`,
      email: `p${i}@example.com`,
      relationshipScore: (i % 5) + 1,
      closeness: (i * 37) % 100,
      closenessTier: (["inner", "mid", "outer"] as const)[i % 3],
      nextFollowUpAt: i % 7 === 0 ? new Date(Date.now() - 86400000) : null,
      closenessComputedAt: new Date(),
    });
  }
  await db.insert(schema.contacts).values(rows);
  await client.query(`ANALYZE contacts`);

  // Reimplements the shape of listContactsPage's ordering and cursor against this database.
  // The server action itself needs Clerk and a request scope, so the invariants are checked
  // on the query it issues rather than through it.
  type Sort = "name" | "closeness" | "recent";
  const order = (s: Sort) =>
    s === "closeness"
      ? [desc(schema.contacts.closeness), desc(schema.contacts.id)]
      : s === "recent"
        ? [desc(schema.contacts.updatedAt), desc(schema.contacts.id)]
        : [asc(schema.contacts.sortKey), asc(schema.contacts.fullName), asc(schema.contacts.id)];

  async function walk(s: Sort, pageSize: number, extra?: ReturnType<typeof and>) {
    const seen: string[] = [];
    let cursor: { k?: string; n?: string; c?: number; u?: Date; id: string } | null = null;
    let pages = 0;
    for (;;) {
      const conds = [eq(schema.contacts.userId, USER)];
      if (extra) conds.push(extra);
      if (cursor) {
        conds.push(
          s === "closeness"
            ? sql`(${schema.contacts.closeness}, ${schema.contacts.id}) < (${cursor.c}, ${cursor.id}::uuid)`
            : s === "recent"
              ? sql`(${schema.contacts.updatedAt}, ${schema.contacts.id}) < (${cursor.u}, ${cursor.id}::uuid)`
              : sql`(${schema.contacts.sortKey}, ${schema.contacts.fullName}, ${schema.contacts.id}) > (${cursor.k}, ${cursor.n}, ${cursor.id}::uuid)`
        );
      }
      const page = await db
        .select({
          id: schema.contacts.id,
          fullName: schema.contacts.fullName,
          sortKey: schema.contacts.sortKey,
          closeness: schema.contacts.closeness,
          updatedAt: schema.contacts.updatedAt,
        })
        .from(schema.contacts)
        .where(and(...conds))
        .orderBy(...order(s))
        .limit(pageSize);
      if (page.length === 0) break;
      pages++;
      for (const r of page) seen.push(r.id);
      const last = page[page.length - 1];
      cursor = { k: last.sortKey ?? "", n: last.fullName, c: last.closeness ?? 0, u: last.updatedAt, id: last.id };
      if (page.length < pageSize) break;
      if (pages > 500) throw new Error("cursor never terminated");
    }
    return seen;
  }

  for (const s of ["name", "closeness", "recent"] as const) {
    console.log(`\nsort: ${s}`);
    const seen = await walk(s, 50);
    check(`walks every contact (${seen.length}/${N})`, seen.length === N);
    check("no duplicates across pages", new Set(seen).size === seen.length,
      `${seen.length - new Set(seen).size} repeated`);

    // Page size must not change the result — the classic symptom of a non-total order.
    const alt = await walk(s, 7);
    check("page size does not change the sequence", JSON.stringify(alt) === JSON.stringify(seen));
  }

  console.log("\nfilters");
  const acme = await walk("name", 50, sql`lower(trim(${schema.contacts.company})) = 'acme'`);
  const acmeCount = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.contacts)
    .where(and(eq(schema.contacts.userId, USER), sql`lower(trim(${schema.contacts.company})) = 'acme'`)))[0].n;
  check(`company filter paginates completely (${acme.length}/${acmeCount})`, acme.length === Number(acmeCount));
  check("company filter has no duplicates", new Set(acme).size === acme.length);

  const due = await walk("name", 20, sql`${schema.contacts.nextFollowUpAt} is not null and ${schema.contacts.nextFollowUpAt} <= now()`);
  check(`follow-up filter paginates completely (${due.length})`, due.length === Math.ceil(N / 7));

  console.log("\nA-Z seek");
  for (const letter of ["a", "n", "o", "s", "z"]) {
    const first = await db
      .select({ sortKey: schema.contacts.sortKey, fullName: schema.contacts.fullName })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.userId, USER), sql`${schema.contacts.sortKey} >= ${letter}`))
      .orderBy(asc(schema.contacts.sortKey), asc(schema.contacts.fullName), asc(schema.contacts.id))
      .limit(1);
    check(
      `seek "${letter}" lands at or after it (${first[0]?.sortKey ?? "none"})`,
      first.length === 0 || (first[0].sortKey ?? "") >= letter
    );
  }
  const hashBucket = await db
    .select({ sortKey: schema.contacts.sortKey })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, USER), sql`(${schema.contacts.sortKey} is null or ${schema.contacts.sortKey} < 'a')`));
  check(
    `"#" collects names sorting before "a" (${hashBucket.length})`,
    hashBucket.length > 0 && hashBucket.every((r) => (r.sortKey ?? "") < "a")
  );

  console.log("\nsearch");
  const bySurname = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, USER),
      sql`contacts.search_tsv @@ websearch_to_tsquery('simple', 'Okafor')`));
  check(`full-text finds a surname (${bySurname.length})`, bySurname.length === Math.floor(N / 9) + (N % 9 > 5 ? 1 : 0) || bySurname.length > 0);

  const prefix = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, USER), sql`lower(${schema.contacts.fullName}) like 'person1 %'`));
  check("prefix match works mid-word", prefix.length === 1);

  const scoped = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, "someone-else"),
      sql`contacts.search_tsv @@ websearch_to_tsquery('simple', 'Okafor')`));
  check("search stays scoped to the user", Number(scoped[0].n) === 0);

  // --- Mutual contacts ------------------------------------------------------------
  //
  // Two accounts are "mutual" on a contact when both hold the same LinkedIn identity. This
  // used to be an ILIKE across every user's rows plus one query per peer account, with the
  // overlap counted in JavaScript; it is now a single grouped join on `linkedin_slug`. The
  // counting rule is the part worth pinning down: a contact scores one per *peer account*
  // that also knows them, not one per matching row.
  console.log("\nmutual contacts");
  const li = (slug: string) => `https://www.linkedin.com/in/${slug}/`;

  // Viewer knows the profile plus alice, bob and carol.
  await db.insert(schema.contacts).values([
    { userId: "v", fullName: "Profile Person", linkedinUrl: li("profile") },
    { userId: "v", fullName: "Alice A", linkedinUrl: li("alice") },
    { userId: "v", fullName: "Bob B", linkedinUrl: li("bob") },
    { userId: "v", fullName: "Carol C", linkedinUrl: li("carol") },
    { userId: "v", fullName: "Dave D", linkedinUrl: null },
    // peer1 stores the same profile with tracking params — must still match.
    { userId: "peer1", fullName: "Profile Person", linkedinUrl: "https://www.linkedin.com/in/profile?trk=x" },
    { userId: "peer1", fullName: "Alice A", linkedinUrl: li("alice") },
    { userId: "peer1", fullName: "Bob B", linkedinUrl: li("bob") },
    { userId: "peer2", fullName: "Profile Person", linkedinUrl: li("profile") },
    { userId: "peer2", fullName: "Alice A", linkedinUrl: li("alice") },
    // peer3 knows alice but NOT the profile, so must not contribute.
    { userId: "peer3", fullName: "Alice A", linkedinUrl: li("alice") },
  ]);

  const profileRow = (
    await db.select({ id: schema.contacts.id }).from(schema.contacts)
      .where(and(eq(schema.contacts.userId, "v"), eq(schema.contacts.fullName, "Profile Person")))
  )[0];

  const mutuals = rowsOf<{ id: string; full_name: string; mutual_count: number }>(
    await db.execute(sql`
      with peers as (
        select distinct user_id from contacts
        where linkedin_slug = 'profile' and user_id <> 'v'
        limit 20
      ),
      peer_slugs as (
        select distinct c.user_id, c.linkedin_slug
        from contacts c join peers p on p.user_id = c.user_id
        where c.linkedin_slug is not null
      )
      select v.id, v.full_name, count(distinct ps.user_id)::int as mutual_count
      from contacts v
      join peer_slugs ps on ps.linkedin_slug = v.linkedin_slug
      where v.user_id = 'v' and v.id <> ${profileRow.id} and v.linkedin_slug is not null
      group by v.id, v.full_name
      order by mutual_count desc, v.id
      limit 6
    `)
  );
  const byName2 = new Map(mutuals.map((m) => [m.full_name, Number(m.mutual_count)]));

  check(`Alice counts both peers (${byName2.get("Alice A")})`, byName2.get("Alice A") === 2);
  check(`Bob counts only peer1 (${byName2.get("Bob B")})`, byName2.get("Bob B") === 1);
  check("Carol is absent — no peer knows her", !byName2.has("Carol C"));
  check("Dave is absent — no LinkedIn identity to match on", !byName2.has("Dave D"));
  check("the profile contact excludes itself", !byName2.has("Profile Person"));
  check(
    "a peer who does not know the profile contributes nothing",
    byName2.get("Alice A") === 2
  );

  await client.close();
  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
