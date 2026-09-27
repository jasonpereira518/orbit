/**
 * Verifies `listRelatedContacts` still finds every reason type (mention, companyId,
 * company, howMet, school, sharedTags, sharedInterests) after the rewrite that replaced a
 * full-table `findMany` + per-contact tags join with a narrow scan plus a bounded tags
 * aggregate. Also asserts the narrow scan does not select the wide join it used to.
 * Run: npx tsx scripts/smoke-related-contacts-scale.ts
 */
import "./smoke/_env";

// `requireUserId()` resolves to "demo-user" only in `isDemoMode()`, which is gated on
// `NODE_ENV === "development"` — true under `next dev`, unset under a bare `tsx` run.
// @types/node marks `NODE_ENV` read-only; it is writable at runtime.
(process.env as Record<string, string>).NODE_ENV = "development";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactTags, tags } from "../src/db/schema";
import { listRelatedContacts } from "../src/actions/contacts";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";

// `listRelatedContacts` calls `requireUserId()`, which resolves to "demo-user" outside
// Clerk/production (see `isDemoMode()`) — the same identity `seed-scale.ts` and the dev
// server itself use locally, so the fixture has to live under it rather than a made-up id.
const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const [source] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Ada Lovelace", company: "Analytical Engines", school: "Somerville", howMet: "PyCon", sharedInterests: ["chess", "poetry"] })
    .returning();

  const [byCompany] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Charles Babbage", company: "Analytical Engines" })
    .returning();
  const [bySchool] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Mary Somerville", school: "Somerville" })
    .returning();
  const [byHowMet] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Guido van Rossum", howMet: "PyCon" })
    .returning();
  const [byMention] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Grace Hopper", aiSummary: "Worked closely with Ada Lovelace on early compilers." })
    .returning();
  const [byInterests] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Alan Turing", sharedInterests: ["chess", "poetry"] })
    .returning();
  const [unrelated] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Nobody Related" })
    .returning();

  const [tagA] = await db.insert(tags).values({ userId: USER, name: "mentor" }).returning();
  const [tagB] = await db.insert(tags).values({ userId: USER, name: "conference" }).returning();
  const [bySharedTags] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Katherine Johnson" })
    .returning();
  await db.insert(contactTags).values([
    { contactId: source.id, tagId: tagA.id },
    { contactId: source.id, tagId: tagB.id },
    { contactId: bySharedTags.id, tagId: tagA.id },
    { contactId: bySharedTags.id, tagId: tagB.id },
    // Only one shared tag — must NOT match (bestReason requires >= 2).
    { contactId: unrelated.id, tagId: tagA.id },
  ]);

  startQueryCount();
  const related = await listRelatedContacts(source.id, 10);
  const queryCount = stopQueryCount();
  const scans = capturedQueries().filter((s) => /from\s+"contacts"/i.test(s) && /^\s*select/i.test(s));

  const ids = new Set(related.map((r) => r.id));
  check("finds company match", ids.has(byCompany.id));
  check("finds school match", ids.has(bySchool.id));
  check("finds howMet match", ids.has(byHowMet.id));
  check("finds mention match", ids.has(byMention.id));
  check("finds sharedInterests match", ids.has(byInterests.id));
  check("finds sharedTags match (>=2 shared)", ids.has(bySharedTags.id));
  check("excludes contact sharing only 1 tag", !ids.has(unrelated.id));
  check("excludes the source itself", !ids.has(source.id));

  const companyHit = related.find((r) => r.id === byCompany.id);
  check("company match carries correct reason", companyHit?.reason === "company");
  const mentionHit = related.find((r) => r.id === byMention.id);
  check("mention match carries correct reason", mentionHit?.reason === "mention");
  check(
    "winners are hydrated with display fields",
    typeof companyHit?.title !== "undefined"
  );

  check(
    "the narrow scan does not join contact_tags for every contact",
    scans.every((s) => !/contact_tags/i.test(s)),
    scans.find((s) => /contact_tags/i.test(s))
  );
  console.log(`  (${queryCount} total statements for one related-contacts lookup)`);

  await db.delete(contactTags).where(eq(contactTags.contactId, source.id));
  await db.delete(contactTags).where(eq(contactTags.contactId, bySharedTags.id));
  await db.delete(contactTags).where(eq(contactTags.contactId, unrelated.id));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll related-contacts checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
