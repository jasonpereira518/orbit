import { getEntitlements } from "@/lib/entitlements";
import { loadNotificationPanel } from "@/lib/notification-panel";
import { ensureUserSettings } from "@/lib/user-settings";
import { isAdminUser } from "@/lib/admin";
import { isViewingAsUser } from "@/lib/surface-visibility";
import type { Plan } from "@/lib/plan-limits";

/**
 * The one periodic read every authenticated tab makes.
 *
 * Three client pollers used to run side by side — the notifications panel (120 s), the
 * desktop-notification watcher (90 s, which re-fetched the whole panel to find the due
 * items), and the plan-celebration watcher (75 s) — each its own server-action round trip,
 * four times a minute per tab in aggregate. One pulse answers all three from one request;
 * `src/lib/app-pulse-store.ts` shares the result across every component that cares.
 *
 * Plain function of `userId` so the smoke test can drive it without a session.
 */

export type AppPulse = {
  panel: Awaited<ReturnType<typeof loadNotificationPanel>> & {
    /** Whether to offer the operator console in the panel footer — see listNotificationPanel. */
    canOpenAdmin: boolean;
  };
  /** Due items not yet shown as a desktop notification, in the shape the OS notification needs. */
  dueItems: Array<{ id: string; title: string; body?: string; url: string }>;
  plan: Plan;
};

const DESKTOP_BATCH = 12;

export async function loadAppPulse(userId: string, now: Date): Promise<AppPulse> {
  const [rawPanel, settings, entitlements, canOpenAdmin] = await Promise.all([
    loadNotificationPanel(userId, now),
    ensureUserSettings(userId),
    getEntitlements(userId),
    isAdminUser(userId) ? isViewingAsUser(userId).then((v) => !v) : Promise.resolve(false),
  ]);
  const panel = { ...rawPanel, canOpenAdmin };
  const notified = new Set(settings.desktopNotifiedIds ?? []);
  const dueItems = panel.items
    .filter((i) => i.urgency === "due" && !notified.has(i.id))
    .slice(0, DESKTOP_BATCH)
    .map((i) => ({ id: i.id, title: i.title, body: i.body || undefined, url: i.url }));
  return { panel, dueItems, plan: entitlements.plan };
}
