/**
 * Matching on everything a contact is known by (contact-info accuracy plan, PR 2):
 *
 *  - A merge keeps an email or phone it may not write to the column as an identifier.
 *  - Imports and syncs find a person by that second email or phone (`indexStoredIdentities`).
 *  - Phone is a matching tier, compared in E.164.
 *  - Editing the primary email releases only the old primary, not the second address.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-contact-matching.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactIdentities } from "../src/db/schema";
import { bulkMergeContactsForUser, createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { indexStoredIdentities } from "../src/lib/contact-identity";
import { buildDuplicateIndex, findDuplicateCandidatesIndexed } from "../src/lib/duplicates";
import { createCompanyResolver } from "../src/lib/companies";
import { checker } from "./smoke/check";

const USER = "contact-matching-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_changes WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contact_identities WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function identities(contactId: string) {
  const db = await getDb();
  const rows = await db
    .select({ kind: contactIdentities.kind, value: contactIdentities.value })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.userId, USER), eq(contactIdentities.contactId, contactId)));
  return rows.map((r) => `${r.kind}:${r.value}`).sort();
}

async function indexFor() {
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: (c, { eq }) => eq(c.userId, USER),
    columns: { id: true, fullName: true, email: true, linkedinUrl: true, xHandle: true, company: true, title: true, phone: true },
  });
  const index = buildDuplicateIndex(existing);
  await indexStoredIdentities(USER, index, existing);
  return index;
}

async function main() {
  await reset();

  console.log("a merge keeps the email it does not write");
  const ada = await createContactForUser(USER, { fullName: "Ada Byron", email: "ada@work.example" }, { ...OPTS, by: "user" });
  await bulkMergeContactsForUser(
    USER,
    [{ contactId: ada.id, input: { email: "ada@home.example", phone: "(555) 010-0199" } }],
    await createCompanyResolver(USER),
    { source: "address_book" }
  );
  const ids = await identities(ada.id);
  t.check("both emails and the phone are hers", ids.includes("email:ada@home.example") && ids.includes("email:ada@work.example") && ids.includes("phone_e164:+15550100199"), ids.join(", "));

  console.log("imports find her by any of them");
  {
    const index = await indexFor();
    const byHome = findDuplicateCandidatesIndexed(index, { fullName: "A. Byron", email: "ada@home.example" })[0];
    t.check("by the second email", byHome?.contact.id === ada.id && byHome.confidence >= 0.85, JSON.stringify(byHome?.reason));
    const byPhone = findDuplicateCandidatesIndexed(index, { fullName: "Ada", phone: "+1 555 010 0199" })[0];
    t.check("by phone, however it is written", byPhone?.contact.id === ada.id && byPhone.reason === "Same phone", JSON.stringify(byPhone?.reason));
    const stranger = findDuplicateCandidatesIndexed(index, { fullName: "Bob Ode", phone: "+1 555 010 0100" });
    t.check("a different phone matches nobody", stranger.length === 0);
  }

  console.log("an edit releases only what it replaced");
  await updateContactForUser(USER, ada.id, { email: "ada@new.example" }, { ...OPTS, by: "user" });
  const after = await identities(ada.id);
  t.check("the old primary is released", !after.includes("email:ada@work.example"), after.join(", "));
  t.check("the second email and the phone stay", after.includes("email:ada@home.example") && after.includes("phone_e164:+15550100199") && after.includes("email:ada@new.example"), after.join(", "));

  await reset();
  t.done("contact matching smoke tests");
}

run(main);
