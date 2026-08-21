"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminAuditLog, contacts, userSettings } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import { resolvePlan } from "@/lib/entitlements";
import { setCompedPlan } from "@/lib/user-settings";

/**
 * Every export here re-asserts `requireAdminUserId()`.
 *
 * The layout gate is not sufficient: layouts do not re-run for Server Action POSTs, and
 * actions are reachable by direct POST rather than only through Orbit's own UI. This is
 * the same lesson `src/lib/plan-guards.ts` documents for the paywall — the real boundary
 * is the function, not the hidden nav item.
 */

async function recordAdminAction(input: {
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

export type CompResult = {
  ok: true;
  plan: "free" | "orbit" | "lifetime";
};

/**
 * Grant or revoke a comped plan.
 *
 * The audit write is deliberately awaited rather than deferred to `after()`: an unlogged
 * privileged mutation is worse than a slow one. `comped_plan` outranks every real billing
 * signal in `resolvePlan`, has no expiry, and no webhook will ever correct it — and
 * `updated_at` is bumped by a dozen unrelated writers, so this table is the only record
 * that the change happened.
 */
export async function setCompAction(input: {
  targetUserId: string;
  plan: "orbit" | "lifetime" | null;
  reason: string;
}): Promise<CompResult> {
  const adminUserId = await requireAdminUserId();

  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required.");

  const db = await getDb();
  const before = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, input.targetUserId),
    columns: { compedPlan: true },
  });
  if (!before) throw new Error("No such account.");

  const row = await setCompedPlan(input.targetUserId, input.plan, {
    note: reason,
    adminUserId,
  });

  await recordAdminAction({
    adminUserId,
    action: input.plan ? "comp.grant" : "comp.revoke",
    targetUserId: input.targetUserId,
    detail: { from: before.compedPlan ?? null, to: input.plan },
    reason,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${input.targetUserId}`);
  revalidatePath("/admin/billing");

  // Resolved from the returned row, NOT from getEntitlements(): that helper is a React
  // cache() memo and may still hold the pre-write value within this same request.
  return { ok: true, plan: resolvePlan(row).plan };
}

export type RevealedContact = {
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  createdAt: Date;
};

/**
 * The deliberate escape hatch: reveal ONE contact record, for ONE page view.
 *
 * There is no "reveal all" toggle and no session-wide unmasking, by design. Every call
 * writes an audit row with a typed reason, which is what makes the privacy promise in the
 * inspector something Jason can state truthfully rather than aspirationally.
 */
export async function revealContactAction(input: {
  targetUserId: string;
  contactId: string;
  reason: string;
}): Promise<RevealedContact> {
  const adminUserId = await requireAdminUserId();

  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw new Error("Describe why this record needs to be revealed.");
  }

  const db = await getDb();
  const row = await db.query.contacts.findFirst({
    where: eq(contacts.id, input.contactId),
    columns: {
      userId: true,
      fullName: true,
      email: true,
      phone: true,
      company: true,
      title: true,
      notes: true,
      createdAt: true,
    },
  });

  if (!row || row.userId !== input.targetUserId) {
    throw new Error("No such record.");
  }

  await recordAdminAction({
    adminUserId,
    action: "record.reveal",
    targetUserId: input.targetUserId,
    resourceType: "contact",
    resourceId: input.contactId,
    reason,
  });

  revalidatePath(`/admin/users/${input.targetUserId}`);

  return {
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    company: row.company,
    title: row.title,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

/** Audit history for one account, shown on their inspector page. */
export async function getAuditTrail(targetUserId: string) {
  await requireAdminUserId();

  const db = await getDb();
  return db.query.adminAuditLog.findMany({
    where: eq(adminAuditLog.targetUserId, targetUserId),
    orderBy: [desc(adminAuditLog.createdAt)],
    limit: 25,
  });
}
