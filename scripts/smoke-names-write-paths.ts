/**
 * The names rules at the write paths (names PR2):
 *
 *  - A source's name is stored formatted ("DOE, JANE" → Jane Doe, with first/last).
 *  - An automated record that matches an existing contact only FILLS blanks: it never
 *    replaces a company, a where-met or notes, and changes the name only to a better one
 *    for the same person (a handle becomes a name; a name never becomes a handle).
 *  - A name the person typed is final: stamped `source: "user"`, never renamed by automation.
 *  - A re-import never overwrites where-met (`bulkMergeContactsForUser`).
 *  - A merge keeps the better name even when the worse-named row is the survivor, and undo
 *    puts the old name back.
 *  - A row stored raw ("DOE, JANE") and the same person arriving formatted still match.
 *  - Imports refuse companies, machine mailboxes and nameless shared inboxes.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-names-write-paths.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import { contactMerges, contacts } from "../src/db/schema";
import { resolveOrCreateContact } from "../src/lib/contact-resolve";
import { bulkMergeContactsForUser, createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { createCompanyResolver } from "../src/lib/companies";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { isAdmissibleRecord } from "../src/lib/names/classify";
import { NO_ENGINES } from "../src/lib/decisions/engine";
import { checker } from "./smoke/check";

const USER = "names-write-paths-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_merges WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM duplicate_suggestions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function row(id: string) {
  const db = await getDb();
  const [r] = await db.select().from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.id, id))).limit(1);
  return r!;
}

async function main() {
  await reset();

  console.log("formatting at write");
  {
    const c = await createContactForUser(USER, { fullName: "DOE, JANE", email: "jane.doe@acme.example" }, OPTS);
    const r = await row(c.id);
    t.check("stored formatted", r.fullName === "Jane Doe" && r.firstName === "Jane" && r.lastName === "Doe", `${r.fullName} / ${r.firstName} / ${r.lastName}`);
    const h = await createContactForUser(USER, { fullName: "jsmith42", email: "jsmith42@x.example" }, OPTS);
    t.check("a handle is stored as given, for the sweep", (await row(h.id)).fullName === "jsmith42");
    const typed = await createContactForUser(USER, { fullName: "dj KHALIL" }, { ...OPTS, nameBy: "user" });
    const tr = await row(typed.id);
    t.check("a typed name is stored as typed", tr.fullName === "dj KHALIL");
    t.check("and stamped as the user's", tr.nameGuess?.source === "user" && tr.nameGuess.weak === false, JSON.stringify(tr.nameGuess));
  }

  console.log("automated matches fill blanks only");
  await reset();
  {
    const c = await createContactForUser(
      USER,
      { fullName: "Priya Raman", email: "priya@harbor.example", company: "Harbor Health", howMet: "Met at AWS Summit", notes: "her words" },
      OPTS
    );
    const out = await resolveOrCreateContact(
      USER,
      { fullName: "priya", email: "priya@harbor.example", company: "Other Co", howMet: "LinkedIn connection", title: "CTO", notes: "imported", source: "linkedin" },
      { ...OPTS, engines: NO_ENGINES }
    );
    const r = await row(c.id);
    t.check("matched by email", out.outcome === "matched" && out.contactId === c.id);
    t.check("name not shrunk", r.fullName === "Priya Raman", r.fullName);
    t.check("company kept", r.company === "Harbor Health", String(r.company));
    t.check("where-met kept", r.howMet === "Met at AWS Summit", String(r.howMet));
    t.check("notes kept", r.notes === "her words", String(r.notes));
    t.check("a blank is filled", r.title === "CTO", String(r.title));

    const h = await createContactForUser(USER, { fullName: "jsmith42", email: "jsmith42@x.example" }, OPTS);
    await resolveOrCreateContact(USER, { fullName: "John Smith", email: "jsmith42@x.example" }, { ...OPTS, engines: NO_ENGINES });
    const hr = await row(h.id);
    t.check("a handle becomes the real name", hr.fullName === "John Smith" && hr.firstName === "John", hr.fullName);
  }

  console.log("user names are final");
  await reset();
  {
    const c = await createContactForUser(USER, { fullName: "Bobby T", email: "bobby@x.example" }, { ...OPTS, nameBy: "user" });
    await resolveOrCreateContact(USER, { fullName: "Robert Tables", email: "bobby@x.example" }, { ...OPTS, engines: NO_ENGINES });
    t.check("automation never renames a typed name", (await row(c.id)).fullName === "Bobby T");
    const d = await createContactForUser(USER, { fullName: "jdoe7", email: "jdoe7@x.example" }, OPTS);
    await updateContactForUser(USER, d.id, { fullName: "jdoe7" }, { ...OPTS, nameBy: "user" });
    await resolveOrCreateContact(USER, { fullName: "John Doe", email: "jdoe7@x.example" }, { ...OPTS, engines: NO_ENGINES });
    const dr = await row(d.id);
    t.check("not even a handle the person kept", dr.fullName === "jdoe7" && dr.nameGuess?.source === "user", `${dr.fullName} ${JSON.stringify(dr.nameGuess)}`);
  }

  console.log("re-imports never overwrite where-met");
  await reset();
  {
    const c = await createContactForUser(USER, { fullName: "Ana Ruiz", howMet: "Met at AWS Summit", metContext: "event" }, OPTS);
    const blank = await createContactForUser(USER, { fullName: "Ben Ode" }, OPTS);
    await bulkMergeContactsForUser(
      USER,
      [
        { contactId: c.id, input: { howMet: "LinkedIn connection", metContext: "online", source: "linkedin" } },
        { contactId: blank.id, input: { howMet: "LinkedIn connection", metContext: "online" } },
      ],
      await createCompanyResolver(USER)
    );
    const r = await row(c.id);
    t.check("how-met kept", r.howMet === "Met at AWS Summit", String(r.howMet));
    t.check("met context kept", r.metContext === "event", String(r.metContext));
    t.check("a blank where-met is filled", (await row(blank.id)).howMet === "LinkedIn connection");
  }

  console.log("merges keep the better name; undo restores it");
  await reset();
  {
    const older = await createContactForUser(USER, { fullName: "jsmith42" }, OPTS);
    const newer = await createContactForUser(USER, { fullName: "John Smith" }, OPTS);
    await mergeContacts(USER, older.id, newer.id, { reason: "smoke" });
    t.check("the survivor takes the real name", (await row(older.id)).fullName === "John Smith");
    const db = await getDb();
    const [m] = await db.select({ id: contactMerges.id }).from(contactMerges).where(eq(contactMerges.userId, USER)).limit(1);
    await unmergeContacts(USER, m!.id);
    t.check("undo puts the survivor's own name back", (await row(older.id)).fullName === "jsmith42");
    t.check("and restores the other contact", (await row(newer.id))?.fullName === "John Smith");

    const kept = await createContactForUser(USER, { fullName: "Michael Torres" }, OPTS);
    const nick = await createContactForUser(USER, { fullName: "Mike Torres" }, OPTS);
    await mergeContacts(USER, kept.id, nick.id, { reason: "smoke" });
    t.check("a full name is not swapped for a nickname", (await row(kept.id)).fullName === "Michael Torres");
  }

  console.log("raw and formatted spellings still match");
  await reset();
  {
    const db = await getDb();
    const [raw] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "DOE, JANE", company: "Acme" })
      .returning();
    const out = await resolveOrCreateContact(USER, { fullName: "Jane Doe", company: "Acme" }, { ...OPTS, engines: NO_ENGINES });
    t.check("name + company folds into the raw row", out.outcome === "matched" && out.contactId === raw!.id, JSON.stringify(out));
  }

  console.log("imports refuse non-people");
  t.check("a company by legal form", !isAdmissibleRecord("Acme Holdings LLC", "billing@acme.example"));
  t.check("a machine mailbox", !isAdmissibleRecord("Jane Doe", "noreply@acme.example"));
  t.check("a shared inbox with no person's name", !isAdmissibleRecord("Acme", "info@acme.example"));
  t.check("a shared inbox a person signs", isAdmissibleRecord("Jane Doe", "hello@janedoe.example"));
  t.check("a person with no name yet is kept", isAdmissibleRecord("", "jane@acme.example") && isAdmissibleRecord("jsmith42", "jsmith42@x.example"));

  await reset();
  await closeDb();
  t.done("names write-path smoke tests");
}

run(main);
