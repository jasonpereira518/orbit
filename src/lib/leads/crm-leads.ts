/**
 * CRM records into the Leads pipeline, by the rules in `src/lib/crm/crm-leads-plan.ts`. At
 * most four statements a page — one read, one insert, one bulk fill, one bulk convert — and
 * every one scoped to the owner's `user_id`, including the VALUES-list UPDATEs.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { leads } from "@/db/schema";
import { planCrmLeads, type CrmLeadFill, type CrmLeadRecord } from "@/lib/crm/crm-leads-plan";
import { normalizeLeadInput } from "./lead-identity";

const unique = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

export async function syncCrmLeads(
  userId: string,
  records: CrmLeadRecord[]
): Promise<{ created: number; updated: number; converted: number }> {
  if (records.length === 0) return { created: 0, updated: 0, converted: 0 };
  const normalized = records.map((r) =>
    normalizeLeadInput({ displayName: r.displayName, email: r.email, linkedinUrl: r.linkedinUrl, phone: r.phone })
  );
  const identity: SQL[] = [];
  const emails = unique(normalized.map((n) => n.emailNormalized));
  const slugs = unique(normalized.map((n) => n.linkedinSlug));
  const phones = unique(normalized.map((n) => n.phoneE164));
  if (emails.length) identity.push(inArray(leads.emailNormalized, emails));
  if (slugs.length) identity.push(inArray(leads.linkedinSlug, slugs));
  if (phones.length) identity.push(inArray(leads.phoneE164, phones));

  const db = await getDb();
  const existing = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.userId, userId),
        or(
          inArray(leads.crmRecordId, records.map((r) => r.id)),
          identity.length ? and(isNull(leads.crmRecordId), or(...identity)) : undefined
        )
      )
    );

  const plan = planCrmLeads(records, existing);
  let created = 0;
  if (plan.inserts.length) {
    const rows = await db
      .insert(leads)
      .values(plan.inserts.map((i) => ({ userId, source: "crm" as const, ...i })))
      .returning();
    created = rows.length;
  }
  if (plan.fills.length) await applyFills(userId, plan.fills);
  if (plan.conversions.length) {
    const rows = sql.join(
      plan.conversions.map((c) => sql`(${c.leadId}::uuid, ${c.crmRecordId}::uuid, ${c.contactId}::uuid)`),
      sql`, `
    );
    await db.execute(sql`
      UPDATE leads AS l
         SET crm_record_id = v.crm_record_id, contact_id = v.contact_id, status = 'converted', updated_at = now()
        FROM (VALUES ${rows}) AS v(id, crm_record_id, contact_id)
       WHERE l.id = v.id AND l.user_id = ${userId} AND l.status IN ('open', 'intro_requested')
    `);
  }
  return { created, updated: plan.fills.length, converted: plan.conversions.length };
}

/** A NULL in the VALUES row means "nothing to fill"; the CASEs gate each pair on its raw column. */
async function applyFills(userId: string, fills: CrmLeadFill[]): Promise<void> {
  const db = await getDb();
  const rows = sql.join(
    fills.map(
      (f) => sql`(${f.leadId}::uuid, ${f.crmRecordId}::uuid, ${f.email ?? null}::text, ${f.emailNormalized ?? null}::text,
        ${f.linkedinUrl ?? null}::text, ${f.linkedinSlug ?? null}::text, ${f.phone ?? null}::text, ${f.phoneE164 ?? null}::text,
        ${f.companyName ?? null}::text, ${f.companyNormalized ?? null}::text, ${f.title ?? null}::text)`
    ),
    sql`, `
  );
  await db.execute(sql`
    UPDATE leads AS l
       SET crm_record_id = v.crm_record_id,
           email = CASE WHEN l.email IS NULL THEN v.email ELSE l.email END,
           email_normalized = CASE WHEN l.email IS NULL THEN v.email_normalized ELSE l.email_normalized END,
           linkedin_url = CASE WHEN l.linkedin_url IS NULL THEN v.linkedin_url ELSE l.linkedin_url END,
           linkedin_slug = CASE WHEN l.linkedin_url IS NULL THEN v.linkedin_slug ELSE l.linkedin_slug END,
           phone = CASE WHEN l.phone IS NULL THEN v.phone ELSE l.phone END,
           phone_e164 = CASE WHEN l.phone IS NULL THEN v.phone_e164 ELSE l.phone_e164 END,
           company_name = CASE WHEN l.company_name IS NULL THEN v.company_name ELSE l.company_name END,
           company_normalized = CASE WHEN l.company_name IS NULL THEN v.company_normalized ELSE l.company_normalized END,
           title = COALESCE(l.title, v.title),
           updated_at = now()
      FROM (VALUES ${rows}) AS v(id, crm_record_id, email, email_normalized, linkedin_url, linkedin_slug, phone, phone_e164, company_name, company_normalized, title)
     WHERE l.id = v.id AND l.user_id = ${userId}
  `);
}
