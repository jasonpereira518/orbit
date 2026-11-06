/**
 * Mark an account `internal` or `tester` (or back to a real customer), audited.
 *
 * `user_settings.account_kind` is what takes an account out of every product and revenue
 * aggregate (`internalAccountSql` in `analytics-internal.ts`): the operator's own use, a
 * teammate, the showcase account, someone invited to try Orbit rather than use it. A wrong
 * value silently moves every dashboard number, so the change needs a reason and leaves an
 * `admin_audit_log` row, like the comp and suspend controls beside it.
 *
 * The body lives here, not in `src/actions/admin.ts`, so a script can drive it: an action calls
 * `requireAdminUserId()`, which needs a Clerk request context no script has. The action is a
 * thin wrapper that adds the gate and the cache revalidation.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import { requireReason } from "@/lib/admin-operations";

export type AccountKind = "internal" | "tester";
export const ACCOUNT_KINDS: readonly AccountKind[] = ["internal", "tester"];

export function isAccountKind(value: unknown): value is AccountKind {
  return value === "internal" || value === "tester";
}

/** The account's kind: `null` for a customer, `undefined` when there is no such account. */
export async function getAccountKind(userId: string): Promise<AccountKind | null | undefined> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { accountKind: true },
  });
  return row ? (row.accountKind ?? null) : undefined;
}

export type SetAccountKindResult = { changed: boolean; from: AccountKind | null; to: AccountKind | null };

export async function setAccountKindAsAdmin(
  adminUserId: string,
  input: { targetUserId: string; kind: AccountKind | null; reason: string }
): Promise<SetAccountKindResult> {
  const reason = requireReason(input.reason);
  if (input.kind !== null && !isAccountKind(input.kind)) {
    throw new Error("An account is internal, a tester, or neither.");
  }
  const before = await getAccountKind(input.targetUserId);
  if (before === undefined) throw new Error("No such account.");
  // Nothing to change means nothing to log: an audit row for a no-op would claim an act that
  // did not happen.
  if (before === input.kind) return { changed: false, from: before, to: input.kind };

  const db = await getDb();
  await db
    .update(userSettings)
    .set({ accountKind: input.kind, updatedAt: new Date() })
    .where(eq(userSettings.userId, input.targetUserId));

  await recordAdminAction({
    adminUserId,
    action: "account_kind.set",
    targetUserId: input.targetUserId,
    resourceType: "user_settings",
    resourceId: input.targetUserId,
    detail: { from: before, to: input.kind },
    reason,
  });
  return { changed: true, from: before, to: input.kind };
}
