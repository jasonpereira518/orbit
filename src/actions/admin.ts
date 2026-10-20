"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { adminAuditLog, userSettings } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import { loadProviderStatuses } from "@/lib/admin-providers";
import * as ops from "@/lib/admin-operations";
import * as interestList from "@/lib/admin-interest-list";
import * as adminFeedback from "@/lib/admin-feedback";
import * as broadcast from "@/lib/broadcasts";
import { recordAdminAction } from "@/lib/admin-operations";
import { resolvePlan } from "@/lib/entitlements";
import type { Plan } from "@/lib/plans/plan-config";
import { setCompedPlan } from "@/lib/user-settings";
import { grantLifetime, previewLifetime, revokeLifetime, type LifetimePreview } from "@/lib/admin-lifetime";
import { setAccountKindAsAdmin, type AccountKind } from "@/lib/admin-account-kind";
import { runOpsSweep } from "@/lib/ops-sweep";
import { notifySlack } from "@/lib/ops-notify";
import { sendSlackDM } from "@/lib/slack-dm";
import {
  PREVIEW_UNRELEASED_COOKIE,
  setNavOrder,
  setSurfaceComingSoon,
  setSurfaceTiers,
  setSurfaceHidden,
  VIEW_AS_USER_COOKIE,
} from "@/lib/surface-visibility";
import {
  setConstellationConfig,
  type ConstellationConfig,
} from "@/lib/constellation-config";
import { setStealth } from "@/lib/site-access";
import {
  setManagedAiPaused,
  setWebSearchPaused,
  type ManagedAiSwitchState,
  type WebSearchSwitchState,
} from "@/lib/managed-ai-switch";
import { setWaitlistDemoEnabled } from "@/lib/waitlist-demo";
import {
  inviteToSite,
  revokeSiteInvite,
  SiteInviteError,
  type SiteInviteResult,
} from "@/lib/site-invites";
import { UserFacingError } from "@/lib/errors";
import { blockSharedAvatar, unblockSharedAvatar } from "@/lib/admin-avatars";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";
import { anyNumber } from "@/lib/input/schemas";

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
  plan: Plan;
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
export const setCompAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), plan: z.enum(["orbit", "max"]).nullable(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    plan: "orbit" | "max" | null;
    reason: string;
  }): Promise<CompResult> => {
    const reason = input.reason.trim();
    if (!reason) throw new Error("A reason is required.");
    // Lifetime has its own audited path (grantLifetimeAction), which also ends a live
    // subscription at its period end. A comp is Pro or Max only.
    if (input.plan !== null && input.plan !== "orbit" && input.plan !== "max") {
      throw new Error("Comp Pro or Max here; Lifetime has its own Grant action.");
    }

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
);

/**
 * Mark an account `internal` (the operator, a teammate, the showcase account), `tester`, or
 * neither (`null`, a real customer). Takes the account out of, or back into, every product and
 * revenue aggregate. A reason is required and an audit row is written; the body is
 * `setAccountKindAsAdmin`.
 */
export const setAccountKindAction = defineAction(
  // `kind` is checked against the closed list in `setAccountKindAsAdmin`.
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), kind: z.string().nullable(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    kind: AccountKind | null;
    reason: string;
  }): Promise<{ ok: true; kind: AccountKind | null; changed: boolean }> => {
    const result = await setAccountKindAsAdmin(adminUserId, input);
    revalidatePath("/admin");
    revalidatePath("/admin/users");
    revalidatePath("/admin/growth");
    revalidatePath(`/admin/users/${input.targetUserId}`);
    return { ok: true, kind: result.to, changed: result.changed };
  }
);

/* ------------------------------------------------------------- Lifetime (admin) ------- */
// Admin-assigned only (pricing v2). The bodies live in `src/lib/admin-lifetime.ts`.

export type { LifetimePreview } from "@/lib/admin-lifetime";

/** What granting or revoking would do to this account — shown before anything changes. */
export const previewLifetimeAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.string()]) },
  async (_caller, targetUserId: string): Promise<LifetimePreview> => {
    return previewLifetime(targetUserId);
  }
);

/** Grant Lifetime; a live subscription is set to end at its period end. Audited. */
export const grantLifetimeAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    reason: string;
  }): Promise<{ ok: true; subscription: "scheduled" | "none" | "error" }> => {
    const result = await grantLifetime(adminUserId, input);
    revalidateAccount(input.targetUserId);
    return result;
  }
);

/** Revoke a comped Lifetime (and, only when asked, a purchased one). Audited. */
export const revokeLifetimeAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), reason: z.string(), includePurchase: z.boolean().optional() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    reason: string;
    includePurchase?: boolean;
  }): Promise<CompResult> => {
    const result = await revokeLifetime(adminUserId, input);
    revalidateAccount(input.targetUserId);
    return result;
  }
);

function revalidateAccount(targetUserId: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${targetUserId}`);
  revalidatePath("/admin/billing");
}

/**
 * A one-click sign-in URL for the named account. See `ops.mintSignInLink` for what this
 * actually is (a single-use Clerk sign-in token) and why the expiry is generous but the
 * link is not reusable regardless.
 */
export const mintSignInLinkAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    reason: string;
  }): Promise<{ url: string; expiresInSeconds: number }> => {
    return ops.mintSignInLink(adminUserId, input);
  }
);

/** Audit history for one account, shown on their inspector page. */
export const getAuditTrail = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.string()]) },
  async (_caller, targetUserId: string) => {
    const db = await getDb();
    return db.query.adminAuditLog.findMany({
      where: eq(adminAuditLog.targetUserId, targetUserId),
      orderBy: [desc(adminAuditLog.createdAt)],
      limit: 25,
    });
  }
);

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

export const retryImportAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), importId: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    importId: string;
    reason: string;
  }): Promise<{ ok: true }> => {
    const { importId } = await ops.retryImport(adminUserId, input);

    // Not awaited: the processor is time-boxed with self-continuation and can outlive any
    // reasonable action. `after()` needs a request scope, which is why it is here rather
    // than in the operation.
    after(() => ops.runImportJob(importId));

    revalidateAdmin(input.targetUserId);
    revalidatePath("/imports");
    return { ok: true };
  }
);

export const cancelImportAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), importId: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    importId: string;
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.cancelImport(adminUserId, input);
    revalidateAdmin(input.targetUserId);
    revalidatePath("/imports");
    return { ok: true };
  }
);

export const resetOnboardingAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), scope: z.enum(["onboarding", "wizard", "both"]), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    scope: "onboarding" | "wizard" | "both";
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.resetOnboarding(adminUserId, input);
    revalidateAdmin(input.targetUserId);
    return { ok: true };
  }
);

export const disconnectIntegrationAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), provider: z.enum(["gmail", "outlook"]), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    provider: "gmail" | "outlook";
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.disconnectIntegration(adminUserId, input);
    revalidateAdmin(input.targetUserId);
    return { ok: true };
  }
);

export const setCalendarFeedEnabledAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), subscriptionId: z.string(), enabled: z.boolean(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    subscriptionId: string;
    enabled: boolean;
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.setCalendarFeedEnabled(adminUserId, input);
    revalidateAdmin(input.targetUserId);
    return { ok: true };
  }
);

export const setAccountSuspendedAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), suspended: z.boolean(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    suspended: boolean;
    reason: string;
  }): Promise<{ ok: true; suspendedAt: string | null }> => {
    const result = await ops.setAccountSuspended(adminUserId, input);
    revalidateAdmin(input.targetUserId);
    return { ok: true, suspendedAt: result.suspendedAt?.toISOString() ?? null };
  }
);

export const deleteAccountAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), confirmEmail: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    confirmEmail: string;
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.deleteAccount(adminUserId, input);
    revalidateAdmin();
    return { ok: true };
  }
);

export const hardDeleteAccountAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ targetUserId: z.string(), confirmEmail: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    targetUserId: string;
    confirmEmail: string;
    reason: string;
  }): Promise<{ ok: true }> => {
    await ops.hardDeleteAccount(adminUserId, input);
    revalidateAdmin();
    return { ok: true };
  }
);

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
export const setSurfaceHiddenAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ surfaceKey: z.string(), hidden: z.boolean() })]) },
  async (adminUserId, input: {
    surfaceKey: string;
    hidden: boolean;
  }): Promise<{ ok: true }> => {
    await setSurfaceHidden(adminUserId, input.surfaceKey, input.hidden);

    revalidatePath("/", "layout");
    revalidatePath("/admin/product");
    return { ok: true };
  }
);

/**
 * Mark a page coming soon (or release it) for everyone. Same shape and invalidation as
 * `setSurfaceHiddenAction`: the app shell builds the sidebar's "Soon" tags from this, and
 * the dashboard, settings and radar jobs all key off it.
 */
export const setSurfaceComingSoonAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ surfaceKey: z.string(), soon: z.boolean() })]) },
  async (adminUserId, input: {
    surfaceKey: string;
    soon: boolean;
  }): Promise<{ ok: true }> => {
    await setSurfaceComingSoon(adminUserId, input.surfaceKey, input.soon);

    revalidatePath("/", "layout");
    revalidatePath("/admin/product");
    return { ok: true };
  }
);

/**
 * Limit a page to some tiers, or open it to all of them. Same shape and invalidation as the
 * two toggles above: the app shell tags and locks the sidebar from these rules.
 */
export const setSurfaceTiersAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ surfaceKey: z.string(), plans: z.array(z.string()) })]) },
  async (adminUserId, input: {
    surfaceKey: string;
    plans: string[];
  }): Promise<{ ok: true }> => {
    await setSurfaceTiers(adminUserId, input.surfaceKey, input.plans);

    revalidatePath("/", "layout");
    revalidatePath("/admin/product");
    return { ok: true };
  }
);

/** Save the sidebar order for everyone. See `setNavOrder`. */
export const setNavOrderAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ order: z.array(z.string()) })]) },
  async (adminUserId, input: { order: string[] }): Promise<{ ok: true }> => {
    await setNavOrder(adminUserId, input.order);

    revalidatePath("/", "layout");
    revalidatePath("/admin/product");
    return { ok: true };
  }
);

/**
 * Change the constellation filter for everyone.
 *
 * Same shape as the surface toggle above and the same reasoning about invalidation: the
 * filter decides what `/graph` and the dashboard preview draw, so both of those and anything
 * that caches them have to be dropped, not just this console page.
 *
 * Thresholds are clamped in `setConstellationConfig` rather than validated to an error here —
 * an operator nudging a number field into nonsense should land on the nearest sane value, not
 * on a stack trace.
 */
export const setConstellationConfigAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ enabled: z.boolean().optional(), minInbound: anyNumber.optional(), minOutbound: anyNumber.optional() })]) },
  async (adminUserId, input: {
    enabled?: boolean;
    minInbound?: number;
    minOutbound?: number;
  }): Promise<ConstellationConfig> => {
    const next = await setConstellationConfig(adminUserId, input);

    revalidatePath("/", "layout");
    revalidatePath("/admin/product");
    revalidatePath("/graph");
    revalidatePath("/dashboard");
    return next;
  }
);

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
 *
 * Entering redirects itself (see `setYcModeAction` for why: one round trip instead of the
 * caller awaiting this and then separately calling `router.push`). Exiting does not — the
 * caller stays on the same admin page, so it only needs the cookie change and `revalidatePath`
 * to pick up; setting/deleting a cookie already re-renders the current page on its own, and
 * callers additionally `router.refresh()` to be sure every server component above them re-runs.
 */
export const setViewAsUserAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ on: z.boolean() })]) },
  async (adminUserId, input: {
    on: boolean;
  }): Promise<{ ok: true }> => {
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
    if (input.on) {
      redirect("/dashboard");
    }
    return { ok: true };
  }
);

/**
 * Toggle whether the calling admin sees real pages behind a coming-soon screen.
 *
 * The mirror image of `setViewAsUserAction`: that one takes access AWAY from an operator's
 * own session, this one GRANTS it. A coming-soon page (`comingSoon` in `src/lib/surfaces.ts`)
 * is closed to admins by default — this is the explicit, audited opt-in past that default,
 * not a general admin exemption, so a forgotten toggle cannot ship an unfinished feature to
 * the operator's own eyes only by accident.
 *
 * No redirect on entry (unlike `setViewAsUserAction`): there is nowhere it needs to send the
 * caller, since turning this on does not change what the caller could already reach, only
 * what an unreleased page shows them once they are there.
 */
export const setPreviewUnreleasedAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ on: z.boolean() })]) },
  async (adminUserId, input: {
    on: boolean;
  }): Promise<{ ok: true }> => {
    const store = await cookies();

    if (input.on) {
      store.set(PREVIEW_UNRELEASED_COOKIE, "1", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      });
    } else {
      store.delete(PREVIEW_UNRELEASED_COOKIE);
    }

    await recordAdminAction({
      adminUserId,
      action: input.on
        ? "product.preview_unreleased.enter"
        : "product.preview_unreleased.exit",
    });

    revalidatePath("/", "layout");
    return { ok: true };
  }
);

/**
 * Toggle YC Startup console mode for the calling admin.
 *
 * Purely a personal preference on the operator's own `userSettings` row — it never touches
 * another user's data or visibility, so unlike `setSurfaceHiddenAction` / `setViewAsUserAction`
 * it does not go through `recordAdminAction`. Same shape as `saveThemePreference`.
 *
 * Redirects itself rather than returning and letting the client `router.push()`: per Next's
 * server-actions guide, a `redirect()` thrown from inside the action completes the mutation,
 * the cache invalidation, and the destination's render in one round trip, instead of the
 * client waiting on the action response before it can even start a second navigation fetch.
 * Scoped to `/admin` rather than `/`, `"layout"` — this setting is never read outside the
 * console, so invalidating the whole site on every toggle bought nothing.
 */
export const setYcModeAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ on: z.boolean() })]) },
  async (adminUserId, input: { on: boolean }): Promise<never> => {
    const db = await getDb();

    await db
      .insert(userSettings)
      .values({ userId: adminUserId, ycModeEnabled: input.on })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ycModeEnabled: input.on, updatedAt: new Date() },
      });

    revalidatePath("/admin", "layout");
    redirect(input.on ? "/admin/yc" : "/admin");
  }
);

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
export const unsubscribeInterestListAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    reason: string;
  }): Promise<{ ok: true; email: string }> => {
    const reason = ops.requireReason(input.reason);

    const removed = await interestList.unsubscribeInterestListRow(input.id);
    // Throws rather than returning a failure shape: ConfirmActionDialog reports success for
    // any resolved promise and only surfaces a rejection, so a returned {ok:false} would
    // toast "done" over an operation that did nothing. UserFacingError so the message
    // survives production digests and friendlyError can show it.
    if (!removed) throw new UserFacingError("That signup no longer exists");

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
);

export const resubscribeInterestListAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    reason: string;
  }): Promise<{ ok: true; email: string }> => {
    const reason = ops.requireReason(input.reason);

    const restored = await interestList.resubscribeInterestListRow(input.id);
    if (!restored) throw new UserFacingError("That signup no longer exists");

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
);

/** In-person event signup: adds the row, names on the pass, welcome email names the event. */
export const addManualInterestListSignupAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ email: z.string(), firstName: z.string(), lastName: z.string(), eventLabel: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    email: string;
    firstName: string;
    lastName: string;
    eventLabel: string;
    reason: string;
  }): Promise<{ ok: true; email: string }> => {
    const reason = ops.requireReason(input.reason);

    const added = await interestList.addManualInterestListSignup({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      eventLabel: input.eventLabel,
    });

    await recordAdminAction({
      adminUserId,
      action: "interest_list.manual_add",
      resourceType: "interest_list_signup",
      resourceId: added.id,
      detail: { email: added.email, eventLabel: input.eventLabel.trim() },
      reason,
    });

    revalidateInterestList();
    return { ok: true, email: added.email };
  }
);

/** Spreadsheet paste from an event: many people, one event label, join order preserved. */
export const addManualInterestListPasteAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ paste: z.string(), eventLabel: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    paste: string;
    eventLabel: string;
    reason: string;
  }): Promise<{
    ok: true;
    added: number;
    skipped: number;
    parseErrors: string[];
    skippedEmails: Array<{ email: string; reason: string }>;
  }> => {
    const reason = ops.requireReason(input.reason);

    const result = await interestList.addManualInterestListSignupsFromPaste({
      paste: input.paste,
      eventLabel: input.eventLabel,
    });

    if (result.added.length === 0 && result.skipped.length === 0) {
      throw new UserFacingError(
        result.parseErrors[0] ?? "Paste at least one row: timestamp, name, and email."
      );
    }

    await recordAdminAction({
      adminUserId,
      action: "interest_list.manual_add_bulk",
      resourceType: "interest_list_signup",
      resourceId: result.added[0]?.id ?? "bulk",
      detail: {
        eventLabel: input.eventLabel.trim(),
        added: result.added.map((a) => a.email),
        skipped: result.skipped,
        parseErrors: result.parseErrors,
      },
      reason,
    });

    revalidateInterestList();
    return {
      ok: true,
      added: result.added.length,
      skipped: result.skipped.length,
      parseErrors: result.parseErrors,
      skippedEmails: result.skipped,
    };
  }
);

export const deleteInterestListAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), confirmEmail: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    /** Must match the row's address. Guards against deleting whatever was scrolled to. */
    confirmEmail: string;
    reason: string;
  }): Promise<{ ok: true; email: string }> => {
    const reason = ops.requireReason(input.reason);

    // The audit entry records the address, so it is captured before the row is gone — and
    // checked against what the operator typed, so a stale page cannot delete the wrong row.
    const existing = await interestList.loadInterestListRow(input.id);
    if (!existing) throw new UserFacingError("That signup no longer exists");
    if (existing.email.trim().toLowerCase() !== input.confirmEmail.trim().toLowerCase()) {
      throw new UserFacingError("That address does not match this signup");
    }

    const deleted = await interestList.deleteInterestListRow(input.id);
    if (!deleted) throw new UserFacingError("That signup no longer exists");

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
);

/**
 * Bulk removals.
 *
 * Capped in the data layer rather than trusted from the client, and the audit entry records
 * every address rather than a count — after a bulk delete that entry is the only thing that
 * can answer "who did that take out".
 */
export const bulkUnsubscribeInterestListAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ ids: z.array(z.string()), reason: z.string() })]) },
  async (adminUserId, input: {
    ids: string[];
    reason: string;
  }): Promise<{ ok: true; count: number }> => {
    const reason = ops.requireReason(input.reason);
    if (input.ids.length === 0) throw new UserFacingError("Nothing selected");

    const emails = await interestList.bulkUnsubscribeInterestListRows(input.ids);
    if (emails.length === 0) throw new UserFacingError("None of those signups still exist");

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
);

export const bulkDeleteInterestListAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ ids: z.array(z.string()), reason: z.string() })]) },
  async (adminUserId, input: {
    ids: string[];
    reason: string;
  }): Promise<{ ok: true; count: number }> => {
    const reason = ops.requireReason(input.reason);
    if (input.ids.length === 0) throw new UserFacingError("Nothing selected");

    const emails = await interestList.bulkDeleteInterestListRows(input.ids);
    if (emails.length === 0) throw new UserFacingError("None of those signups still exist");

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
);

/**
 * Broadcasts — the operator-composed note to the interest list.
 *
 * Sending is the one action here that reaches many people at once and cannot be recalled,
 * so it is deliberately a two-step: compose saves a draft, and a separate send with its own
 * confirmation is what actually mails it. There is no compose-and-send-in-one-click path.
 */
export const createBroadcastAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ subject: z.string(), body: z.string() })]) },
  async (adminUserId, input: {
    subject: string;
    body: string;
  }): Promise<{ ok: true; id: string }> => {
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
);

export const sendBroadcastTestAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ subject: z.string(), body: z.string(), to: z.string() })]) },
  async (_caller, input: {
    subject: string;
    body: string;
    to: string;
  }): Promise<{ ok: true }> => {
    const invalid = broadcast.validateBroadcast(input);
    if (invalid) throw new Error(invalid);
    if (!input.to.includes("@")) throw new Error("That doesn't look like an address.");

    const result = await broadcast.sendBroadcastTest(input);
    if (!result.ok) throw new Error(result.error ?? "The test send failed.");
    return { ok: true };
  }
);

export const sendBroadcastAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), confirmSubject: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    /** Must match the subject. The guard against sending the wrong draft to everyone. */
    confirmSubject: string;
    reason: string;
  }): Promise<{ ok: true; sent: number; failed: number; remaining: number }> => {
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
);

export const deleteBroadcastAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    reason: string;
  }): Promise<{ ok: true }> => {
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
);

/**
 * Run the known-condition sweep now, from the console, rather than waiting up to ten
 * minutes for the scheduler. Audited like every other privileged action.
 */
export const runOpsSweepAction = defineAction(
  { auth: () => requireAdminUserId() },
  async (adminUserId): Promise<{
    ok: true;
    opened: string[];
    reminded: string[];
    recovered: string[];
    active: string[];
  }> => {
    const result = await runOpsSweep({ trigger: "manual" });
    await recordAdminAction({
      adminUserId,
      action: "ops.sweep",
      detail: {
        opened: result.opened,
        reminded: result.reminded,
        recovered: result.recovered,
        active: result.active.length,
        deliveryFailures: result.deliveryFailures,
      },
    });
    revalidatePath("/admin/health");
    return {
      ok: true,
      opened: result.opened,
      reminded: result.reminded,
      recovered: result.recovered,
      active: result.active,
    };
  }
);

/** Prove the Slack webhook is wired, from the console. */
export const sendTestAlertAction = defineAction(
  { auth: () => requireAdminUserId() },
  async (adminUserId): Promise<{ ok: true }> => {
    await notifySlack(
      `:mega: Test alert from the Orbit admin console (sent by \`${adminUserId}\`). If you can read this, ops alerts reach Slack.`
    );
    await recordAdminAction({ adminUserId, action: "ops.test_alert" });
    return { ok: true };
  }
);

/** Prove the Slack bot can DM you specifically, from the console. */
export const sendTestSlackDMAction = defineAction(
  { auth: () => requireAdminUserId() },
  async (adminUserId): Promise<{ ok: true }> => {
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_ALERT_USER_ID) {
      throw new Error("SLACK_BOT_TOKEN / SLACK_ALERT_USER_ID is not set");
    }
    await sendSlackDM(
      `:wave: Test DM from the Orbit admin console (sent by \`${adminUserId}\`). If you can read this, critical-error and feedback alerts will reach you here.`
    );
    await recordAdminAction({ adminUserId, action: "ops.test_dm" });
    return { ok: true };
  }
);

/**
 * Both paths the feedback console can change, plus the nav badge.
 *
 * The badge is rendered by `AdminShell` from `(admin)/layout.tsx`, and a plain path
 * revalidate does not re-run a layout — so the second call is what makes the count drop
 * when something is resolved.
 */
function revalidateFeedback() {
  revalidatePath("/admin/feedback");
  revalidatePath("/admin", "layout");
}

/**
 * Move one entry between new / triaged / resolved.
 *
 * Throws rather than returning a failure shape, like every action in this file:
 * `ConfirmActionDialog` reports success for any resolved promise and surfaces only a
 * rejection's message.
 */
export const setFeedbackStatusAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), status: z.enum(["new", "triaged", "resolved"]), reason: z.string(), resolutionNote: z.string().optional() })]) },
  async (adminUserId, input: {
    id: string;
    status: "new" | "triaged" | "resolved";
    reason: string;
    resolutionNote?: string;
  }): Promise<{ ok: true; from: string }> => {
    const reason = ops.requireReason(input.reason);

    const moved = await adminFeedback.setFeedbackStatus({
      id: input.id,
      status: input.status,
      adminUserId,
      resolutionNote: input.resolutionNote?.trim() || undefined,
    });
    if (!moved) throw new Error("That feedback entry no longer exists.");
    if (moved.from === input.status) throw new Error(`That entry is already ${input.status}.`);

    await recordAdminAction({
      adminUserId,
      action:
        input.status === "resolved"
          ? "feedback.resolve"
          : input.status === "triaged"
            ? "feedback.triage"
            : "feedback.reopen",
      resourceType: "feedback",
      resourceId: input.id,
      detail: {
        from: moved.from,
        to: input.status,
        excerpt: moved.excerpt,
        ...(input.resolutionNote ? { resolutionNote: input.resolutionNote } : {}),
      },
      reason,
    });

    revalidateFeedback();
    return { ok: true, from: moved.from };
  }
);

/**
 * Delete one screenshot, and then its blob object.
 *
 * The row is the contract and the blob is cleanup: a Blob outage must not stop an operator
 * removing something that should never have been captured in the first place.
 */
export const deleteFeedbackScreenshotAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ id: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    id: string;
    reason: string;
  }): Promise<{ ok: true }> => {
    const reason = ops.requireReason(input.reason);

    const removed = await adminFeedback.deleteFeedbackScreenshot(input.id);
    if (!removed) throw new Error("That screenshot no longer exists.");

    let blobDeleted = false;
    if (removed.blobUrl) {
      try {
        const { del } = await import("@vercel/blob");
        await del(removed.blobUrl);
        blobDeleted = true;
      } catch {
        // See above.
      }
    }

    await recordAdminAction({
      adminUserId,
      action: "feedback.screenshot_delete",
      resourceType: "feedback_screenshot",
      resourceId: input.id,
      detail: { feedbackId: removed.feedbackId, storage: removed.storage, blobDeleted },
      reason,
    });

    revalidateFeedback();
    return { ok: true };
  }
);

/* ------------------------------------------------------------------- provider status */

/**
 * Re-checks all four providers now, bypassing the snapshot cache.
 *
 * `/admin/health` reads the cached snapshot so a page load never fans out to four APIs;
 * this is the "I am looking at it right now" path. Nothing is passed in, so there is
 * nothing to validate — but the gate still comes first, because a route that hits four
 * third-party APIs on demand is one an unauthenticated caller should not be able to ring.
 */
export const refreshProvidersAction = defineAction(
  { auth: () => requireAdminUserId() },
  async (_caller): Promise<{ ok: true }> => {
    await loadProviderStatuses({ force: true });
    revalidatePath("/admin/health");
    return { ok: true };
  }
);

/* ------------------------------------------------------------------------ site access */

function revalidateAccess() {
  revalidatePath("/admin/access");
  revalidatePath("/admin/growth/interest-list");
}

/**
 * Switch stealth on or off for the whole site. Takes effect within the proxy's cache window
 * (seconds), on every instance, with no deploy. Confirmed and reasoned in the UI because
 * turning it off opens every page to the public.
 */
export const setSiteStealthAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ enabled: z.boolean(), reason: z.string() })]) },
  async (adminUserId, input: {
    enabled: boolean;
    reason: string;
  }): Promise<{ ok: true; stealth: boolean }> => {
    ops.requireReason(input.reason);
    const mode = await setStealth(adminUserId, input.enabled);
    revalidateAccess();
    return { ok: true, stealth: mode.stealth };
  }
);

/**
 * Show or hide the waitlist page's "Take it for a spin" product demo. Low stakes and easy to
 * reverse, so unlike stealth it asks for no reason — the audit log still records who and when.
 * The public page reads it through a ten-second cache; `/interest` is revalidated so the
 * instance that made the change shows it at once.
 */
export const setWaitlistDemoAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ enabled: z.boolean() })]) },
  async (adminUserId, input: {
    enabled: boolean;
  }): Promise<{ ok: true; enabled: boolean }> => {
    const enabled = await setWaitlistDemoEnabled(adminUserId, input.enabled === true);
    revalidatePath("/interest");
    revalidatePath("/");
    revalidatePath("/admin/growth/interest-list");
    return { ok: true, enabled };
  }
);

/**
 * Invite someone to create an account, stealth or not. Returns the result rather than
 * throwing for a bad address, so the form can say what was wrong in place; Clerk and
 * database failures still throw.
 */
export const inviteToSiteAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ email: z.string(), notify: z.boolean(), firstName: z.string().nullish(), wave: z.string().nullish() })]) },
  async (adminUserId, input: {
    email: string;
    notify: boolean;
    firstName?: string | null;
    /** The operator's wave label (`w1`, `w2`); validated in `inviteToSite`. */
    wave?: string | null;
  }): Promise<SiteInviteResult | { kind: "error"; message: string }> => {
    const firstName = input.firstName?.trim().slice(0, 60) || null;
    try {
      const result = await inviteToSite({
        adminUserId,
        email: input.email,
        notify: input.notify,
        firstName,
        wave: input.wave ?? null,
      });
      revalidateAccess();
      return result;
    } catch (err) {
      if (err instanceof SiteInviteError) return { kind: "error", message: err.message };
      throw err;
    }
  }
);

export const revokeSiteInviteAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ invitationId: z.string(), reason: z.string() })]) },
  async (adminUserId, input: {
    invitationId: string;
    reason: string;
  }): Promise<{ ok: true; email: string }> => {
    ops.requireReason(input.reason);
    const { email } = await revokeSiteInvite({ adminUserId, invitationId: input.invitationId });
    revalidateAccess();
    return { ok: true, email };
  }
);

/**
 * Pause or resume included AI on Pro and Max. Audited; takes effect on this instance at once
 * and on every other within 30 seconds. Free and Lifetime are never affected.
 */
export const setManagedAiPausedAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ paused: z.boolean(), reason: z.string() })]) },
  async (adminUserId, input: {
    paused: boolean;
    reason: string;
  }): Promise<ManagedAiSwitchState> => {
    const state = await setManagedAiPaused(adminUserId, input.paused === true, input.reason);
    revalidatePath("/admin/billing");
    return state;
  }
);

/** Stop or restart hosted web search for every account. Audited; same 30-second reach. */
export const setWebSearchPausedAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ paused: z.boolean(), reason: z.string() })]) },
  async (adminUserId, input: { paused: boolean; reason: string }): Promise<WebSearchSwitchState> => {
    const state = await setWebSearchPaused(adminUserId, input.paused === true, input.reason);
    revalidatePath("/admin/billing");
    return state;
  }
);

/* ------------------------------------------------- Shared LinkedIn photo takedown ------- */

function revalidateAvatars() {
  revalidatePath("/admin/avatars");
  revalidatePath("/admin/users");
}

/** Remove a shared LinkedIn photo and block the slug from being re-fetched or re-contributed. */
export const blockSharedAvatarAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ slug: z.string(), reason: z.string() })]) },
  async (adminUserId, input: { slug: string; reason: string }): Promise<{ ok: true }> => {
    await blockSharedAvatar(adminUserId, input);
    revalidateAvatars();
    return { ok: true };
  }
);

export const unblockSharedAvatarAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ slug: z.string(), reason: z.string() })]) },
  async (adminUserId, input: { slug: string; reason: string }): Promise<{ ok: true }> => {
    await unblockSharedAvatar(adminUserId, input);
    revalidateAvatars();
    return { ok: true };
  }
);
