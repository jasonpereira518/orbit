/**
 * A CRM page into Orbit: the pipeline rules as a pure table, then `persistCrmPage` end to end
 * — customers become (or match) contacts and are linked; leads land in the pipeline, merge
 * with the manual targets they duplicate, and convert when the CRM says they became customers.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords, leads, type Lead } from "../src/db/schema";
import { planCrmLeads, type CrmLeadRecord, type ExistingLead } from "../src/lib/crm/crm-leads-plan";
import { persistCrmPage } from "../src/lib/crm/persist";
import type { CrmPerson } from "../src/lib/crm/types";
import { openIngestContext } from "../src/lib/ingest/events";
import { loadPipeline } from "../src/lib/leads/pipeline";
import { saveLead } from "../src/lib/leads/store";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-leads";

function rec(over: Partial<CrmLeadRecord> & Pick<CrmLeadRecord, "id">): CrmLeadRecord {
  return { lifecycle: "lead", contactId: null, displayName: "Someone", email: null, phone: null, linkedinUrl: null, companyName: null, title: null, ...over };
}

function lead(over: Partial<ExistingLead> & Pick<ExistingLead, "id">): ExistingLead {
  return {
    crmRecordId: null,
    status: "open",
    contactId: null,
    email: null,
    emailNormalized: null,
    linkedinUrl: null,
    linkedinSlug: null,
    phone: null,
    phoneE164: null,
    companyName: null,
    companyNormalized: null,
    title: null,
    ...over,
  };
}

function person(over: Partial<CrmPerson> & Pick<CrmPerson, "remoteId" | "displayName">): CrmPerson {
  return {
    remoteType: "contact",
    lifecycle: "lead",
    stage: "lead",
    email: null,
    phone: null,
    linkedinUrl: null,
    companyName: null,
    companyDomain: null,
    title: null,
    remoteOwnerRef: "77",
    remoteUrl: `https://app.hubspot.com/contacts/1/record/0-1/${over.remoteId}`,
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  await db.delete(leads).where(eq(leads.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

run(async () => {
  console.log("the rules, pure");
  {
    const tied = planCrmLeads([rec({ id: "r1", title: "CTO" })], [lead({ id: "L1", crmRecordId: "r1" })]);
    check("1. a tied record fills its lead", tied.fills.length === 1 && tied.fills[0].leadId === "L1" && tied.fills[0].title === "CTO" && tied.inserts.length === 0);

    const adopt = planCrmLeads(
      [rec({ id: "r2", email: "Ada@Example.test" })],
      [lead({ id: "L2", email: "ada@example.test", emailNormalized: "ada@example.test" })]
    );
    check("2. an untied lead with the same email adopts the record", adopt.fills[0]?.leadId === "L2" && adopt.fills[0]?.crmRecordId === "r2" && adopt.inserts.length === 0);

    const tiedElsewhere = planCrmLeads(
      [rec({ id: "r3", email: "ada@example.test" })],
      [lead({ id: "L3", crmRecordId: "someone-else", email: "ada@example.test", emailNormalized: "ada@example.test" })]
    );
    check("2b. a lead tied to another record is never adopted", tiedElsewhere.fills.length === 0 && tiedElsewhere.inserts.length === 1);

    const fresh = planCrmLeads([rec({ id: "r4", displayName: "New Person", email: "new@example.test", lifecycle: "other" })], []);
    check("3. a lead/other record with no match becomes a new lead", fresh.inserts.length === 1 && fresh.inserts[0].crmRecordId === "r4" && fresh.inserts[0].emailNormalized === "new@example.test");
    const customerOnly = planCrmLeads([rec({ id: "r5", lifecycle: "customer", contactId: "c5" })], []);
    check("3b. a customer creates no lead", customerOnly.inserts.length === 0 && customerOnly.fills.length === 0 && customerOnly.conversions.length === 0);

    const blanks = planCrmLeads(
      [rec({ id: "r6", email: "second@example.test", title: "VP", companyName: "Acme" })],
      [lead({ id: "L6", crmRecordId: "r6", email: "first@example.test", emailNormalized: "first@example.test", title: null })]
    );
    const f6 = blanks.fills[0];
    check("4. an existing email is never overwritten", f6?.email === undefined && f6?.emailNormalized === undefined);
    check("4b. blanks fill, pairs together", f6?.title === "VP" && f6?.companyName === "Acme" && f6?.companyNormalized === "acme");
    const nothingNew = planCrmLeads([rec({ id: "r7" })], [lead({ id: "L7", crmRecordId: "r7" })]);
    check("4c. a tied lead with nothing to fill is left alone", nothingNew.fills.length === 0);
    const dismissed = planCrmLeads([rec({ id: "r8", title: "CEO" })], [lead({ id: "L8", crmRecordId: "r8", status: "dismissed" })]);
    check("4d. a dismissed lead is filled but never reopened (plans carry no status)", dismissed.fills.length === 1 && !("status" in dismissed.fills[0]));

    const becameCustomer = planCrmLeads([rec({ id: "r9", lifecycle: "customer", contactId: "c9" })], [lead({ id: "L9", crmRecordId: "r9", status: "intro_requested" })]);
    check("5. a customer converts its lead", becameCustomer.conversions[0]?.leadId === "L9" && becameCustomer.conversions[0]?.contactId === "c9");
    const alreadyDone = planCrmLeads([rec({ id: "r10", lifecycle: "customer", contactId: "c10" })], [lead({ id: "L10", crmRecordId: "r10", status: "dismissed" })]);
    check("5b. a dismissed lead is not converted", alreadyDone.conversions.length === 0);
    const capped = planCrmLeads(
      [rec({ id: "r11", lifecycle: "customer", contactId: null, email: "cap@example.test" })],
      [lead({ id: "L11", email: "cap@example.test", emailNormalized: "cap@example.test" })]
    );
    check("5c. a cap-refused customer only attaches its record", capped.conversions.length === 0 && capped.fills[0]?.crmRecordId === "r11");

    const twice = planCrmLeads(
      [rec({ id: "r12", email: "dup@example.test" }), rec({ id: "r13", email: "dup@example.test" })],
      [lead({ id: "L12", email: "dup@example.test", emailNormalized: "dup@example.test" })]
    );
    check("6. one lead is claimed by one record per page", twice.fills.filter((f) => f.leadId === "L12").length === 1 && twice.inserts.length === 1);
  }

  console.log("\npersistCrmPage, end to end");
  await reset();
  const db = await getDb();
  // An existing contact the CRM customer should MATCH, not duplicate.
  await db.insert(contacts).values({ userId: USER, fullName: "Dana Whitfield", email: "dana@acme.test" });
  // A manual target the CRM lead should MERGE with.
  const { lead: manual } = await saveLead(USER, { source: "manual", displayName: "Grace Park", email: "grace@beta.test" });

  const ctx = await openIngestContext(USER, { source: "hubspot", createsContacts: true, reportResolutions: true });
  const page1 = await persistCrmPage(ctx, "hubspot", [
    person({ remoteId: "1", displayName: "Dana Whitfield", email: "dana@acme.test", lifecycle: "customer", stage: "customer" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "Grace@Beta.test", title: "CTO" }),
    person({ remoteId: "3", displayName: "Ivy Chen", email: "ivy@gamma.test", lifecycle: "other", stage: null }),
    person({ remoteId: "4", displayName: "Marco Rossi", email: "marco@delta.test", lifecycle: "customer", stage: "customer" }),
  ]);
  check("four records stored", page1.records === 4, JSON.stringify(page1));
  check("two customers: one matched, one created", page1.customers === 2 && page1.contactsMatched === 1 && page1.contactsCreated === 1, JSON.stringify(page1));
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  const byRemote = new Map(records.map((r) => [r.remoteId, r]));
  const [danaContact] = await db.select().from(contacts).where(eq(contacts.email, "dana@acme.test"));
  check("the existing contact is linked, not duplicated", byRemote.get("1")?.contactId === danaContact?.id);
  check("the new customer is linked to its new contact", byRemote.get("4")?.contactId !== null);
  check("a work contact's source says where it came from", (await db.select().from(contacts).where(eq(contacts.email, "marco@delta.test")))[0]?.source === "hubspot");
  const allLeads = await db.select().from(leads).where(eq(leads.userId, USER));
  const grace = allLeads.find((l) => l.id === manual.id);
  check("the CRM lead merged into the manual target", allLeads.filter((l) => l.emailNormalized === "grace@beta.test").length === 1 && grace?.crmRecordId === byRemote.get("2")?.id);
  check("…keeping it a manual lead, now with the CRM's title", grace?.source === "manual" && grace?.title === "CTO");
  const ivy = allLeads.find((l) => l.emailNormalized === "ivy@gamma.test");
  check("a no-stage record became a crm lead", ivy?.source === "crm" && ivy?.crmRecordId === byRemote.get("3")?.id && ivy?.status === "open");
  check("customers created no leads", allLeads.length === 2, String(allLeads.length));

  console.log("\na re-sync, and a lead that became a customer");
  const page2 = await persistCrmPage(ctx, "hubspot", [
    person({ remoteId: "3", displayName: "Ivy Chen", email: "ivy@gamma.test", lifecycle: "customer", stage: "customer" }),
  ]);
  check("the converted customer was created as a contact", page2.contactsCreated === 1, JSON.stringify(page2));
  const [ivyAfter] = await db.select().from(leads).where(eq(leads.id, ivy!.id));
  const [ivyRecord] = await db.select().from(crmRecords).where(eq(crmRecords.remoteId, "3"));
  check("its lead converted, pointing at the contact", ivyAfter?.status === "converted" && ivyAfter?.contactId === ivyRecord?.contactId && ivyAfter?.contactId !== null);

  console.log("\nthe cap");
  const capped = await openIngestContext(USER, { source: "hubspot", createsContacts: true, reportResolutions: true });
  capped.headroom = 0;
  const page3 = await persistCrmPage(capped, "hubspot", [person({ remoteId: "5", displayName: "Over Cap", email: "over@cap.test", lifecycle: "customer", stage: "customer" })]);
  const [overCap] = await db.select().from(crmRecords).where(eq(crmRecords.remoteId, "5"));
  check("a refused customer is counted and marked", page3.blocked === 1 && overCap?.linkBlockedAt !== null && overCap?.contactId === null);

  console.log("\nthe guard");
  const wrong = await openIngestContext(USER, { source: "hubspot", createsContacts: true });
  let threw = false;
  try {
    await persistCrmPage(wrong, "hubspot", []);
  } catch {
    threw = true;
  }
  check("a context without resolutions is refused", threw);

  console.log("\nthe pipeline shows where a CRM lead lives");
  const pipeline = await loadPipeline(USER);
  const graceRow = pipeline.rows.find((r: { lead: Lead }) => r.lead.id === manual.id);
  check("a CRM-tied lead carries its record link", graceRow?.crm?.label === "HubSpot" && graceRow.crm.url === "https://app.hubspot.com/contacts/1/record/0-1/2", JSON.stringify(graceRow?.crm));
  const { lead: plain } = await saveLead(USER, { source: "manual", displayName: "No Crm" });
  check("a lead with no CRM record has none", (await loadPipeline(USER)).rows.find((r) => r.lead.id === plain.id)?.crm === null);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM lead checks passed.");
});
