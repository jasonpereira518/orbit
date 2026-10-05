import { sql, type SQL } from "drizzle-orm";
import { adminUserIds } from "@/lib/admin";
import { isDemoMode } from "@/lib/auth";
import { getShowcaseAccountId } from "@/lib/demo-account";

/**
 * Orbit's own traffic, which no traffic number should include.
 *
 * With a user base this small, the operator's daily use and every live demo run from the
 * showcase account were a real share of signed-in views, "most active accounts" and the
 * funnel's signups. Two halves, because each covers what the other cannot:
 *
 *  - AT INGEST, `/api/track` sets `page_views.is_internal` for these accounts and for any
 *    browser an admin opted out from `/admin/analytics`. The opt-out is the only thing that
 *    reaches the operator's SIGNED-OUT visits to the landing page — there is no identity to
 *    filter those by later.
 *  - AT READ, `admin-analytics.ts` also excludes these user ids, which covers every row
 *    written before the column existed and any account added to `ADMIN_USER_IDS` later.
 *
 * EMPTY IN DEMO MODE. Localhost treats everyone as an admin (`isAdminUser`) and every account
 * as a demo account, so honouring either there would hide every local row and make the page
 * impossible to develop.
 */
export function internalUserIds(): string[] {
  if (isDemoMode()) return [];
  const ids = new Set(adminUserIds());
  const showcase = getShowcaseAccountId();
  if (showcase) ids.add(showcase);
  ids.delete("demo-user");
  return [...ids];
}

export function isInternalUser(userId: string | null | undefined): boolean {
  return Boolean(userId) && internalUserIds().includes(userId!);
}


/**
 * SQL: whether `column` holds one of `internalUserIds()`. Never null, so `NOT (...)` keeps
 * anonymous rows. `false` outright when there are none (demo mode, no ADMIN_USER_IDS).
 */
export function internalAccountSql(column: SQL): SQL {
  const ids = internalUserIds();
  if (ids.length === 0) return sql`false`;
  return sql`coalesce(${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}), false)`;
}
