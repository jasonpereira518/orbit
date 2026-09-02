"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { adminAuditLog, userSettings } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import * as ops from "@/lib/admin-operations";
import * as interestList from "@/lib/admin-interest-list";
import * as broadcast from "@/lib/broadcasts";
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

/**
 * A one-click sign-in URL for the named account. See `ops.mintSignInLink` for what this
 * actually is (a single-use Clerk sign-in token) and why the expiry is generous but the
 * link is not reusable regardless.
 */
export async function mintSignInLinkAction(input: {
  targetUserId: string;
}): Promise<{ url: string; expiresInSeconds: number }> {
  const adminUserId = await requireAdminUserId();
  return ops.mintSignInLink(adminUserId, input);
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
function revalidateInterestList() {
  revalidatePath("/admin/growth");
  revalidatePath("/admin/growth/interest-list");
}

function revalidateBroadcasts() {
  revalidatePath("/admin/growth/broadcasts");
}

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

  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Interest-list removals.
 *
 * Two operations rather than one because "remove them" means two different things. The
 * unsubscribe writes the same `unsubscribed_at` the recipient's own one-click link sets,
 * so there stays exactly one condition deciding whether someone is mailable; the delete
 * erases the row, losing the signup date and source, which is only right for a bot
 * signup, a typo, or a real deletion request.
 *
 * Both take a reason and both await their audit write. These reach a person's inbox
 * rather than the operator's screen, and a delete has no other record that it happened —
 * `interest_list_signups` is the only place that address ever existed.
 */
export async function unsubscribeInterestListAction(input: {
  id: string;
  reason: string;
}): Promise<{ ok: true; email: string }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);

  const removed = await interestList.unsubscribeInterestListRow(input.id);
  // Throws rather than returning a failure shape: ConfirmActionDialog reports success for
  // any resolved promise and only surfaces a rejection, so a returned {ok:false} would
  // toast "done" over an operation that did nothing.
  if (!removed) throw new Error("That signup no longer exists.");

  await recordAdminAction({
    adminUserId,
    action: "interest_list.unsubscribe",
    resourceType: "interest_list_signup",
    resourceId: input.id,
    detail: { email: removed.email },
    reason,
  });

  revalidateInterestList();
  return { ok: true, email: removed.email };
}

export async function resubscribeInterestListAction(input: {
  id: string;
  reason: string;
}): Promise<{ ok: true; email: string }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);

  const restored = await interestList.resubscribeInterestListRow(input.id);
  if (!restored) throw new Error("That signup no longer exists.");

  await recordAdminAction({
    adminUserId,
    action: "interest_list.resubscribe",
    resourceType: "interest_list_signup",
    resourceId: input.id,
    detail: { email: restored.email },
    reason,
  });

  revalidateInterestList();
  return { ok: true, email: restored.email };
}

export async function deleteInterestListAction(input: {
  id: string;
  /** Must match the row's address. Guards against deleting whatever was scrolled to. */
  confirmEmail: string;
  reason: string;
}): Promise<{ ok: true; email: string }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);

  // The audit entry records the address, so it is captured before the row is gone — and
  // checked against what the operator typed, so a stale page cannot delete the wrong row.
  const existing = await interestList.loadInterestListRow(input.id);
  if (!existing) throw new Error("That signup no longer exists.");
  if (existing.email.trim().toLowerCase() !== input.confirmEmail.trim().toLowerCase()) {
    throw new Error("That address does not match this signup.");
  }

  const deleted = await interestList.deleteInterestListRow(input.id);
  if (!deleted) throw new Error("That signup no longer exists.");

  await recordAdminAction({
    adminUserId,
    action: "interest_list.delete",
    resourceType: "interest_list_signup",
    resourceId: input.id,
    detail: { email: deleted.email },
    reason,
  });

  revalidateInterestList();
  return { ok: true, email: deleted.email };
}

/**
 * Bulk removals.
 *
 * Capped in the data layer rather than trusted from the client, and the audit entry records
 * every address rather than a count — after a bulk delete that entry is the only thing that
 * can answer "who did that take out".
 */
export async function bulkUnsubscribeInterestListAction(input: {
  ids: string[];
  reason: string;
}): Promise<{ ok: true; count: number }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);
  if (input.ids.length === 0) throw new Error("Nothing selected.");

  const emails = await interestList.bulkUnsubscribeInterestListRows(input.ids);
  if (emails.length === 0) throw new Error("None of those signups still exist.");

  await recordAdminAction({
    adminUserId,
    action: "interest_list.bulk_unsubscribe",
    resourceType: "interest_list_signup",
    detail: { emails, count: emails.length },
    reason,
  });

  revalidateInterestList();
  return { ok: true, count: emails.length };
}

export async function bulkDeleteInterestListAction(input: {
  ids: string[];
  reason: string;
}): Promise<{ ok: true; count: number }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);
  if (input.ids.length === 0) throw new Error("Nothing selected.");

  const emails = await interestList.bulkDeleteInterestListRows(input.ids);
  if (emails.length === 0) throw new Error("None of those signups still exist.");

  await recordAdminAction({
    adminUserId,
    action: "interest_list.bulk_delete",
    resourceType: "interest_list_signup",
    detail: { emails, count: emails.length },
    reason,
  });

  revalidateInterestList();
  return { ok: true, count: emails.length };
}

/**
 * Broadcasts — the operator-composed note to the interest list.
 *
 * Sending is the one action here that reaches many people at once and cannot be recalled,
 * so it is deliberately a two-step: compose saves a draft, and a separate send with its own
 * confirmation is what actually mails it. There is no compose-and-send-in-one-click path.
 */
export async function createBroadcastAction(input: {
  subject: string;
  body: string;
}): Promise<{ ok: true; id: string }> {
  const adminUserId = await requireAdminUserId();
  const invalid = broadcast.validateBroadcast(input);
  if (invalid) throw new Error(invalid);

  const created = await broadcast.createBroadcast({ ...input, createdBy: adminUserId });
  await recordAdminAction({
    adminUserId,
    action: "broadcast.create",
    resourceType: "broadcast",
    resourceId: created.id,
    detail: { subject: created.subject },
  });

  revalidateBroadcasts();
  return { ok: true, id: created.id };
}

export async function sendBroadcastTestAction(input: {
  subject: string;
  body: string;
  to: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const invalid = broadcast.validateBroadcast(input);
  if (invalid) throw new Error(invalid);
  if (!input.to.includes("@")) throw new Error("That doesn't look like an address.");

  const result = await broadcast.sendBroadcastTest(input);
  if (!result.ok) throw new Error(result.error ?? "The test send failed.");
  return { ok: true };
}

export async function sendBroadcastAction(input: {
  id: string;
  /** Must match the subject. The guard against sending the wrong draft to everyone. */
  confirmSubject: string;
  reason: string;
}): Promise<{ ok: true; sent: number; failed: number; remaining: number }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);

  const draft = await broadcast.loadBroadcast(input.id);
  if (!draft) throw new Error("That broadcast no longer exists.");
  if (draft.subject.trim() !== input.confirmSubject.trim()) {
    throw new Error("That subject does not match this broadcast.");
  }

  // Logged BEFORE the send, unlike every other action here: this one mails real people, and
  // if the invocation dies partway the audit must still show that a send was started.
  await recordAdminAction({
    adminUserId,
    action: "broadcast.send",
    resourceType: "broadcast",
    resourceId: draft.id,
    detail: { subject: draft.subject },
    reason,
  });

  const stats = await broadcast.sendBroadcast(input.id);
  revalidateBroadcasts();
  return { ok: true, sent: stats.sent, failed: stats.failed, remaining: stats.remaining };
}

export async function deleteBroadcastAction(input: {
  id: string;
  reason: string;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const reason = ops.requireReason(input.reason);

  const removed = await broadcast.deleteDraftBroadcast(input.id);
  if (!removed) throw new Error("Only an unsent draft can be deleted.");

  await recordAdminAction({
    adminUserId,
    action: "broadcast.delete",
    resourceType: "broadcast",
    resourceId: input.id,
    detail: { subject: removed.subject },
    reason,
  });

  revalidateBroadcasts();
  return { ok: true };
}
