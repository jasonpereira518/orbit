"use client";

import {
  getDesktopNotifiedIds,
  markDesktopNotificationsSent,
  mergeDesktopNotifiedIds,
} from "@/actions/notifications";

const PREF_KEY = "orbit:desktop-notifications";
const SENT_KEY = "orbit:notified-ids";
const SW_PATH = "/orbit-sw.js";
const MAX_NOTIFIED_IDS = 200;

export type NotificationPermissionState =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

export function getNotificationSupport(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission as "default" | "granted" | "denied";
}

export function isDesktopNotificationsPreferred() {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(PREF_KEY) === "1";
}

export function setDesktopNotificationsPreferred(enabled: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PREF_KEY, enabled ? "1" : "0");
  window.dispatchEvent(
    new CustomEvent("orbit:desktop-notifications-change", {
      detail: { enabled },
    })
  );
}

let sentIds = new Set<string>();
let hydratePromise: Promise<void> | null = null;

function readLocalSentIds(): string[] {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function writeLocalSentIds(ids: string[]) {
  try {
    localStorage.setItem(
      SENT_KEY,
      JSON.stringify(ids.slice(-MAX_NOTIFIED_IDS))
    );
  } catch {
    // ignore quota / private mode
  }
}

/**
 * Load delivered notification ids from the account DB (and migrate any
 * leftover localStorage ids once). Safe to call repeatedly.
 */
export function hydrateDesktopNotifiedIds(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    const local = readLocalSentIds();
    try {
      const fromDb = await getDesktopNotifiedIds();
      const merged = [...new Set([...fromDb, ...local])].slice(
        -MAX_NOTIFIED_IDS
      );
      sentIds = new Set(merged);

      const needsMerge = local.some((id) => !fromDb.includes(id));
      if (needsMerge) {
        await mergeDesktopNotifiedIds(merged);
      }
      if (local.length > 0) {
        localStorage.removeItem(SENT_KEY);
      }
    } catch {
      sentIds = new Set(local);
    }
  })();

  return hydratePromise;
}

function markSent(id: string) {
  sentIds.add(id);
  const trimmed = [...sentIds].slice(-MAX_NOTIFIED_IDS);
  sentIds = new Set(trimmed);
  // Keep a short-lived local mirror while the DB write settles.
  writeLocalSentIds(trimmed);
  void markDesktopNotificationsSent([id]).catch(() => {
    // local mirror retained for retry on next hydrate
  });
}

export function wasNotificationSent(id: string) {
  return sentIds.has(id) || readLocalSentIds().includes(id);
}

export async function ensureNotificationPermission(): Promise<
  "granted" | "denied" | "default" | "unsupported"
> {
  const state = getNotificationSupport();
  if (state === "unsupported") return "unsupported";
  if (state === "granted" || state === "denied") return state;

  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return "denied";
  }
}

export async function registerNotificationServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
    // Wait until an active worker can deliver notifications
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

export type OrbitNotificationPayload = {
  id: string;
  title: string;
  body?: string;
  url?: string;
};

function showPageNotification(
  title: string,
  options: NotificationOptions,
  url: string
) {
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    window.location.href = url;
    n.close();
  };
  return n;
}

/**
 * Shows a browser/desktop OS notification when permission is granted.
 * Dedupes by id so the same reminder does not spam.
 * Pass `{ force: true }` to skip preference / dedupe (for test notifications).
 */
export async function showDesktopNotification(
  payload: OrbitNotificationPayload,
  opts?: { force?: boolean }
): Promise<boolean> {
  const force = Boolean(opts?.force);
  if (!force && !isDesktopNotificationsPreferred()) return false;

  await hydrateDesktopNotifiedIds();
  if (!force && wasNotificationSent(payload.id)) return false;

  const permission = await ensureNotificationPermission();
  if (permission !== "granted") return false;

  const url = payload.url || "/dashboard";
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    tag: force ? `orbit-test-${Date.now()}` : payload.id,
    renotify: force,
    requireInteraction: force,
    silent: false,
    data: { url },
  };

  try {
    // Test / force: use the page Notification API first. It is tied to the
    // click gesture and is more reliable while Orbit is focused. SW delivery
    // can succeed silently under macOS Focus / quiet notification settings.
    if (force) {
      showPageNotification(payload.title, options, url);
      return true;
    }

    let delivered = false;
    if ("serviceWorker" in navigator) {
      try {
        await registerNotificationServiceWorker();
        const reg = await navigator.serviceWorker.ready;
        if (reg.active) {
          await reg.showNotification(payload.title, options);
          delivered = true;
        }
      } catch {
        // fall through to page Notification
      }
    }

    if (!delivered) {
      showPageNotification(payload.title, options, url);
    }

    markSent(payload.id);
    return true;
  } catch {
    return false;
  }
}

/** Fire a one-off notification so the user can verify OS/browser alerts work. */
export async function sendTestDesktopNotification(): Promise<{
  ok: boolean;
  permission:
    | NotificationPermissionState
    | "unsupported"
    | "default"
    | "granted"
    | "denied";
}> {
  await registerNotificationServiceWorker();
  const permission = await ensureNotificationPermission();
  if (permission !== "granted") {
    return { ok: false, permission };
  }

  const ok = await showDesktopNotification(
    {
      id: `orbit-test-${Date.now()}`,
      title: "Orbit test notification",
      body: "If you can see this, desktop alerts are working.",
      url: "/dashboard",
    },
    { force: true }
  );

  return { ok, permission };
}

/**
 * Ask for permission when undecided (e.g. after snooze). Does not show a toast itself.
 */
export async function promptNotificationsAfterFollowUpAction() {
  setDesktopNotificationsPreferred(true);
  await registerNotificationServiceWorker();
  return ensureNotificationPermission();
}
