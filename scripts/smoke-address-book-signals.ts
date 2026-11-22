/**
 * Free signals from address books (contact-info accuracy plan, PR 6):
 *
 *  - Google and Outlook records carry city/region, a LinkedIn link, and every email/phone.
 *  - A record matches an existing contact by a SECOND email, and its other addresses are
 *    kept as identifiers.
 *  - A work email's domain names an employer for a contact with none; public mail, schools
 *    and government don't.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-address-book-signals.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactIdentities, contacts } from "../src/db/schema";
import { toPersonRecord as googleRecord } from "../src/lib/connectors/google-contacts";
import { toPersonRecord as outlookRecord } from "../src/lib/connectors/microsoft-contacts";
import { createContactForUser } from "../src/lib/contact-writes";
import { openIngestContext } from "../src/lib/ingest/events";
import { ingestPeople } from "../src/lib/ingest/people";
import { employerFromEmail, fillCompanyFromEmail } from "../src/lib/email-domain-company";
import { checker } from "./smoke/check";

const USER = "address-book-signals-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

async function reset() {
  const db = await getDb();
  for (const table of ["contact_changes", "contact_identities", "contacts", "companies"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE user_id = ${USER}`);
  }
}

async function main() {
  await reset();

  console.log("mappers");
  {
    const g = googleRecord({
      names: [{ displayName: "Priya Raman" }],
      emailAddresses: [{ value: "priya@home.example" }, { value: "priya@ramp.example", metadata: { primary: true } }],
      phoneNumbers: [{ value: "+1 555 010 0001", metadata: { primary: true } }, { value: "+1 555 010 0002" }],
      addresses: [{ city: "Austin", region: "TX", country: "US" }],
      urls: [{ value: "https://priya.example" }, { value: "https://www.linkedin.com/in/priya-raman" }],
    });
    t.check("Google: primary email, others kept apart", g?.email === "priya@ramp.example" && g.otherEmails?.join() === "priya@home.example", JSON.stringify(g));
    t.check("Google: second phone kept", g?.otherPhones?.join() === "+1 555 010 0002");
    t.check("Google: city and region, no street", g?.location === "Austin, TX");
    t.check("Google: the LinkedIn link, not any website", g?.linkedinUrl === "https://www.linkedin.com/in/priya-raman");
    const o = outlookRecord({
      displayName: "Ben Ode",
      emailAddresses: [{ address: "ben@hooli.example" }, { address: "ben@home.example" }],
      businessPhones: [],
      mobilePhone: "+1 555 010 0003",
      homeAddress: { city: "Seattle", state: "WA" },
    });
    t.check("Outlook: emails, phone and city", o?.email === "ben@hooli.example" && o.otherEmails?.join() === "ben@home.example" && o.phone === "+1 555 010 0003" && o.location === "Seattle, WA", JSON.stringify(o));
  }

  console.log("matching on a second email");
  {
    const known = await createContactForUser(USER, { fullName: "Priya Raman", email: "priya@home.example" }, { ...OPTS, by: "user" });
    const ctx = await openIngestContext(USER, { source: "google_contacts", createsContacts: true });
    const stats = await ingestPeople(ctx, [
      { fullName: "Priya R.", email: "priya@ramp.example", otherEmails: ["priya@home.example"], otherPhones: ["+1 555 010 0002"], location: "Austin, TX" },
    ]);
    t.check("matched, not created", stats.matched === 1 && stats.created === 0, JSON.stringify(stats));
    const db = await getDb();
    const ids = (await db.select().from(contactIdentities).where(and(eq(contactIdentities.userId, USER), eq(contactIdentities.contactId, known.id))))
      .map((r) => `${r.kind}:${r.value}`)
      .sort();
    t.check("the work address and the second phone are now hers", ids.includes("email:priya@ramp.example") && ids.includes("phone_e164:+15550100002"), ids.join(", "));
    const [row] = await db.select().from(contacts).where(eq(contacts.id, known.id));
    t.check("the email she typed stays primary", row.email === "priya@home.example");
    t.check("her city fills", row.location === "Austin, TX");
  }

  console.log("employer from a work email");
  t.check("a company domain", employerFromEmail("priya@harbor-health.com") === "Harbor Health");
  t.check("not public mail", employerFromEmail("priya@gmail.com") === null);
  t.check("not a university", employerFromEmail("p@cs.unc.edu") === null && employerFromEmail("p@ox.ac.uk") === null);
  t.check("not government", employerFromEmail("p@nasa.gov") === null);
  {
    const bare = await createContactForUser(USER, { fullName: "Cy Dee", email: "cy@harbor-health.com" }, OPTS);
    const typed = await createContactForUser(USER, { fullName: "Di Ell", email: "di@harbor-health.com", company: "Acme" }, { ...OPTS, by: "user" });
    t.check("fills only the empty one", (await fillCompanyFromEmail(USER, [bare.id, typed.id])) === 1);
    const db = await getDb();
    const [b] = await db.select().from(contacts).where(eq(contacts.id, bare.id));
    t.check("as an inferred source", b.company === "Harbor Health" && b.fieldSources?.company?.s === "email_domain", JSON.stringify([b.company, b.fieldSources]));
  }

  await reset();
  t.done("address book signals smoke tests");
}

run(main);
