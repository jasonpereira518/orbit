/**
 * Opt-in system notifications for friends joining through your link, while the waitlist
 * page is open in a background tab. No push service and no service worker: the page's own
 * poll (`referral-tracker.tsx`, once a minute while hidden) is what notices the friend, so
 * a closed page notifies nobody — the opt-in copy says as much.
 *
 * Notifications never name the friend (the page never knows who they are) and never name
 * the product. Everything here is guarded: the API is missing on iOS Safari outside
 * installed web apps, and a constructor can throw where notifications are blocked.
 *
 * No React, no aliases: safe to import from anywhere.
 */
import { SPOTS_PER_REFERRAL, formatTicketNumber, type ReferralTier } from "./interest-list";

const ASKED_KEY = "waitlist-notify-asked";

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyState(): NotificationPermission | "unsupported" {
  if (!notifySupported()) return "unsupported";
  try {
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

/** Whether to offer the opt-in: supported, undecided, and not already declined here. */
export function shouldOfferNotify(): boolean {
  if (notifyState() !== "default") return false;
  try {
    return window.localStorage.getItem(ASKED_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Asks for permission. Call it from a click — browsers ignore a request without one. */
export async function requestNotify(): Promise<NotificationPermission | "unsupported"> {
  if (!notifySupported()) return "unsupported";
  try {
    window.localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // The browser remembers a denial on its own; this only hides our button sooner.
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return notifyState();
  }
}

/** The notification's text, for a join that moved you to `position` (and maybe a tier). */
export function joinNotification(gained: number, position: number, tier: ReferralTier | null) {
  const title = gained === 1 ? "A friend joined through your link" : `${gained} friends joined through your link`;
  let body = `You moved up ${gained * SPOTS_PER_REFERRAL} spots — you're now #${formatTicketNumber(position)}.`;
  if (tier) body += ` ${tier.label} unlocked.`;
  return { title, body };
}

/** Shows the notification, only while the tab is in the background and permission stands. */
export function notifyJoin(gained: number, position: number, tier: ReferralTier | null) {
  if (gained <= 0 || typeof document === "undefined" || !document.hidden) return;
  if (notifyState() !== "granted") return;
  const { title, body } = joinNotification(gained, position, tier);
  try {
    const n = new Notification(title, { body, icon: "/waitlist/icon.png", tag: "waitlist-join" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Constructor not allowed here (some browsers want a service worker). The tab badge
    // still says it.
  }
}
