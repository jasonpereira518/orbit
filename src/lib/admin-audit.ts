import { getDb } from "@/db";
import { adminAuditLog } from "@/db/schema";

/**
 * The audit-log write every privileged mutation makes, on its own.
 *
 * Split out of `admin-operations.ts` (which re-exports it) because that module reaches
 * user-data, the import engine, Blob and Clerk's backend client, and `surface-visibility.ts`
 * — imported by every app page and the app-pulse poll — needs only this one insert. Importing
 * it from there put ~150 admin-only modules on every page's cold start.
 */

/** Every privileged mutation writes one of these, awaited, before or with the mutation. */
export async function recordAdminAction(input: {
  adminUserId: string;
  action: string;
  targetUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
  reason?: string | null;
}) {
  const db = await getDb();
  await db.insert(adminAuditLog).values({
    adminUserId: input.adminUserId,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    detail: input.detail ?? {},
    reason: input.reason?.trim() || null,
  });
}
