import { entitlementsFromSettings } from "@/lib/entitlements";
import { loadNotificationPanel } from "@/lib/notification-panel";
import type { AccountHealthContext } from "@/lib/account-health";
import { ensureUserSettings } from "@/lib/user-settings";
import { isAdminUser } from "@/lib/admin";
import { resolveSurfaceVisibility, isViewingAsUser } from "@/lib/surface-visibility";
import { CLOUD_NOTES_SURFACE_KEY } from "@/lib/surfaces";
import type { Plan } from "@/lib/plan-limits";
import { lastUnloggedMeeting, nextKnownMeeting } from "@/lib/meeting-context";

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
 *
 * `settings` is the row the action's `requireAuthenticatedUser()` already read. This runs as
 * a Server Action, where `cache()` is a pass-through, so every `ensureUserSettings` /
 * `getEntitlements` below it used to be its own read of that one row — about seven per pulse,
 * three of them one after another. With the row passed, the panel's reads and the alerts'
 * combined select are the pulse's only statements. Omitted, it is read once here.
 */

export type AppPulse = {
  panel: Awaited<ReturnType<typeof loadNotificationPanel>> & {
    /** Whether to offer the operator console in the panel footer — see listNotificationPanel. */
    canOpenAdmin: boolean;
  };
  /** Due items not yet shown as a desktop notification, in the shape the OS notification needs. */
  dueItems: Array<{ id: string; title: string; body?: string; url: string }>;
  plan: Plan;
  /**
   * The account's desktop-notification preference; null if it has never been recorded.
   * Carried here so every open tab converges on it within one pulse — see
   * `syncDesktopNotificationsPreference`.
   */
  desktopNotificationsEnabled: boolean | null;
  /** The next meeting with someone the user knows, starting within 20 minutes — the prep card. */
  nextMeeting: Awaited<ReturnType<typeof nextKnownMeeting>>;
  /** A meeting that just ended with someone known and left no note — "How did it go?". */
  unloggedMeeting: Awaited<ReturnType<typeof lastUnloggedMeeting>>;
};

/** Far enough ahead that the prep card (15 minutes out) never waits a whole pulse for it. */
const NEXT_MEETING_WITHIN_MS = 20 * 60_000;

const DESKTOP_BATCH = 12;

export async function loadAppPulse(
  userId: string,
  now: Date,
  loadedSettings?: AccountHealthContext["settings"]
): Promise<AppPulse> {
  const settings = loadedSettings ?? (await ensureUserSettings(userId));
  const entitlements = entitlementsFromSettings(userId, settings);
  const [rawPanel, canOpenAdmin, nextMeeting, unloggedMeeting] = await Promise.all([
    // One visibility read for both gated rows (what `isSurfaceLive` checks, per key).
    resolveSurfaceVisibility(userId).then(({ hidden, comingSoon }) => {
      const live = (key: string) => !hidden.has(key) && !comingSoon.has(key);
      return loadNotificationPanel(userId, now, {
        withAlerts: true,
        settings,
        entitlements,
        radar: live("page.radar"),
        cloudNotes: live(CLOUD_NOTES_SURFACE_KEY),
      });
    }),
    isAdminUser(userId) ? isViewingAsUser(userId).then((v) => !v) : Promise.resolve(false),
    // Best-effort: a calendar read must never cost the panel its pulse.
    nextKnownMeeting(userId, now, NEXT_MEETING_WITHIN_MS).catch(() => null),
    lastUnloggedMeeting(userId, now).catch(() => null),
  ]);
  const panel = { ...rawPanel, canOpenAdmin };
  const notified = new Set(settings.desktopNotifiedIds ?? []);
  const dueItems = panel.items
    .filter((i) => i.urgency === "due" && !notified.has(i.id))
    .slice(0, DESKTOP_BATCH)
    .map((i) => ({ id: i.id, title: i.title, body: i.body || undefined, url: i.url }));
  return {
    panel,
    dueItems,
    plan: entitlements.plan,
    desktopNotificationsEnabled: settings.desktopNotificationsEnabled ?? null,
    nextMeeting,
    unloggedMeeting,
  };
}
