/**
 * The kept LinkedIn export as a source for contacts added later (contact-info accuracy plan,
 * PR 4, `src/lib/linkedin-export-facts.ts`):
 *
 *  - A contact created after the upload, matched by email, gets their URL, role and
 *    when-connected from Connections.csv.
 *  - A company the person typed holds (the field rule), but the URL still fills.
 *  - A bare name is not enough, and two equally good namesakes are left alone.
 *  - Without an argument, every contact still missing a LinkedIn URL is filled.
 *
 * Writes to a throwaway local PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-export-facts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { createContactForUser } from "../src/lib/contact-writes";
import { gzipBase64 } from "../src/lib/imports/export-upload";
import { appendExportFiles, beginExport, finishExportUpload } from "../src/lib/linkedin-export-store";
import { fillFromStoredExport } from "../src/lib/linkedin-export-facts";
import { checker } from "./smoke/check";

const USER = "export-facts-smoke-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;
const t = checker();

const CONNECTIONS = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ada,Byron,https://www.linkedin.com/in/ada-byron,ada@engines.example,Stripe,VP Engineering,15 Mar 2024
Ben,Ode,https://www.linkedin.com/in/ben-ode,,Hooli,Staff Engineer,02 Jan 2023
Sam,Lee,https://www.linkedin.com/in/sam-lee-1,,Acme,Engineer,01 Feb 2022
Sam,Lee,https://www.linkedin.com/in/sam-lee-2,,Acme,Designer,01 Feb 2022
Cy,Dee,https://www.linkedin.com/in/cy-dee,,Globex,Founder,05 May 2021
`;

async function reset() {
  const db = await getDb();
  for (const table of ["contact_changes", "contact_identities", "import_files", "imports", "contacts", "companies"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE user_id = ${USER}`);
  }
}

async function row(id: string) {
  const db = await getDb();
  const [r] = await db.select().from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.id, id))).limit(1);
  return r!;
}

async function main() {
  await reset();
  const { importId } = await beginExport(USER, "LinkedIn export");
  await appendExportFiles(USER, importId, [{ path: "Connections.csv", byteSize: CONNECTIONS.length, gz: await gzipBase64(CONNECTIONS) }]);
  await finishExportUpload(USER, importId, { tooLarge: 0, private: 0 });

  console.log("a contact added after the upload");
  const ada = await createContactForUser(USER, { fullName: "Ada Byron", email: "ada@engines.example" }, { ...OPTS, by: "user" });
  t.check("one contact filled", (await fillFromStoredExport(USER, [ada.id])) === 1);
  const a = await row(ada.id);
  t.check("URL, company and role from the export", a.linkedinUrl === "https://www.linkedin.com/in/ada-byron" && a.company === "Stripe" && a.title === "VP Engineering", JSON.stringify([a.linkedinUrl, a.company, a.title]));
  t.check("stamped as the LinkedIn export", a.fieldSources?.company?.s === "linkedin_export");
  t.check("connected-on becomes date met", a.dateMet?.toISOString().startsWith("2024-03-15") === true, String(a.dateMet));

  console.log("what the person typed holds");
  // Matched on name + company (0.90). He typed his role after the export was uploaded, so
  // the export's older one neither replaces it nor is offered.
  const ben = await createContactForUser(USER, { fullName: "Ben Ode", company: "Hooli", title: "Engineer" }, { ...OPTS, by: "user" });
  await fillFromStoredExport(USER, [ben.id]);
  const b = await row(ben.id);
  t.check("the typed role stays", b.title === "Engineer", `${b.company} / ${b.title}`);
  t.check("but the LinkedIn URL fills", b.linkedinUrl === "https://www.linkedin.com/in/ben-ode", String(b.linkedinUrl));

  console.log("not enough to go on");
  const sam = await createContactForUser(USER, { fullName: "Sam Lee", company: "Acme" }, OPTS);
  const cy = await createContactForUser(USER, { fullName: "Cy Dee" }, OPTS);
  await fillFromStoredExport(USER, [sam.id, cy.id]);
  t.check("two namesakes at one company: left alone", !(await row(sam.id)).linkedinUrl);
  t.check("a bare name: left alone", !(await row(cy.id)).linkedinUrl);

  console.log("everyone still missing a URL");
  await createContactForUser(USER, { fullName: "Cy Dee", company: "Globex" }, OPTS);
  t.check("the whole-network pass fills the matchable one", (await fillFromStoredExport(USER)) === 1);

  console.log("no export, nothing to do");
  await reset();
  const lone = await createContactForUser(USER, { fullName: "Ada Byron", email: "ada@engines.example" }, OPTS);
  t.check("fills nothing", (await fillFromStoredExport(USER, [lone.id])) === 0);

  await reset();
  t.done("export facts smoke tests");
}

run(main);
