/**
 * Salesforce, pure: host trust, SOQL, the keyset progress a sync carries between runs, and
 * what a Contact or Lead becomes. No database, no network.
 *
 * Run: npx tsx scripts/smoke-salesforce-mapping.ts
 */
import {
  SALESFORCE_PAGE,
  advanceProgress,
  buildOwnedQuery,
  cursorFromProgress,
  identityFromCursor,
  isSalesforceId,
  isTrustedSalesforceUrl,
  mapSalesforceRecord,
  markOf,
  parseSalesforceDate,
  progressFromCursor,
  soqlDateTime,
  type SalesforceProgress,
} from "../src/lib/crm/salesforce/mapping";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const OWNER = "005000000000001AAA";
const INSTANCE = "https://acme.my.salesforce.com";

console.log("\nhosts");
check("a My Domain host is trusted", isTrustedSalesforceUrl("https://acme.my.salesforce.com/services/data"));
check("a sandbox host is trusted", isTrustedSalesforceUrl("https://acme--dev.sandbox.my.salesforce.com"));
check("force.com is trusted", isTrustedSalesforceUrl("https://acme.lightning.force.com"));
check("http is not", !isTrustedSalesforceUrl("http://acme.my.salesforce.com"));
check("a suffix look-alike is not", !isTrustedSalesforceUrl("https://evilsalesforce.com") && !isTrustedSalesforceUrl("https://salesforce.com.evil.example"));
check("credentials in the URL are not", !isTrustedSalesforceUrl("https://a:b@acme.my.salesforce.com"));
check("a port is not", !isTrustedSalesforceUrl("https://acme.my.salesforce.com:8443"));
check("garbage is not", !isTrustedSalesforceUrl("not a url") && !isTrustedSalesforceUrl(null));

console.log("\nids and dates");
check("15- and 18-char ids", isSalesforceId("003000000000001") && isSalesforceId(OWNER));
check("anything else is not an id", !isSalesforceId("003' OR Id != '") && !isSalesforceId("") && !isSalesforceId(42));
check("SOQL datetimes are second precision, unquoted", soqlDateTime("2026-09-26T12:00:00.789Z") === "2026-09-26T12:00:00Z");
check("Salesforce's +0000 offset parses", parseSalesforceDate("2026-09-26T12:00:00.000+0000")?.toISOString() === "2026-09-26T12:00:00.000Z");
check("a date-only value parses", parseSalesforceDate("2026-09-01")?.toISOString() === "2026-09-01T00:00:00.000Z");
check("empty is null", parseSalesforceDate("") === null && parseSalesforceDate(null) === null && parseSalesforceDate("nope") === null);

console.log("\nSOQL");
const first = buildOwnedQuery("Contact", { ownerId: OWNER, after: null, lean: false });
check("filters on the owner", first.includes(`WHERE OwnerId = '${OWNER}'`), first);
check("orders by the stamp, then the id", first.includes("ORDER BY SystemModstamp ASC, Id ASC"), first);
check("pages at 200", first.endsWith(`LIMIT ${SALESFORCE_PAGE}`), first);
check("reads the account name", first.includes("Account.Name"), first);
const next = buildOwnedQuery("Lead", { ownerId: OWNER, after: { at: "2026-09-26T12:00:00.000Z", id: "00Q000000000009AAA" }, lean: false });
check("resumes strictly after the mark", next.includes("(SystemModstamp > 2026-09-26T12:00:00Z OR (SystemModstamp = 2026-09-26T12:00:00Z AND Id > '00Q000000000009AAA'))"), next);
check("reads a lead's conversion", next.includes("IsConverted") && next.includes("ConvertedContactId") && next.includes("Company"), next);
const lean = buildOwnedQuery("Contact", { ownerId: OWNER, after: null, lean: true });
check("the lean list drops the optional fields", !lean.includes("Phone") && !lean.includes("Title") && lean.includes("Email"), lean);
const threw = (() => { try { buildOwnedQuery("Contact", { ownerId: "x' OR '1'='1", after: null, lean: false }); return false; } catch { return true; } })();
check("a non-id owner never reaches SOQL", threw);
const threwMark = (() => { try { buildOwnedQuery("Contact", { ownerId: OWNER, after: { at: "2026-09-26T12:00:00Z", id: "bad'" }, lean: false }); return false; } catch { return true; } })();
check("nor does a non-id mark", threwMark);

console.log("\nmapping");
const contact = mapSalesforceRecord("Contact", {
  Id: "003000000000001AAA", FirstName: "Ada", LastName: "Lovelace", Email: "ada@acme.com", Phone: "+1 555 0100",
  Title: "CTO", Account: { Name: "Acme" }, OwnerId: OWNER, CreatedDate: "2026-01-01T00:00:00.000+0000",
  SystemModstamp: "2026-09-26T12:00:00.000+0000", LastActivityDate: "2026-09-01",
}, { instanceUrl: INSTANCE });
check("a Contact is a customer", contact?.lifecycle === "customer" && contact.remoteType === "contact");
check("with its name, email, company, title", contact?.displayName === "Ada Lovelace" && contact.email === "ada@acme.com" && contact.companyName === "Acme" && contact.title === "CTO");
check("and a Lightning record URL on its own host", contact?.remoteUrl === `${INSTANCE}/lightning/r/Contact/003000000000001AAA/view`, String(contact?.remoteUrl));
check("its stamp is remoteUpdatedAt", contact?.remoteUpdatedAt?.toISOString() === "2026-09-26T12:00:00.000Z");
check("its last activity is read", contact?.lastActivityAt?.toISOString() === "2026-09-01T00:00:00.000Z");
check("the owner is kept", contact?.remoteOwnerRef === OWNER);

const lead = mapSalesforceRecord("Lead", { Id: "00Q000000000001AAA", FirstName: "Bo", LastName: "Chen", Email: null, Company: "[not provided]", Status: "Working - Contacted", IsConverted: false, OwnerId: OWNER, SystemModstamp: "2026-09-26T12:00:00.000+0000" }, { instanceUrl: INSTANCE });
check("an open Lead is a lead", lead?.lifecycle === "lead" && lead.remoteType === "lead" && lead.stage === "Working - Contacted");
check("Salesforce's company placeholder is no company", lead?.companyName === null, String(lead?.companyName));
check("its status is kept as a property", lead?.properties.sf_status === "Working - Contacted");
const converted = mapSalesforceRecord("Lead", { Id: "00Q000000000002AAA", LastName: "Diaz", Company: "Initech", IsConverted: true, ConvertedContactId: "003000000000002AAA", OwnerId: OWNER }, { instanceUrl: INSTANCE });
check("a converted Lead is a customer", converted?.lifecycle === "customer" && converted.stage === "Converted");
check("and remembers the Contact it became", converted?.properties.sf_converted_contact_id === "003000000000002AAA");
check("a record with no name and no email is skipped", mapSalesforceRecord("Contact", { Id: "003000000000003AAA", OwnerId: OWNER }, { instanceUrl: INSTANCE }) === null);
check("an email alone names someone", mapSalesforceRecord("Contact", { Id: "003000000000004AAA", Email: "x@y.com" }, { instanceUrl: INSTANCE })?.displayName === "x@y.com");
check("a record without a valid id is skipped", mapSalesforceRecord("Contact", { Id: "nope", LastName: "Z" }, { instanceUrl: INSTANCE }) === null);

console.log("\nprogress");
check("a record's mark", markOf({ Id: "003000000000001AAA", SystemModstamp: "2026-09-26T12:00:00.000+0000" })?.at === "2026-09-26T12:00:00.000Z");
check("no stamp, no mark", markOf({ Id: "003000000000001AAA" }) === null);
const fresh = progressFromCursor(null);
check("a fresh cursor starts on contacts, from the beginning", fresh.phase === "Contact" && fresh.contact === null && fresh.lead === null && !fresh.lean);
const mark = { at: "2026-09-26T12:00:00.000Z", id: "003000000000001AAA" };
const midContacts = advanceProgress(fresh, { last: mark, full: true });
check("a full page stays on contacts, at its last record", !midContacts.done && midContacts.progress.phase === "Contact" && midContacts.progress.contact?.id === mark.id);
const toLeads = advanceProgress(midContacts.progress, { last: mark, full: false });
check("a short page moves to leads", !toLeads.done && toLeads.progress.phase === "Lead");
check("and rewinds the contact watermark by the overlap", toLeads.progress.contact?.at === "2026-09-26T11:55:00.000Z" && toLeads.progress.contact?.id === "", JSON.stringify(toLeads.progress.contact));
const emptyLeads = advanceProgress(toLeads.progress, { last: null, full: false });
check("an empty lead page finishes the run, back on contacts", emptyLeads.done && emptyLeads.progress.phase === "Contact");
check("an empty page keeps the watermark", emptyLeads.progress.lead === null && emptyLeads.progress.contact?.at === "2026-09-26T11:55:00.000Z");
const emptyContacts = advanceProgress({ ...fresh, contact: { at: "2026-09-20T00:00:00.000Z", id: "" } }, { last: null, full: false });
check("an empty contact page moves on without rewinding again", emptyContacts.progress.phase === "Lead" && emptyContacts.progress.contact?.at === "2026-09-20T00:00:00.000Z");

const identity = { orgId: "00D000000000001AAA", userId: OWNER };
const withLean: SalesforceProgress = { ...toLeads.progress, lean: true };
const round = progressFromCursor(cursorFromProgress(withLean, identity));
check("progress round-trips through the cursor", JSON.stringify(round) === JSON.stringify(withLean), JSON.stringify(round));
check("identity round-trips", JSON.stringify(identityFromCursor(cursorFromProgress(withLean, identity))) === JSON.stringify(identity));
check("a cursor without identity has none", identityFromCursor({ meta: { orgId: "00D000000000001AAA" } }) === null && identityFromCursor(null) === null);
check("meta holds strings only", Object.values(cursorFromProgress(withLean, identity).meta ?? {}).every((v) => typeof v === "string"));

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Salesforce mapping checks passed.");
process.exit(0);
