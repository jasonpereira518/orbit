/**
 * `crm_records`: the ledger every CRM sync writes, and the map between an Orbit contact and
 * its CRM record. One statement per write however long the page — a sync runs on `neon-http`,
 * where every statement is its own HTTP round trip.
 *
 * Every statement carries the owner's `user_id` in its WHERE, including the bulk UPDATE whose
 * VALUES list names ids: an id from another account must match nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { crmRecords, type CrmRecord } from "@/db/schema";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { CrmPerson } from "@/lib/crm/types";
import { identityKeysFor } from "@/lib/duplicates";

/** A provider field is data, not a document: past this, it is cut. */
const FIELD_MAX = 500;

function clip(value: string | null): string | null {
  return value === null ? null : value.slice(0, FIELD_MAX);
}

export async function upsertCrmRecords(
  userId: string,
  connectorId: string,
  people: CrmPerson[],
  now: Date = new Date()
): Promise<CrmRecord[]> {
  // ON CONFLICT DO UPDATE cannot touch one row twice in a statement, and a provider page can
  // list a record twice: collapse first, last one wins.
  const byKey = new Map<string, CrmPerson>();
  for (const p of people) byKey.set(`${p.remoteType}:${p.remoteId}`, p);
  if (byKey.size === 0) return [];

  const values = [...byKey.values()].map((p) => {
    const email = p.email?.trim() || null;
    const company = p.companyName ? displayCompanyName(p.companyName) || null : null;
    return {
      userId,
      connectorId,
      remoteType: p.remoteType,
      remoteId: p.remoteId,
      lifecycle: p.lifecycle,
      stage: clip(p.stage),
      displayName: clip(p.displayName) ?? "",
      email: clip(email),
      emailNormalized: identityKeysFor({ email }).find((k) => k.kind === "email")?.value ?? null,
      phone: clip(p.phone),
      linkedinUrl: clip(p.linkedinUrl),
      companyName: clip(company),
      companyNormalized: company ? normalizeCompanyName(company) || null : null,
      companyDomain: clip(p.companyDomain),
      title: clip(p.title),
      remoteOwnerRef: clip(p.remoteOwnerRef),
      remoteUrl: clip(p.remoteUrl),
      lastActivityAt: p.lastActivityAt,
      remoteCreatedAt: p.remoteCreatedAt,
      remoteUpdatedAt: p.remoteUpdatedAt,
      properties: p.properties,
      syncedAt: now,
      updatedAt: now,
    };
  });

  const db = await getDb();
  return db
    .insert(crmRecords)
    .values(values)
    .onConflictDoUpdate({
      target: [crmRecords.userId, crmRecords.connectorId, crmRecords.remoteType, crmRecords.remoteId],
      // Everything the CRM owns follows the CRM. `contact_id` and `link_blocked_at` are
      // Orbit's and are deliberately absent: a re-sync must never unlink a work contact.
      set: {
        lifecycle: sql`excluded.lifecycle`,
        stage: sql`excluded.stage`,
        displayName: sql`excluded.display_name`,
        email: sql`excluded.email`,
        emailNormalized: sql`excluded.email_normalized`,
        phone: sql`excluded.phone`,
        linkedinUrl: sql`excluded.linkedin_url`,
        companyName: sql`excluded.company_name`,
        companyNormalized: sql`excluded.company_normalized`,
        companyDomain: sql`excluded.company_domain`,
        title: sql`excluded.title`,
        remoteOwnerRef: sql`excluded.remote_owner_ref`,
        remoteUrl: sql`excluded.remote_url`,
        lastActivityAt: sql`excluded.last_activity_at`,
        remoteCreatedAt: sql`excluded.remote_created_at`,
        remoteUpdatedAt: sql`excluded.remote_updated_at`,
        properties: sql`excluded.properties`,
        syncedAt: sql`excluded.synced_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning();
}

export async function linkCrmRecords(
  userId: string,
  links: Array<{ recordId: string; contactId: string }>,
  now: Date = new Date()
): Promise<void> {
  if (links.length === 0) return;
  const db = await getDb();
  const rows = sql.join(
    links.map((l) => sql`(${l.recordId}::uuid, ${l.contactId}::uuid)`),
    sql`, `
  );
  await db.execute(sql`
    UPDATE crm_records AS cr
       SET contact_id = v.contact_id, link_blocked_at = NULL, updated_at = ${now}
      FROM (VALUES ${rows}) AS v(id, contact_id)
     WHERE cr.id = v.id AND cr.user_id = ${userId}
  `);
}

/** A customer the plan's contact cap refused to create. Cleared by the link that follows. */
export async function markCrmLinksBlocked(userId: string, recordIds: string[], now: Date = new Date()): Promise<void> {
  if (recordIds.length === 0) return;
  const db = await getDb();
  await db
    .update(crmRecords)
    .set({ linkBlockedAt: now, updatedAt: now })
    .where(and(eq(crmRecords.userId, userId), inArray(crmRecords.id, recordIds)));
}

export type CrmCounts = { workContacts: number; pipeline: number; blocked: number };

export async function crmCounts(userId: string, connectorId: string): Promise<CrmCounts> {
  const db = await getDb();
  const [row] = rowsOf<{ work: number; pipeline: number; blocked: number }>(
    await db.execute(sql`
      SELECT count(DISTINCT contact_id)::int AS work,
             count(*) FILTER (WHERE lifecycle <> 'customer')::int AS pipeline,
             count(*) FILTER (WHERE link_blocked_at IS NOT NULL AND contact_id IS NULL)::int AS blocked
        FROM crm_records
       WHERE user_id = ${userId} AND connector_id = ${connectorId}
    `)
  );
  return { workContacts: row?.work ?? 0, pipeline: row?.pipeline ?? 0, blocked: row?.blocked ?? 0 };
}

export async function crmRecordLinks(
  userId: string,
  recordIds: string[]
): Promise<Map<string, { connectorId: string; remoteUrl: string | null }>> {
  const out = new Map<string, { connectorId: string; remoteUrl: string | null }>();
  if (recordIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: crmRecords.id, connectorId: crmRecords.connectorId, remoteUrl: crmRecords.remoteUrl })
    .from(crmRecords)
    .where(and(eq(crmRecords.userId, userId), inArray(crmRecords.id, recordIds)));
  for (const r of rows) out.set(r.id, { connectorId: r.connectorId, remoteUrl: r.remoteUrl });
  return out;
}

/** Disconnect: the ledger goes; the contacts it created stay, and CRM leads keep their rows. */
export async function deleteCrmRecordsForConnector(userId: string, connectorId: string): Promise<number> {
  const db = await getDb();
  const removed = await db
    .delete(crmRecords)
    .where(and(eq(crmRecords.userId, userId), eq(crmRecords.connectorId, connectorId)))
    .returning();
  return removed.length;
}
