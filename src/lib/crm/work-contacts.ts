/**
 * "Work contacts": contacts a connected CRM synced — the ones with a `crm_records` row.
 *
 * A WHERE fragment for a query `FROM contacts`. The owner's id is bound as a parameter rather
 * than correlated to `contacts.user_id`, so the tenant predicate lives inside the subquery
 * whatever the planner does with it (the warm-path rules explain why that matters).
 */
import { sql, type SQL } from "drizzle-orm";

export function workContactsCondition(userId: string): SQL {
  return sql`exists (select 1 from crm_records cr where cr.contact_id = contacts.id and cr.user_id = ${userId})`;
}
