/**
 * `listRelatedContacts` against the scoring it replaced: `findRelatedContacts` over every
 * contact in the account with its full text and real tags. The SQL reads only the rows
 * that could earn a reason (superset prefilters, see `relatedCandidateFilter`), so this
 * pins that nothing is lost on the data most likely to slip past a prefilter: mixed case,
 * non-ASCII names, the KELVIN SIGN and dotted capital I, odd whitespace, LIKE
 * metacharacters, Greek final sigma, and jsonb that is not an array of strings.
 *
 * Every contact is a source, with and without an active goal (a goal boost reads the text
 * of every row with a reason).
 *
 * Run: npx tsx scripts/smoke-related-contacts-parity.ts
 */
import "./smoke/_env";

// `requireUserId()` resolves to "demo-user" only in `isDemoMode()`; see
// smoke-related-contacts-scale.ts.
(process.env as Record<string, string>).NODE_ENV = "development";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactTags, tags, userGoals } from "../src/db/schema";
import { listRelatedContacts } from "../src/actions/contacts";
import { findRelatedContacts } from "../src/lib/related-contacts";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NBSP = " ";
const FIXTURE: Array<Partial<typeof contacts.$inferInsert> & { fullName: string; tagNames?: string[] }> = [
  { fullName: "Sarah Chen", company: "Zeta", notes: `Introduced by SARAH CHEN at the offsite; met Ünal Kaya and Dmitri${NBSP}Volkov`, tagNames: ["mentor", "ai"] },
  { fullName: "Kelvin Ito", company: "Omega", aiSummary: "Knows Kelvin from school; also met sarah", tagNames: ["mentor", "ai", "sf"] },
  { fullName: "İlker Yilmaz", company: "Delta", notes: "worked with i̇lker on the launch" },
  { fullName: "Ünal Kaya", company: "  ACME   Corp ", howMet: "YC  Demo Day", school: "MIT", tagNames: ["sf"] },
  { fullName: `Dmitri${NBSP}Volkov`, company: "acme corp", howMet: "yc demo day", school: " mit " },
  { fullName: "Ana_Bell%", company: "Acme\tCorp", howMet: "YC Demo Day", notes: "talks to sarah chen weekly; ana_bell% too" },
  { fullName: "Σοφία Παπαδοπούλου", company: "ΑΚΜΕ", school: "Εθνικό Μετσόβιο", sharedInterests: ["Hiking", "ΣΚΙ", "chess"] },
  { fullName: "Νίκος Σ", company: "ακμε", school: "εθνικό μετσόβιο", sharedInterests: ["σκι", "hiking"], notes: "skiing with σοφία" },
  { fullName: "Interest One", sharedInterests: ["Hiking", "Chess", "Go", 'Say "hi"'] },
  { fullName: "Interest Two", sharedInterests: ["chess", "go", 'say "hi"'] },
  { fullName: "Odd Facts", company: "Theta", keyFacts: [1, { a: "sarah chen" }] as unknown as string[] },
  { fullName: "Kitchen Person", company: "Kappa", notes: "kitchen remodel; chenoweth; Interest Two; a.b" },
  { fullName: "Grace Hopper 3", company: "Lambda", notes: "Talked about Ada Lovelace 0 and Grace", companyId: null },
  { fullName: "a.b", preferredName: "Zed", company: "Kappa" },
  { fullName: "Trailing Space\u0085", notes: "kitchen person and ünal" },
  { fullName: "Kelvin Sign", notes: "kelvin sign came by" },
  { fullName: "Plain Nobody" },
  { fullName: "   ", notes: "whitespace name" },
];

async function main() {
  const db = await getDb();
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const tagIds = new Map<string, string>();
  for (const { tagNames = [], ...values } of FIXTURE) {
    const [row] = await db.insert(contacts).values({ ...values, userId: USER }).returning();
    for (const name of tagNames) {
      if (!tagIds.has(name)) {
        const [tag] = await db.insert(tags).values({ userId: USER, name }).returning();
        tagIds.set(name, tag.id);
      }
      await db.insert(contactTags).values({ contactId: row.id, tagId: tagIds.get(name)! });
    }
  }

  const everyone = await db.query.contacts.findMany({ where: eq(contacts.userId, USER), with: { contactTags: { with: { tag: true } } } });
  const full = everyone.map((c) => ({ ...c, tags: c.contactTags.map((ct) => ct.tag.name) }));
  const show = (rows: Array<{ fullName: string; reason: string }>) => rows.map((r) => `${r.fullName}|${r.reason}`).join(", ");

  for (const goals of [[] as string[], ["hiring for chess engine and ski apps"]]) {
    if (goals.length) await db.insert(userGoals).values({ userId: USER, text: goals[0] });
    console.log(goals.length ? "\nWith an active goal" : "Without goals");
    let compared = 0;
    let related = 0;
    for (const source of full) {
      const expected = findRelatedContacts(source.id, full, 50, goals);
      const actual = await listRelatedContacts(source.id, 50);
      compared += 1;
      related += expected.length;
      const same = show(expected) === show(actual);
      if (!same) check(`${JSON.stringify(source.fullName)} matches full-text scoring`, false, `expected ${show(expected)}\n       actual   ${show(actual)}`);
    }
    check(`all ${compared} sources match full-text scoring (${related} related rows)`, failures === 0);
  }

  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll related-contacts parity checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
