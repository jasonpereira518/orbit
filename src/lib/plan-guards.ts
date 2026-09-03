import { requireUserId } from "@/lib/auth";
import { requireEntitlement } from "@/lib/entitlements";
import { requireVisibleSurface } from "@/lib/surface-visibility";

/**
 * Auth + plan + surface visibility in one call, so gated server actions keep the same
 * one-line preamble the ungated ones have (`const userId = await requireUserId()`).
 *
 * Server Functions are reachable by direct POST, not only through Orbit's own UI, so these
 * — not the hidden nav items — are the real boundary for both the paywall and for a
 * surface an operator has switched off.
 *
 * WHICH ACTION MODULES ARE GATED ON A SURFACE, AND WHY NOT THE REST.
 *
 * Only modules whose every export belongs to exactly one hideable page are gated:
 * knowledge, graph, chat, outreach, recruiters. The rest were examined and deliberately
 * left alone, because their actions are load-bearing for surfaces that stay visible:
 *
 *   - `reminders.ts` — `fetchDashboard` builds the dashboard, and `listNotificationPanel`
 *     / `listDueNotificationItems` feed the notification bell that sits in the shell on
 *     every route. Gating the module on `page.reminders` would take out both.
 *   - `imports.ts` — `import-job-runner.ts` drives job continuation from the background
 *     watcher mounted in `AppShell`, so a running import would stall the moment the
 *     Imports page was hidden.
 *   - `capture.ts` — reached through `BulkNotesPanel`, which the onboarding wizard uses.
 *     A hidden Capture page would break first-run for new accounts.
 *   - `suggested-reminders.ts` — the notification panel calls it.
 *
 * That asymmetry is fine, and is the difference between this and the paywall. The paywall
 * protects something a user has not paid for; hiding takes a surface off the product for
 * everyone. The user's own data is not at stake either way, so the boundary that matters
 * is the route — which `(app)/(main)/layout.tsx` closes for every page unconditionally.
 */
export async function requireOutreachUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "outreach");
  await requireVisibleSurface(userId, "page.outreach");
  return userId;
}

export async function requireRecruitersUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "recruiters");
  await requireVisibleSurface(userId, "page.recruiters");
  return userId;
}

export async function requireSyncUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "sync");
  return userId;
}

export async function requireContactsImportUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "contactsImport");
  return userId;
}

/** Auth plus "this surface is switched on", for pages with no plan gate of their own. */
export async function requireUserForSurface(surfaceKey: string) {
  const userId = await requireUserId();
  await requireVisibleSurface(userId, surfaceKey);
  return userId;
}
