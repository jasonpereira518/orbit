/**
 * Resolving the people named in an email to contacts: by email, at read time, merge-safe.
 * PGlite, no network. Run: npx tsx scripts/smoke-email-intel-resolve.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import {
  normalizedEmail,
  resolveEmails,
  resolvePeople,
} from "../src/lib/email-intel/resolve";

const U = "smoke-eir-u";
const V = "smoke-eir-v";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function addContact(userId: string, fullName: string, email: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, email }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));

  console.log("\nNormalising");
  check("case and padding are folded", normalizedEmail("  Dana@Northwind.Example ") === "dana@northwind.example");
  check("a missing address is null", normalizedEmail(null) === null && normalizedEmail(undefined) === null && normalizedEmail("") === null);
  check("a malformed address is null", normalizedEmail("not an email") === null);
  check("a role address is never an identity", normalizedEmail("careers@northwind.example") === null);

  const dana = await addContact(U, "Dana Kim", "dana@northwind.example");
  const eli = await addContact(U, "Eli Park", "eli@northwind.example");
  const vera = await addContact(V, "Vera Stone", "dana@northwind.example");

  console.log("\nResolving addresses");
  const map = await resolveEmails(U, ["DANA@northwind.example", "eli@northwind.example", "nobody@northwind.example", "careers@northwind.example", ""]);
  check("a known address resolves, whatever its case", map.get("dana@northwind.example") === dana);
  check("another known address resolves", map.get("eli@northwind.example") === eli);
  check("an unknown address is absent", !map.has("nobody@northwind.example"));
  check("a role address never resolves", !map.has("careers@northwind.example"));
  check("an empty request is an empty map", (await resolveEmails(U, [])).size === 0);
  check("another account's contact is never returned", [...map.values()].every((id) => id !== vera));
  check("the same address resolves to that account's own contact", (await resolveEmails(V, ["dana@northwind.example"])).get("dana@northwind.example") === vera);

  console.log("\nResolving people");
  const people = await resolvePeople(U, [
    { name: "Dana Kim", email: "dana@northwind.example", title: "Recruiter" },
    { name: "Stranger One", email: "one@elsewhere.example", title: null },
    { name: null, email: "two@elsewhere.example", title: null },
    { name: "Named Only", email: null, title: "Engineer" },
    { name: "  ", email: null, title: null },
  ]);
  check("the input order is kept", people.map((p) => p.name).join("|") === "Dana Kim|Stranger One||Named Only|  ");
  check("a known person carries their contact id", people[0]!.contactId === dana);
  check("a known person is not a suggestion", people[0]!.suggestAdd === false);
  check("a named stranger is offered as an add", people[1]!.contactId === null && people[1]!.suggestAdd === true);
  check("an email with no name cannot be added", people[2]!.contactId === null && people[2]!.suggestAdd === false);
  check("a name with no email is still an add", people[3]!.suggestAdd === true);
  check("a blank name is not", people[4]!.suggestAdd === false);
  check("the other fields pass through untouched", people[0]!.title === "Recruiter" && people[3]!.title === "Engineer");

  console.log("\nA merge, an unmerge and a delete");
  const ellie = await addContact(U, "Eli Park (old card)", "eli.park@oldjob.example");
  check("the old address resolves to the old card", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === ellie);
  const { mergeId } = await mergeContacts(U, eli, ellie);
  check("after a merge the loser's address resolves to the winner", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === eli);
  check("and the winner's own address still does", (await resolveEmails(U, ["eli@northwind.example"])).get("eli@northwind.example") === eli);
  await unmergeContacts(U, mergeId);
  check("after an unmerge it resolves to the restored card", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === ellie);
  await db.delete(contacts).where(eq(contacts.id, dana));
  check("after the contact is deleted the address is unresolved", !(await resolveEmails(U, ["dana@northwind.example"])).has("dana@northwind.example"));
  const gone = await resolvePeople(U, [{ name: "Dana Kim", email: "dana@northwind.example", title: null }]);
  check("and the person becomes an add suggestion", gone[0]!.contactId === null && gone[0]!.suggestAdd === true);

  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  console.log("\nAll email-intel resolve checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
