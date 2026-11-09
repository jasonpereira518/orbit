/**
 * One page of CRM people into Orbit — the write path every CRM connector shares:
 *
 *   1. upsert the page into `crm_records` (one statement);
 *   2. customers not yet linked go through `ingestPeople` — matched to an existing contact or
 *      created (the plan's cap applies) — and are linked; a refused one is marked blocked;
 *   3. everyone goes through `syncCrmLeads`: leads/others join the pipeline, and a customer
 *      converts the lead it used to be.
 *
 * A customer already linked to a live contact is not re-ingested (Ruling 6): its record row
 * still updates, but re-matching could create a duplicate when the person's email changed in
 * Orbit since.
 */
import type { CrmRecord } from "@/db/schema";
import type { CrmLeadRecord } from "@/lib/crm/crm-leads-plan";
import { linkCrmRecords, markCrmLinksBlocked, upsertCrmRecords } from "@/lib/crm/records";
import type { CrmPerson } from "@/lib/crm/types";
import type { IngestContext } from "@/lib/ingest/events";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { syncCrmLeads } from "@/lib/leads/crm-leads";

export type CrmPageStats = {
  records: number;
  customers: number;
  contactsCreated: number;
  contactsMatched: number;
  blocked: number;
  leadsCreated: number;
  leadsUpdated: number;
  leadsConverted: number;
};

function toPerson(record: CrmRecord): PersonRecord {
  return {
    fullName: record.displayName,
    email: record.email,
    phone: record.phone,
    linkedinUrl: record.linkedinUrl,
    company: record.companyName,
    title: record.title,
  };
}

export async function persistCrmPage(
  ctx: IngestContext,
  connectorId: string,
  people: CrmPerson[],
  now: Date = new Date()
): Promise<CrmPageStats> {
  if (!ctx.options.reportResolutions || !ctx.options.createsContacts) {
    throw new Error("persistCrmPage needs an ingest context opened with createsContacts and reportResolutions");
  }
  const rows = await upsertCrmRecords(ctx.userId, connectorId, people, now);
  const customers = rows.filter((r) => r.lifecycle === "customer");
  const unlinked = customers.filter((r) => !r.contactId);

  const stats: CrmPageStats = {
    records: rows.length,
    customers: customers.length,
    contactsCreated: 0,
    contactsMatched: 0,
    blocked: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    leadsConverted: 0,
  };

  const linked = new Map<string, string>();
  if (unlinked.length) {
    const result = await ingestPeople(ctx, unlinked.map(toPerson));
    stats.contactsCreated = result.created;
    stats.contactsMatched = result.matched;
    const byIndex = new Map((result.resolutions ?? []).map((r) => [r.index, r.contactId]));
    const blocked: string[] = [];
    unlinked.forEach((record, i) => {
      const contactId = byIndex.get(i);
      if (contactId) linked.set(record.id, contactId);
      else blocked.push(record.id);
    });
    await linkCrmRecords(ctx.userId, [...linked].map(([recordId, contactId]) => ({ recordId, contactId })), now);
    await markCrmLinksBlocked(ctx.userId, blocked, now);
    stats.blocked = blocked.length;
  }

  const leadRecords: CrmLeadRecord[] = rows.map((r) => ({
    id: r.id,
    lifecycle: r.lifecycle,
    contactId: r.contactId ?? linked.get(r.id) ?? null,
    displayName: r.displayName,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedinUrl,
    companyName: r.companyName,
    title: r.title,
  }));
  const leadStats = await syncCrmLeads(ctx.userId, leadRecords);
  stats.leadsCreated = leadStats.created;
  stats.leadsUpdated = leadStats.updated;
  stats.leadsConverted = leadStats.converted;
  return stats;
}
