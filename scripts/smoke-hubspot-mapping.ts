/**
 * HubSpot's pure half: what a contact search result becomes, what the search asks for, and
 * how a sync pages through an owner's contacts across runs without HubSpot's 10,000-result
 * ceiling ever stopping it. Run: npx tsx scripts/smoke-hubspot-mapping.ts
 */
import {
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_FULL_RESYNC_MS,
  HUBSPOT_SCOPES,
  advanceWindow,
  buildContactSearchBody,
  cursorFromWindow,
  hubspotRecordUrl,
  identityFromCursor,
  lifecycleForStage,
  mapHubspotContact,
  parseHubspotDate,
  windowFromCursor,
  type HubspotWindow,
} from "../src/lib/crm/hubspot/mapping";
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

console.log("lifecycle");
for (const [stage, want] of [
  ["customer", "customer"],
  ["evangelist", "customer"],
  ["subscriber", "lead"],
  ["lead", "lead"],
  ["marketingqualifiedlead", "lead"],
  ["salesqualifiedlead", "lead"],
  ["opportunity", "lead"],
  ["other", "other"],
  ["1234567", "other"],
  ["", "other"],
  [null, "other"],
  ["Customer", "customer"],
] as const) {
  check(`${JSON.stringify(stage)} → ${want}`, lifecycleForStage(stage) === want, lifecycleForStage(stage));
}

console.log("\nscopes and properties");
check("reads contacts and owners only", HUBSPOT_SCOPES.join(" ") === "crm.objects.contacts.read crm.objects.owners.read");
for (const p of ["lastmodifieddate", "hubspot_owner_id", "lifecyclestage", "company", "hs_linkedin_url"]) {
  check(`asks for ${p}`, (HUBSPOT_CONTACT_PROPERTIES as readonly string[]).includes(p));
}
check("never asks for associatedcompanyid (read-only, absent in 2026-09)", !(HUBSPOT_CONTACT_PROPERTIES as readonly string[]).includes("associatedcompanyid"));

console.log("\ndates");
check("ISO", parseHubspotDate("2026-09-01T10:00:00.000Z")?.toISOString() === "2026-09-01T10:00:00.000Z");
check("epoch ms string", parseHubspotDate("1788256800000")?.getTime() === 1788256800000);
check("empty is null", parseHubspotDate("") === null && parseHubspotDate(null) === null && parseHubspotDate(undefined) === null);
check("garbage is null", parseHubspotDate("soon") === null);

console.log("\nmapping a contact");
const full = mapHubspotContact(
  {
    id: "501",
    properties: {
      firstname: "Dana",
      lastname: "Whitfield",
      email: "Dana@Acme.test",
      phone: "",
      mobilephone: "+1 415 555 0100",
      company: "Acme",
      jobtitle: "VP Sales",
      hs_linkedin_url: "https://www.linkedin.com/in/danaw",
      lifecyclestage: "customer",
      hs_lead_status: "CONNECTED",
      hubspot_owner_id: "77",
      createdate: "2026-01-01T00:00:00.000Z",
      lastmodifieddate: "2026-09-20T08:00:00.000Z",
      notes_last_updated: "2026-09-19T08:00:00.000Z",
    },
  },
  { portalId: "4242" }
);
check("a full record maps", full !== null);
check("name from first + last", full?.displayName === "Dana Whitfield");
check("remote id and type", full?.remoteId === "501" && full?.remoteType === "contact");
check("lifecycle and raw stage", full?.lifecycle === "customer" && full?.stage === "customer");
check("email kept as written", full?.email === "Dana@Acme.test");
check("an empty phone falls back to the mobile", full?.phone === "+1 415 555 0100");
check("company from the contact's own company property", full?.companyName === "Acme" && full?.companyDomain === null);
check("title and linkedin", full?.title === "VP Sales" && full?.linkedinUrl === "https://www.linkedin.com/in/danaw");
check("owner ref", full?.remoteOwnerRef === "77");
check("record url built from the portal", full?.remoteUrl === "https://app.hubspot.com/contacts/4242/record/0-1/501", String(full?.remoteUrl));
check("updated / created / activity dates", full?.remoteUpdatedAt?.toISOString() === "2026-09-20T08:00:00.000Z" && full?.remoteCreatedAt?.toISOString() === "2026-01-01T00:00:00.000Z" && full?.lastActivityAt?.toISOString() === "2026-09-19T08:00:00.000Z");
check("lead status is the only whitelisted extra", JSON.stringify(full?.properties) === JSON.stringify({ hs_lead_status: "CONNECTED" }));

const emailOnly = mapHubspotContact({ id: "502", properties: { email: "solo@acme.test", lastmodifieddate: "2026-09-20T09:00:00.000Z" } }, { portalId: "4242" });
check("no name falls back to the email", emailOnly?.displayName === "solo@acme.test");
check("no stage is other", emailOnly?.lifecycle === "other" && emailOnly?.stage === null);
check("no extras is an empty object", JSON.stringify(emailOnly?.properties) === "{}");

check("nothing to call them by is skipped", mapHubspotContact({ id: "503", properties: {} }, { portalId: "4242" }) === null);
check(
  "an EU record url from HubSpot is preferred",
  mapHubspotContact({ id: "504", properties: { firstname: "Eu" }, url: "https://app-eu1.hubspot.com/contacts/9/record/0-1/504" }, { portalId: "9" })?.remoteUrl === "https://app-eu1.hubspot.com/contacts/9/record/0-1/504"
);
check(
  "a url that is not HubSpot's is ignored",
  mapHubspotContact({ id: "505", properties: { firstname: "X" }, url: "https://evil.test/x" }, { portalId: "9" })?.remoteUrl === hubspotRecordUrl("9", "505")
);
check("an archived result is skipped", mapHubspotContact({ id: "506", properties: { firstname: "Gone" }, archived: true }, { portalId: "9" }) === null);

console.log("\nthe search body");
const first = buildContactSearchBody({ ownerId: "77", since: null, after: null }) as Record<string, unknown>;
const firstFilters = (first.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters;
check("always filtered to the owner", firstFilters.length === 1 && firstFilters[0].propertyName === "hubspot_owner_id" && firstFilters[0].operator === "EQ" && firstFilters[0].value === "77");
check("sorted oldest-modified first", JSON.stringify(first.sorts) === JSON.stringify([{ propertyName: "lastmodifieddate", direction: "ASCENDING" }]));
check("a page of 100", first.limit === 100);
check("no after on a first page", !("after" in first));
check("asks for the property list", JSON.stringify(first.properties) === JSON.stringify(HUBSPOT_CONTACT_PROPERTIES));
const later = buildContactSearchBody({ ownerId: "77", since: "2026-09-20T08:00:00.000Z", after: "200" }) as Record<string, unknown>;
const laterFilters = (later.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters;
check("a since filter, as epoch ms, GTE", laterFilters[1]?.propertyName === "lastmodifieddate" && laterFilters[1]?.operator === "GTE" && laterFilters[1]?.value === String(Date.parse("2026-09-20T08:00:00.000Z")));
check("carries after", later.after === "200");
check("stays under HubSpot's 3,000-character body limit", JSON.stringify(later).length < 3000, String(JSON.stringify(later).length));

console.log("\nthe paging window");
const fresh = windowFromCursor(null, NOW);
check("a first run is a full window", fresh.full && fresh.since === null && fresh.after === null);
const recent = windowFromCursor({ syncedThrough: "2026-09-20T08:00:00.000Z", cursor: null, meta: { portalId: "1", ownerId: "2", fullSyncedAt: "2026-09-22T00:00:00.000Z" } }, NOW);
check("a recent full sync means an incremental window", !recent.full && recent.since === "2026-09-20T08:00:00.000Z");
const stale = windowFromCursor({ syncedThrough: "2026-09-20T08:00:00.000Z", cursor: null, meta: { fullSyncedAt: new Date(NOW.getTime() - HUBSPOT_FULL_RESYNC_MS - 1).toISOString() } }, NOW);
check("a week-old full sync means a full window again", stale.full && stale.since === null);
const resumed = windowFromCursor({ syncedThrough: null, cursor: "300", meta: { full: "1", windowMax: "2026-09-10T00:00:00.000Z" } }, NOW);
check("a window mid-page resumes as it was", resumed.full && resumed.after === "300" && resumed.windowMax === "2026-09-10T00:00:00.000Z");

const w0: HubspotWindow = { since: null, after: null, windowMax: null, full: true, fullSyncedAt: null };
const p1 = advanceWindow(w0, { maxModified: "2026-09-01T00:00:00.000Z", nextAfter: "100" }, NOW);
check("more pages: take after, keep since", !p1.done && p1.window.after === "100" && p1.window.since === null);
check("the window max rises", p1.window.windowMax === "2026-09-01T00:00:00.000Z");
const p2 = advanceWindow({ ...p1.window, after: "9900" }, { maxModified: "2026-09-05T00:00:00.000Z", nextAfter: "10000" }, NOW);
check("crossing the ceiling restarts at the window max", !p2.done && p2.window.since === "2026-09-05T00:00:00.000Z" && p2.window.after === null);
check("…and stays a full window", p2.window.full);
const stuck = advanceWindow({ since: "2026-09-05T00:00:00.000Z", after: "9900", windowMax: "2026-09-05T00:00:00.000Z", full: false, fullSyncedAt: null }, { maxModified: "2026-09-05T00:00:00.000Z", nextAfter: "10000" }, NOW);
check("a ceiling that cannot advance ends instead of looping", stuck.done);
const last = advanceWindow(p2.window, { maxModified: "2026-09-06T00:00:00.000Z", nextAfter: null }, NOW);
check("the last page ends the window at its max", last.done && last.window.since === "2026-09-06T00:00:00.000Z" && last.window.after === null && last.window.windowMax === null);
check("a full window stamps fullSyncedAt and clears the flag", last.window.fullSyncedAt === NOW.toISOString() && !last.window.full);
const empty = advanceWindow({ since: "2026-09-06T00:00:00.000Z", after: null, windowMax: null, full: false, fullSyncedAt: "2026-09-22T00:00:00.000Z" }, { maxModified: null, nextAfter: null }, NOW);
check("an empty incremental window keeps its since", empty.done && empty.window.since === "2026-09-06T00:00:00.000Z" && empty.window.fullSyncedAt === "2026-09-22T00:00:00.000Z");

console.log("\nthe cursor round trip");
const cursor = cursorFromWindow(p1.window, { portalId: "4242", ownerId: "77", hubUserId: "9" });
check("identity survives", JSON.stringify(identityFromCursor(cursor)) === JSON.stringify({ portalId: "4242", ownerId: "77", hubUserId: "9" }));
const back = windowFromCursor(cursor, NOW);
check("the window survives", back.after === "100" && back.full && back.windowMax === "2026-09-01T00:00:00.000Z");
check("meta is strings only", Object.values(cursor.meta ?? {}).every((v) => typeof v === "string"));
check("no identity without both portal and owner", identityFromCursor({ meta: { portalId: "1" } }) === null && identityFromCursor(null) === null);

console.log("\npurity");
for (const file of ["src/lib/crm/types.ts", "src/lib/crm/hubspot/mapping.ts"]) {
  const src = readFileSync(file, "utf8");
  check(`${file} imports no database or server module`, !/from\s+["']@\/db["']|from\s+["']@\/lib\/(?!crm\/)/.test(src.replace(/import type[^;]+;/g, "")));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll HubSpot mapping checks passed.");
