"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { adminAuditLog, contacts, userSettings } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import * as ops from "@/lib/admin-operations";
import { recordAdminAction } from "@/lib/admin-operations";
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

/* ======================================================================================
 * Operator actions
 *
 * Thin by design. Each one resolves the operator, delegates to `src/lib/admin-operations.ts`
 * and revalidates — the same split every other domain in this repo uses, and the reason the
 * guards inside those operations are reachable from `scripts/smoke-admin-actions.ts` at all.
 *
 * `requireAdminUserId()` is the first statement in every one of them. That is not
 * belt-and-braces on top of the layout gate: layouts do not re-run for Server Action POSTs,
 * and these are reachable by direct POST rather than only through Orbit's own UI.
 * ================================================================================== */

/** Paths that show account state. Any operator write invalidates all of them. */
function revalidateAdmin(targetUserId?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/users");
  revalidatePath("/admin/health");
  revalidatePath("/admin/billing");
  if (targetUserId) revalidatePath(`/admin/users/${targetUserId}`);
}

export type RevealGrantResult = { ok: true; grantId: string; expiresAt: string };

/**
 * Unmask one account's contact and interaction content for a short window.
 *
 * `revealContactAction` above remains the one-record path. This is the "the import mangled
 * rows 300–400" tool, not a replacement for it.
 */
export async function grantRevealAction(input: {
  targetUserId: string;
  reason: string;
}): Promise<RevealGrantResult> {
  const adminUserId = await requireAdminUserId();
  const grant = await ops.grantReveal(adminUserId, input);
  revalidatePath(`/admin/users/${input.targetUserId}`);
  return {
    ok: true,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt.toISOString(),
  };
}

/** Re-mask now, without waiting for the grant to age out. */
export async function revokeRevealAction(input: {
  targetUserId: string;
}): Promise<{ ok: true; revoked: number }> {
  const adminUserId = await requireAdminUserId();
  const revoked = await ops.revokeReveal(adminUserId, input);
  revalidatePath(`/admin/users/${input.targetUserId}`);
  return { ok: true, revoked };
}

export async function retryImportAction(input: {
  targetUserId: string;
  importId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const { importId } = await ops.retryImport(adminUserId, input);

  // Not awaited: the processor is time-boxed with self-continuation and can outlive any
  // reasonable action. `after()` needs a request scope, which is why it is here rather
  // than in the operation.
  after(() => ops.runImportJob(importId));

  revalidateAdmin(input.targetUserId);
  revalidatePath("/imports");
  return { ok: true };
}

export async function cancelImportAction(input: {
  targetUserId: string;
  importId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.cancelImport(adminUserId, input);
  revalidateAdmin(input.targetUserId);
  revalidatePath("/imports");
  return { ok: true };
}

export async function resetOnboardingAction(input: {
  targetUserId: string;
  scope: "onboarding" | "wizard" | "both";
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.resetOnboarding(adminUserId, input);
  revalidateAdmin(input.targetUserId);
  return { ok: true };
}

export async function disconnectIntegrationAction(input: {
  targetUserId: string;
  provider: "gmail" | "outlook";
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.disconnectIntegration(adminUserId, input);
  revalidateAdmin(input.targetUserId);
  return { ok: true };
}

export async function setCalendarFeedEnabledAction(input: {
  targetUserId: string;
  subscriptionId: string;
  enabled: boolean;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.setCalendarFeedEnabled(adminUserId, input);
  revalidateAdmin(input.targetUserId);
  return { ok: true };
}

export async function setAccountSuspendedAction(input: {
  targetUserId: string;
  suspended: boolean;
  reason: string;
}): Promise<{ ok: true; suspendedAt: string | null }> {
  const adminUserId = await requireAdminUserId();
  const result = await ops.setAccountSuspended(adminUserId, input);
  revalidateAdmin(input.targetUserId);
  return { ok: true, suspendedAt: result.suspendedAt?.toISOString() ?? null };
}

export async function deleteAccountAction(input: {
  targetUserId: string;
  confirmEmail: string;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.deleteAccount(adminUserId, input);
  revalidateAdmin();
  return { ok: true };
}

/** Banner state for the inspector. Never returns a grant object. */
export async function getActiveRevealGrant(targetUserId: string) {
  const adminUserId = await requireAdminUserId();
  return ops.getActiveRevealGrantFor(adminUserId, targetUserId);
}
