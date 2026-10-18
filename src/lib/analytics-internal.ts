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
 * SQL: whether `column` is an account that no product or revenue number should include —
 * one of `internalUserIds()` (admins, the showcase account), OR an account the operator
 * marked `internal` or `tester` in `user_settings.account_kind`. Never null, so
 * `NOT (...)` keeps anonymous rows. `false` outright in demo mode.
 *
 * ONE PREDICATE FOR EVERY AGGREGATE. Before `account_kind` existed only the traffic pages and
 * the Conversion funnel applied this, so the Growth page's DAU/WAU, retention, feature
 * adoption, and every money and YC figure counted the operator's own use and test purchases.
 * Anything that aggregates across accounts should wrap its user-id column in this.
 *
 * Comped accounts are deliberately NOT here: a comped user is a real person using the
 * product, so product metrics keep them; revenue metrics exclude them separately
 * (`comped_plan IS NULL`).
 */
export function internalAccountSql(column: SQL): SQL {
  if (isDemoMode()) return sql`false`;
  const ids = internalUserIds();
  const byKind = sql`EXISTS (
    SELECT 1 FROM user_settings ak
    WHERE ak.user_id = ${column} AND ak.account_kind IN ('internal', 'tester')
  )`;
  if (ids.length === 0) return sql`(${byKind})`;
  return sql`(coalesce(${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}), false) OR ${byKind})`;
}

/** The name new callers should use; identical to {@link internalAccountSql}. */
export const excludedAccountSql = internalAccountSql;

/** JS twin for rows already loaded (the admin roster): env ids or a marked account kind. */
export function isExcludedAccount(row: {
  userId: string;
  accountKind?: "internal" | "tester" | null;
}): boolean {
  if (isDemoMode()) return false;
  return row.accountKind === "internal" || row.accountKind === "tester" || internalUserIds().includes(row.userId);
}
