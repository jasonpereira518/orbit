/**
 * Work contacts: the SQL that picks them, the pill that shows them, and the paths that must
 * keep `view=work` when the list re-queries. The SQL half runs on PGlite; the wiring half
 * reads the source, because the list is a client component behind a gated page.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords } from "../src/db/schema";
import { workContactsCondition } from "../src/lib/crm/work-contacts";
import { PEOPLE_VIEWS, directionForPeopleNav } from "../src/lib/people-nav";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const code = (file: string) =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const USER = "smoke-work-contacts";
const OTHER = "smoke-work-contacts-other";

run(async () => {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }

  console.log("the SQL");
  const [work, personal, planted] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Work Person" },
      { userId: USER, fullName: "Personal Friend" },
      { userId: USER, fullName: "Planted" },
    ])
    .returning();
  await db.insert(crmRecords).values([
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "1", lifecycle: "customer", displayName: "Work Person", contactId: work.id },
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "2", lifecycle: "customer", displayName: "Also Work", contactId: work.id },
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "3", lifecycle: "lead", displayName: "Unlinked" },
    // Another account's record naming this user's contact must not make it a work contact.
    { userId: OTHER, connectorId: "hubspot", remoteType: "contact", remoteId: "9", lifecycle: "customer", displayName: "Planted", contactId: planted.id },
  ]);
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, USER), workContactsCondition(USER)));
  check("only the linked contact, once", rows.length === 1 && rows[0]?.id === work.id, JSON.stringify(rows));
  check("a personal contact is not work", !rows.some((r) => r.id === personal.id));
  check("another account's record never counts", !rows.some((r) => r.id === planted.id));
  const src = code("src/lib/crm/work-contacts.ts");
  check("the user id is bound, not correlated", /cr\.user_id = \$\{userId\}/.test(src) && !/cr\.user_id = contacts\.user_id/.test(src));

  console.log("\nthe pill's direction");
  check("contacts, work, recruiters", PEOPLE_VIEWS.join(",") === "contacts,work,recruiters");
  check("contacts → work slides forward", directionForPeopleNav("contacts", "work") === 1);
  check("work → recruiters slides forward", directionForPeopleNav("work", "recruiters") === 1);
  check("recruiters → work slides back", directionForPeopleNav("recruiters", "work") === -1);
  check("work → contacts slides back", directionForPeopleNav("work", "contacts") === -1);
  check("staying put does not slide", directionForPeopleNav("work", "work") === 0);

  console.log("\nthe wiring");
  const shell = code("src/components/contacts/people-list-shell.tsx");
  check("the shell offers Work at /contacts?view=work", shell.includes('"/contacts?view=work"') && shell.includes('"Work"'));
  check("only when told to", shell.includes("showWork"));
  const page = code("src/app/(clerk)/(app)/(main)/contacts/page.tsx");
  check("the contacts page asks whether Leads is released", page.includes('isSurfaceReleased(') && page.includes('"page.leads"'));
  check("and honours view=work only then", /showWork\s*&&\s*params\.view\s*===\s*"work"/.test(page));
  check("the list is keyed on the view", /key=\{\[[^\]]*work/.test(page));
  check("the recruiters page shows the pill the same way", code("src/app/(clerk)/(app)/(main)/recruiters/page.tsx").includes("showWork"));
  check("the filters keep view=work", /params\.set\("view", "work"\)/.test(code("src/components/contacts/contacts-filters.tsx")));
  check("the A–Z seek keeps view=work", /params\.set\("view", "work"\)/.test(code("src/components/contacts/contacts-list.tsx")));
  const action = code("src/actions/contacts.ts");
  check("the list query re-checks the release before filtering", action.includes("workContactsCondition(") && action.includes('isSurfaceReleased(userId, "page.leads")'));

  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll work contact checks passed.");
});
