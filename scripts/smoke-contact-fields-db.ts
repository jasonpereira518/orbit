/**
 * The field-source rule at the writers (contact-info accuracy plan, PR 1):
 *
 *  - An address-book sync or file import never replaces a company the person typed, and no
 *    longer replaces an older unknown value either; it still fills blanks.
 *  - A LinkedIn export replaces an unknown (pre-ledger) value, logged with the old value.
 *  - A job move against a typed company becomes one suggestion, not a write.
 *  - The person's own edit is stamped "user" only on the fields that changed.
 *  - Merges now fill location, school, website, industry and X handle.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-contact-fields-db.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactChanges, contacts } from "../src/db/schema";
import { bulkMergeContactsForUser, createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { createCompanyResolver } from "../src/lib/companies";
import { checker } from "./smoke/check";

const USER = "contact-fields-db-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_changes WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function row(id: string) {
  const db = await getDb();
  const [r] = await db.select().from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.id, id))).limit(1);
  return r!;
}

async function changes(id: string) {
  const db = await getDb();
  return db.select().from(contactChanges).where(eq(contactChanges.contactId, id));
}

async function main() {
  await reset();
  const resolver = await createCompanyResolver(USER);

  console.log("what the person typed holds");
  {
    const c = await createContactForUser(USER, { fullName: "Ada Byron", company: "Analytical Engines", title: "CTO" }, { ...OPTS, by: "user" });
    const created = await row(c.id);
    t.check("created from the form: stamped user", created.fieldSources?.company?.s === "user" && created.fieldSources?.title?.s === "user", JSON.stringify(created.fieldSources));
    await bulkMergeContactsForUser(USER, [{ contactId: c.id, input: { company: "Globex", title: "VP", location: "London" } }], resolver, { source: "address_book" });
    const r = await row(c.id);
    t.check("an address book does not replace the typed company", r.company === "Analytical Engines" && r.title === "CTO", `${r.company} / ${r.title}`);
    t.check("but fills the blank location", r.location === "London" && r.fieldSources?.location?.s === "address_book", `${r.location} ${JSON.stringify(r.fieldSources)}`);

    await updateContactForUser(USER, c.id, { company: "Stripe", title: "VP Eng" }, { ...OPTS, by: "job_move", at: new Date() });
    const m = await row(c.id);
    t.check("a job move does not replace it either", m.company === "Analytical Engines", String(m.company));
    const offered = (await changes(c.id)).filter((x) => x.status === "suggested");
    t.check("it is offered instead, once per field", offered.length === 2 && offered.some((x) => x.field === "company" && x.after === "Stripe"), JSON.stringify(offered.map((x) => [x.field, x.after])));
    await updateContactForUser(USER, c.id, { company: "Stripe Inc" }, { ...OPTS, by: "job_move", at: new Date() });
    const again = (await changes(c.id)).filter((x) => x.status === "suggested" && x.field === "company");
    t.check("a newer offer replaces the open one", again.length === 1 && again[0].after === "Stripe Inc", JSON.stringify(again.map((x) => x.after)));
  }

  console.log("unknown values: only a dated record replaces them");
  await reset();
  {
    const c = await createContactForUser(USER, { fullName: "Ben Ode", company: "Initech", title: "Engineer" }, OPTS);
    t.check("no source given: no stamp", (await row(c.id)).fieldSources == null);
    await bulkMergeContactsForUser(USER, [{ contactId: c.id, input: { company: "Globex" } }], resolver);
    t.check("a file import leaves it", (await row(c.id)).company === "Initech");
    await bulkMergeContactsForUser(USER, [{ contactId: c.id, input: { company: "Hooli", title: "Staff Engineer" } }], resolver, { source: "linkedin_export" });
    const r = await row(c.id);
    t.check("the LinkedIn export replaces it", r.company === "Hooli" && r.title === "Staff Engineer", `${r.company} / ${r.title}`);
    const log = (await changes(c.id)).filter((x) => x.status === "applied");
    t.check("logged with the old value", log.some((x) => x.field === "company" && x.before === "Initech" && x.after === "Hooli"), JSON.stringify(log.map((x) => [x.field, x.before, x.after])));
  }

  console.log("the person's edit stamps only what changed");
  await reset();
  {
    const c = await createContactForUser(USER, { fullName: "Cy Dee", company: "Acme", title: "PM" }, { ...OPTS, by: "address_book" });
    await updateContactForUser(USER, c.id, { company: "Acme", title: "Director" }, { ...OPTS, by: "user" });
    const r = await row(c.id);
    t.check("unchanged company keeps its source", r.fieldSources?.company?.s === "address_book", JSON.stringify(r.fieldSources));
    t.check("changed title is the person's", r.title === "Director" && r.fieldSources?.title?.s === "user");
  }

  console.log("merges fill the fields they used to drop");
  await reset();
  {
    const c = await createContactForUser(USER, { fullName: "Dee Eff" }, OPTS);
    await bulkMergeContactsForUser(
      USER,
      [{ contactId: c.id, input: { school: "MIT", website: "https://dee.example", industry: "Fintech", xHandle: "deeeff" } }],
      resolver,
      { source: "address_book" }
    );
    const r = await row(c.id);
    t.check("school, website, industry, X handle filled", r.school === "MIT" && r.website === "https://dee.example" && r.industry === "Fintech" && r.xHandle === "deeeff", JSON.stringify([r.school, r.website, r.industry, r.xHandle]));
  }

  await reset();
  t.done("contact fields db smoke tests");
}

run(main);
