/**
 * The field-source rule (`src/lib/contact-fields.ts`): which automated source may change which
 * contact field. Pure: no database. The writers obeying it are checked in
 * smoke-contact-fields-db.ts.
 */
import { decideFieldWrites, userStamps, type FieldSources } from "../src/lib/contact-fields";
import { checker } from "./smoke/check";

const t = checker();
const OLD = "2025-01-01T00:00:00.000Z";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const typed: FieldSources = { company: { s: "user", at: OLD }, title: { s: "user", at: OLD } };

console.log("fills a blank");
{
  const d = decideFieldWrites({ company: null }, null, { company: "Stripe", school: "MIT" }, "address_book", NOW);
  t.check("writes both", d.write.company === "Stripe" && d.write.school === "MIT");
  t.check("stamps the source", d.stamps.company?.s === "address_book");
  t.check("a kept-record fill is not logged", d.changes.length === 0);
  const w = decideFieldWrites({ location: null }, null, { location: "Austin" }, "web", NOW);
  t.check("an inferred fill is logged", w.changes.length === 1 && w.changes[0].status === "applied");
  t.check("web research never fills an email", !("email" in decideFieldWrites({}, null, { email: "a@b.co" }, "web", NOW).write));
}

console.log("never replaces what the person typed");
{
  const sync = decideFieldWrites({ company: "Acme", title: "CTO" }, typed, { company: "Globex", title: "VP" }, "address_book", NOW);
  t.check("an address book changes nothing", Object.keys(sync.write).length === 0 && sync.changes.length === 0);
  const move = decideFieldWrites({ company: "Acme", title: "CTO" }, typed, { company: "Stripe", title: "VP Eng" }, "job_move", NOW);
  t.check("a newer job move is a suggestion, not a write", Object.keys(move.write).length === 0);
  t.check("one suggestion per field", move.changes.filter((c) => c.status === "suggested").length === 2);
  const stale = decideFieldWrites({ company: "Acme" }, typed, { company: "Initech" }, "job_move", new Date("2024-06-01"));
  t.check("an older fact than the typed one is dropped", stale.changes.length === 0);
  const cleared = decideFieldWrites({ company: null }, typed, { company: "Globex" }, "address_book", NOW);
  t.check("a field the person cleared stays clear", Object.keys(cleared.write).length === 0);
}

console.log("unknown (pre-ledger) values");
{
  const sync = decideFieldWrites({ company: "Acme" }, null, { company: "Globex" }, "import", NOW);
  t.check("an import does not replace an unknown value", Object.keys(sync.write).length === 0);
  const exp = decideFieldWrites({ company: "Acme" }, null, { company: "Stripe" }, "linkedin_export", NOW);
  t.check("a dated record does", exp.write.company === "Stripe");
  t.check("and logs it with the old value", exp.changes[0]?.before === "Acme" && exp.changes[0]?.status === "applied");
}

console.log("between automated sources");
{
  const fromBook: FieldSources = { company: { s: "address_book", at: OLD } };
  t.check("dated beats kept", decideFieldWrites({ company: "Acme" }, fromBook, { company: "Stripe" }, "extension", NOW).write.company === "Stripe");
  t.check("kept does not flip kept", !decideFieldWrites({ company: "Acme" }, fromBook, { company: "Acme Corp" }, "address_book", NOW).write.company);
  t.check("inferred never beats kept", !decideFieldWrites({ company: "Acme" }, fromBook, { company: "Stripe" }, "web", NOW).write.company);
  const dated: FieldSources = { company: { s: "linkedin_export", at: "2026-01-01T00:00:00.000Z" } };
  t.check("a newer dated fact wins", decideFieldWrites({ company: "Acme" }, dated, { company: "Stripe" }, "job_move", NOW).write.company === "Stripe");
  t.check("an older dated fact loses", !decideFieldWrites({ company: "Acme" }, dated, { company: "Stripe" }, "job_move", new Date("2025-06-01")).write.company);
}

console.log("fill-only fields and identifiers");
{
  const base = { email: "a@acme.co", phone: "+1 555 0100", school: "MIT", linkedinUrl: "https://www.linkedin.com/in/ada/" };
  const d = decideFieldWrites(base, null, { email: "ada@new.co", phone: "+1 555 0199", school: "Stanford" }, "linkedin_export", NOW);
  t.check("email, phone and school are never replaced", Object.keys(d.write).length === 0 && d.changes.length === 0);
  const li = decideFieldWrites(base, null, { linkedinUrl: "https://linkedin.com/in/ada-other" }, "extension", NOW);
  t.check("a different LinkedIn URL is a suggestion", !li.write.linkedinUrl && li.changes[0]?.status === "suggested");
  const sameLi = decideFieldWrites(base, null, { linkedinUrl: "linkedin.com/in/ada" }, "extension", NOW);
  t.check("the same URL spelled differently is a restamp, not a change", sameLi.changes.length === 0 && sameLi.stamps.linkedinUrl?.s === "extension" && !sameLi.write.linkedinUrl);
}

console.log("company and title move together");
{
  const half: FieldSources = { title: { s: "user", at: "2026-12-01T00:00:00.000Z" } };
  const d = decideFieldWrites({ company: "Acme", title: "CTO" }, half, { company: "Stripe", title: "VP" }, "job_move", NOW);
  t.check("a typed title holds the company too", Object.keys(d.write).length === 0);
  const dated: FieldSources = { company: { s: "linkedin_export", at: OLD }, title: { s: "linkedin_export", at: OLD } };
  const sameTitle = decideFieldWrites({ company: "Acme", title: "CTO" }, dated, { company: "Stripe", title: "CTO" }, "job_move", NOW);
  t.check("an unchanged title does not hold up a new company", sameTitle.write.company === "Stripe");
  const fill = decideFieldWrites({ company: null, title: "CTO" }, half, { company: "Stripe", title: "VP" }, "job_move", NOW);
  t.check("a blank company still fills", fill.write.company === "Stripe" && !fill.write.title);
}

console.log("user stamps");
{
  const s = userStamps({ company: "Acme", title: "CTO", location: null }, { company: "Acme", title: "CEO", location: "", school: "MIT" }, NOW);
  t.check("only changed fields are stamped", !s.company && s.title?.s === "user" && !s.location && s.school?.s === "user");
  t.check("clearing a field stamps it", userStamps({ company: "Acme" }, { company: "" }, NOW).company?.s === "user");
}

t.done("contact fields smoke tests");
