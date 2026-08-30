"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { adminAuditLog, userSettings } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import * as ops from "@/lib/admin-operations";
import { recordAdminAction } from "@/lib/admin-operations";
import { resolvePlan } from "@/lib/entitlements";
import { setCompedPlan } from "@/lib/user-settings";
import {
  setSurfaceHidden,
  VIEW_AS_USER_COOKIE,
} from "@/lib/surface-visibility";

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

export async function hardDeleteAccountAction(input: {
  targetUserId: string;
  confirmEmail: string;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  await ops.hardDeleteAccount(adminUserId, input);
  revalidateAdmin();
  return { ok: true };
}

/**
 * Hide or unhide one surface for every user at once.
 *
 * Not destructive and not rate-limited: it writes or deletes a single row in
 * `app_surface_flags` and the opposite click undoes it exactly. That is why, unlike
 * suspension or deletion, it takes no reason string. It is still audited — a surface that
 * silently vanished from the product with no record of who did it would be indistinguishable
 * from a bug.
 *
 * `revalidatePath("/", "layout")` rather than a list of routes: the app shell reads the
 * hidden set to build the sidebar, so a stale layout cache would keep serving a nav item
 * for a page that now refuses to render.
 */
export async function setSurfaceHiddenAction(input: {
  surfaceKey: string;
  hidden: boolean;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();

  await setSurfaceHidden(adminUserId, input.surfaceKey, input.hidden);

  revalidatePath("/", "layout");
  revalidatePath("/admin/product");
  return { ok: true };
}

/**
 * Enter or leave "view as a general user" for this browser session.
 *
 * Admins are exempt from surface hiding so they can inspect a hidden page before releasing
 * it; this drops that exemption for the operator's own session so they see precisely what
 * a user sees. It changes nothing for anybody else, and grants nothing — it can only take
 * access away from the caller — but it is gated and audited like every other operator
 * action, because "when was I last looking at the product as a user" is a question worth
 * being able to answer.
 *
 * Session-length (no `maxAge`) on purpose: a preview mode that outlived the browser would
 * eventually be mistaken for the product being broken.
 */
export async function setViewAsUserAction(input: {
  on: boolean;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const store = await cookies();

  if (input.on) {
    store.set(VIEW_AS_USER_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
  } else {
    store.delete(VIEW_AS_USER_COOKIE);
  }

  await recordAdminAction({
    adminUserId,
    action: input.on ? "product.view_as_user.enter" : "product.view_as_user.exit",
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Toggle YC Startup console mode for the calling admin.
 *
 * Purely a personal preference on the operator's own `userSettings` row — it never touches
 * another user's data or visibility, so unlike `setSurfaceHiddenAction` / `setViewAsUserAction`
 * it does not go through `recordAdminAction`. Same shape as `saveThemePreference`.
 */
export async function setYcModeAction(input: { on: boolean }): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId: adminUserId, ycModeEnabled: input.on })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ycModeEnabled: input.on, updatedAt: new Date() },
    });

  return { ok: true };
}
