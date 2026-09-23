/**
 * `crm_records`: the upsert every CRM sync page goes through, the contact links, and the
 * counts the CRM card shows. The properties that matter are the silent ones — a re-sync must
 * never unlink a work contact, and one user's link call must never touch another's rows.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords } from "../src/db/schema";
import type { CrmPerson } from "../src/lib/crm/types";
import {
  crmCounts,
  crmRecordLinks,
  deleteCrmRecordsForConnector,
  linkCrmRecords,
  markCrmLinksBlocked,
  upsertCrmRecords,
} from "../src/lib/crm/records";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-records";
const OTHER = "smoke-crm-records-other";

function person(over: Partial<CrmPerson> & Pick<CrmPerson, "remoteId">): CrmPerson {
  return {
    remoteType: "contact",
    lifecycle: "lead",
    stage: "lead",
    displayName: "Someone",
    email: null,
    phone: null,
    linkedinUrl: null,
    companyName: null,
    companyDomain: null,
    title: null,
    remoteOwnerRef: "77",
    remoteUrl: null,
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
}

run(async () => {
  await reset();
  const db = await getDb();

  console.log("the first upsert");
  const first = await upsertCrmRecords(USER, "hubspot", [
    person({ remoteId: "1", lifecycle: "customer", stage: "customer", displayName: "Dana Whitfield", email: "Dana@Acme.test", companyName: "  Acme   Corp ", remoteUrl: "https://app.hubspot.com/contacts/1/record/0-1/1" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "grace@beta.test" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "grace@beta.test", title: "CTO" }),
  ]);
  check("in-batch duplicates collapse", first.length === 2, String(first.length));
  const dana = first.find((r) => r.remoteId === "1");
  const grace = first.find((r) => r.remoteId === "2");
  check("the email identity is normalised", dana?.emailNormalized === "dana@acme.test", String(dana?.emailNormalized));
  check("the raw email is kept", dana?.email === "Dana@Acme.test");
  check("the company is tidied and keyed", dana?.companyName === "Acme Corp" && dana?.companyNormalized === "acme corp");
  check("the last duplicate wins", grace?.title === "CTO");

  console.log("\nlinking");
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Dana Whitfield" }).returning();
  await markCrmLinksBlocked(USER, [dana!.id]);
  const [blocked] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("a refused create is marked", blocked?.linkBlockedAt !== null);
  await linkCrmRecords(USER, [{ recordId: dana!.id, contactId: contact.id }]);
  const [linked] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("the link is stored", linked?.contactId === contact.id);
  check("and clears the refusal", linked?.linkBlockedAt === null);

  console.log("\na re-sync");
  const second = await upsertCrmRecords(USER, "hubspot", [
    person({ remoteId: "1", lifecycle: "customer", stage: "evangelist", displayName: "Dana Whitfield", title: "CRO" }),
    person({ remoteId: "2", lifecycle: "customer", stage: "customer", displayName: "Grace Park" }),
  ]);
  const dana2 = second.find((r) => r.remoteId === "1");
  const grace2 = second.find((r) => r.remoteId === "2");
  check("the same row, not a new one", dana2?.id === dana?.id && grace2?.id === grace?.id);
  check("never unlinks a work contact", dana2?.contactId === contact.id);
  check("CRM fields follow the CRM", dana2?.stage === "evangelist" && dana2?.title === "CRO");
  check("lead → customer flips the lifecycle in place", grace2?.lifecycle === "customer");
  check("created_at is kept", dana2?.createdAt.getTime() === dana?.createdAt.getTime());

  console.log("\nscoping");
  const [theirs] = await upsertCrmRecords(OTHER, "hubspot", [person({ remoteId: "1", displayName: "Their Dana" })]);
  check("the same remote id under another user is another row", theirs.id !== dana?.id);
  await linkCrmRecords(USER, [{ recordId: theirs.id, contactId: contact.id }]);
  const [untouched] = await db.select().from(crmRecords).where(eq(crmRecords.id, theirs.id));
  check("a link call never touches another user's row", untouched?.contactId === null);

  console.log("\ncounts and links");
  const counts = await crmCounts(USER, "hubspot");
  check("one work contact, nothing blocked", counts.workContacts === 1 && counts.blocked === 0, JSON.stringify(counts));
  check("no pipeline records once both are customers", counts.pipeline === 0, JSON.stringify(counts));
  const links = await crmRecordLinks(USER, [dana!.id, theirs.id]);
  check("links carry the connector and url", links.get(dana!.id)?.connectorId === "hubspot" && links.get(dana!.id)?.remoteUrl !== undefined);
  check("links never include another user's record", !links.has(theirs.id));

  console.log("\ndeleting a contact unlinks, it does not delete");
  await db.delete(contacts).where(eq(contacts.id, contact.id));
  const [afterDelete] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("the record stays, unlinked", afterDelete !== undefined && afterDelete.contactId === null);

  console.log("\ndisconnect");
  await upsertCrmRecords(USER, "salesforce", [person({ remoteId: "sf-1" })]);
  const removed = await deleteCrmRecordsForConnector(USER, "hubspot");
  check("removes that connector's rows", removed === 2, String(removed));
  const left = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("and only that connector's", left.length === 1 && left[0]?.connectorId === "salesforce");
  check("another user's rows are untouched", (await db.select().from(crmRecords).where(eq(crmRecords.userId, OTHER))).length === 1);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM record checks passed.");
});
