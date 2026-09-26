/**
 * Where a CRM page's people land in the Leads pipeline — pure, so the matching rules are a
 * table of cases (scripts/smoke-crm-leads.ts) rather than a database fixture.
 *
 *  1. A record already tied to a lead (`crm_record_id`) updates that lead.
 *  2. Otherwise an untied lead sharing an identifier (P3's dedupe keys) adopts the record: a
 *     manual or Apollo target that later appears in the CRM is one lead, not two.
 *  3. Otherwise a lead/other record becomes a new `source = 'crm'` lead. A customer creates no
 *     lead — customers become contacts.
 *  4. Updates only fill blanks, raw and normalised columns together, and never touch status: a
 *     lead the user dismissed stays dismissed however often the CRM edits the record.
 *  5. A customer with a contact converts the lead it matched when that lead is still open or
 *     intro-asked. A cap-refused customer (no contact yet) only attaches its record.
 *  6. Each existing lead is claimed by at most one record per page.
 */
import type { CrmLifecycle, Lead } from "@/db/schema";
import { normalizeLeadInput, type NormalizedLead } from "@/lib/leads/lead-identity";

export type CrmLeadRecord = {
  id: string;
  lifecycle: CrmLifecycle;
  contactId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  title: string | null;
};

export type ExistingLead = Pick<
  Lead,
  | "id"
  | "crmRecordId"
  | "status"
  | "contactId"
  | "email"
  | "emailNormalized"
  | "linkedinUrl"
  | "linkedinSlug"
  | "phone"
  | "phoneE164"
  | "companyName"
  | "companyNormalized"
  | "title"
>;

export type CrmLeadFill = { leadId: string; crmRecordId: string } & Partial<NormalizedLead>;

export type CrmLeadPlan = {
  inserts: Array<{ crmRecordId: string } & NormalizedLead>;
  fills: CrmLeadFill[];
  conversions: Array<{ leadId: string; crmRecordId: string; contactId: string }>;
};

type PairKey = keyof NormalizedLead & keyof ExistingLead;

/** P3's rule: fill a pair only when the RAW column is blank, and always fill both halves. */
function fillPair<Raw extends PairKey, Derived extends PairKey>(
  fill: Partial<NormalizedLead>,
  existing: ExistingLead,
  normalized: NormalizedLead,
  raw: Raw,
  derived: Derived
): boolean {
  if (existing[raw] == null && normalized[raw] != null) {
    fill[raw] = normalized[raw];
    fill[derived] = normalized[derived];
    return true;
  }
  return false;
}

export function planCrmLeads(records: CrmLeadRecord[], existing: ExistingLead[]): CrmLeadPlan {
  const plan: CrmLeadPlan = { inserts: [], fills: [], conversions: [] };
  const byRecord = new Map(existing.filter((l) => l.crmRecordId).map((l) => [l.crmRecordId as string, l]));
  const untied = existing.filter((l) => !l.crmRecordId);
  const claimed = new Set<string>();

  const matchUntied = (n: NormalizedLead) =>
    untied.find(
      (l) =>
        !claimed.has(l.id) &&
        ((n.emailNormalized !== null && l.emailNormalized === n.emailNormalized) ||
          (n.linkedinSlug !== null && l.linkedinSlug === n.linkedinSlug) ||
          (n.phoneE164 !== null && l.phoneE164 === n.phoneE164))
    );

  for (const record of records) {
    const normalized = normalizeLeadInput({
      displayName: record.displayName,
      email: record.email,
      linkedinUrl: record.linkedinUrl,
      phone: record.phone,
      companyName: record.companyName,
      title: record.title,
    });
    const tied = byRecord.get(record.id);
    const match = tied && !claimed.has(tied.id) ? tied : matchUntied(normalized);
    if (match) claimed.add(match.id);

    if (record.lifecycle === "customer") {
      if (!match) continue;
      const open = match.status === "open" || match.status === "intro_requested";
      if (record.contactId && open && !match.contactId) {
        plan.conversions.push({ leadId: match.id, crmRecordId: record.id, contactId: record.contactId });
      } else if (match.crmRecordId !== record.id) {
        plan.fills.push({ leadId: match.id, crmRecordId: record.id });
      }
      continue;
    }

    if (!match) {
      if (normalized.displayName) plan.inserts.push({ crmRecordId: record.id, ...normalized });
      continue;
    }
    const fill: CrmLeadFill = { leadId: match.id, crmRecordId: record.id };
    let changed = match.crmRecordId !== record.id;
    changed = fillPair(fill, match, normalized, "email", "emailNormalized") || changed;
    changed = fillPair(fill, match, normalized, "linkedinUrl", "linkedinSlug") || changed;
    changed = fillPair(fill, match, normalized, "phone", "phoneE164") || changed;
    changed = fillPair(fill, match, normalized, "companyName", "companyNormalized") || changed;
    if (match.title == null && normalized.title != null) {
      fill.title = normalized.title;
      changed = true;
    }
    if (changed) plan.fills.push(fill);
  }
  return plan;
}
