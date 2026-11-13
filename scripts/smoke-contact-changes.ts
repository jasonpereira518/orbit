/**
 * "Changed by Orbit" and field suggestions (contact-info accuracy plan, PR 3):
 *
 *  - Accepting a company suggestion writes it, with its title, as the person's own.
 *  - Dismissing writes nothing.
 *  - Undo puts the old company and title back together, as the person's own.
 *  - Undo refuses once the field has moved on, and nothing is answered twice.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-contact-changes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { bulkMergeContactsForUser, createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { listContactChangesForUser, resolveContactChangeForUser } from "../src/lib/contact-changes";
import { createCompanyResolver } from "../src/lib/companies";
import { checker } from "./smoke/check";

const USER = "contact-changes-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_changes WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contact_identities WHERE user_id = ${USER}`);
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

  console.log("accept a suggestion");
  const ada = await createContactForUser(USER, { fullName: "Ada Byron", company: "Analytical Engines", title: "CTO" }, { ...OPTS, by: "user" });
  await updateContactForUser(USER, ada.id, { company: "Stripe", title: "VP Eng" }, { ...OPTS, by: "job_move", at: new Date() });
  let list = await listContactChangesForUser(USER);
  t.check("both halves are listed as suggestions", list.suggestions.length === 2 && list.applied.length === 0, JSON.stringify(list.suggestions.map((s) => s.field)));
  const company = list.suggestions.find((s) => s.field === "company")!;
  await resolveContactChangeForUser(USER, company.id, "accept");
  const accepted = await row(ada.id);
  t.check("company and title both written", accepted.company === "Stripe" && accepted.title === "VP Eng", `${accepted.company} / ${accepted.title}`);
  t.check("and now they are the person's", accepted.fieldSources?.company?.s === "user" && accepted.fieldSources?.title?.s === "user");
  t.check("nothing left to answer", (await listContactChangesForUser(USER)).suggestions.length === 0);
  await t.rejects("an answered suggestion can't be answered again", () => resolveContactChangeForUser(USER, company.id, "accept"));

  console.log("dismiss a suggestion");
  await updateContactForUser(USER, ada.id, { company: "Hooli", title: "CEO" }, { ...OPTS, by: "job_move", at: new Date(Date.now() + 60_000) });
  list = await listContactChangesForUser(USER);
  await resolveContactChangeForUser(USER, list.suggestions[0].id, "dismiss");
  const kept = await row(ada.id);
  t.check("dismiss writes nothing", kept.company === "Stripe" && kept.title === "VP Eng", `${kept.company} / ${kept.title}`);
  t.check("and closes both halves", (await listContactChangesForUser(USER)).suggestions.length === 0);

  console.log("undo a change Orbit made");
  const ben = await createContactForUser(USER, { fullName: "Ben Ode", company: "Initech", title: "Engineer" }, OPTS);
  const resolver = await createCompanyResolver(USER);
  await bulkMergeContactsForUser(USER, [{ contactId: ben.id, input: { company: "Hooli", title: "Staff Engineer" } }], resolver, { source: "linkedin_export" });
  list = await listContactChangesForUser(USER);
  t.check("the replacement is listed as changed by Orbit", list.applied.length === 2, JSON.stringify(list.applied.map((a) => [a.field, a.before, a.after])));
  await resolveContactChangeForUser(USER, list.applied.find((a) => a.field === "title")!.id, "undo");
  const undone = await row(ben.id);
  t.check("undo restores company and title together", undone.company === "Initech" && undone.title === "Engineer", `${undone.company} / ${undone.title}`);
  t.check("restored values are the person's now", undone.fieldSources?.company?.s === "user");
  t.check("both leave the list", (await listContactChangesForUser(USER)).applied.length === 0);

  console.log("undo refuses once the field moved on");
  const cy = await createContactForUser(USER, { fullName: "Cy Dee", company: "Acme" }, OPTS);
  await bulkMergeContactsForUser(USER, [{ contactId: cy.id, input: { company: "Globex" } }], resolver, { source: "linkedin_export" });
  const change = (await listContactChangesForUser(USER)).applied.find((a) => a.contactId === cy.id)!;
  await updateContactForUser(USER, cy.id, { company: "Umbrella" }, { ...OPTS, by: "user" });
  await t.rejects("undo after a newer edit is refused", () => resolveContactChangeForUser(USER, change.id, "undo"));
  t.check("and the newer value stands", (await row(cy.id)).company === "Umbrella");
  await t.rejects("another account's change is not found", () => resolveContactChangeForUser("someone-else", change.id, "undo"));

  await reset();
  t.done("contact changes smoke tests");
}

run(main);
