/**
 * Which account alerts this browser has been told to stop showing.
 *
 * Which alerts may be hidden is decided per-code by `DISMISSIBLE_CODES` in
 * `@/lib/account-alerts`, not by severity — an alert stays put when a capability is
 * unavailable and stays unavailable until this person acts (no API key, a dead mailbox
 * grant, the contact cap), and can be hidden when it is historical, advisory or
 * self-healing. `AccountAlerts` enforces that; this module just stores ids.
 *
 * A dismissal EXPIRES rather than being permanent. Alert ids are condition-derived
 * (`alert:calendar.sync_error`), not row-derived, so a permanent dismissal would mean the
 * user never hears about that *kind* of problem again — including a completely new
 * occurrence months later. Snoozing keeps the escape hatch without turning it into a
 * one-way switch.
 *
 * Browser-local, like the extension promo's dismissal in this same panel. That makes it
 * per-device, which is the honest trade for not putting a migration behind a "hide this
 * warning" button. Nothing server-side depends on it: warnings never contribute to the
 * bell's count or its dot, so a dismissal cannot desynchronise anything the server computes.
 */

const STORAGE_KEY = "orbit:dismissed-alerts:v1";

/** How long a dismissed warning stays hidden. */
export const ALERT_DISMISS_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Alert id → epoch ms at which it becomes visible again. */
type DismissalStore = Record<string, number>;

function read(): DismissalStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DismissalStore = {};
    for (const [id, expiry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof expiry === "number" && Number.isFinite(expiry)) out[id] = expiry;
    }
    return out;
  } catch {
    // Unparseable, or storage unavailable (private mode). Showing the alert is the safe
    // failure — the worst case is the user dismisses it again.
    return {};
  }
}

function write(store: DismissalStore) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or private mode. The dismissal just will not survive a reload.
  }
}

/**
 * Ids still within their snooze window, pruning any that have expired.
 *
 * Safe to call during render: it only touches `localStorage`, and the panel holds this
 * subtree back until its client-side fetch resolves, so there is no server-rendered output
 * for a mismatch to occur against.
 */
export function loadActiveDismissals(now: number = Date.now()): Set<string> {
  const store = read();
  const live: DismissalStore = {};
  let pruned = false;

  for (const [id, expiry] of Object.entries(store)) {
    if (expiry > now) live[id] = expiry;
    else pruned = true;
  }
  if (pruned) write(live);

  return new Set(Object.keys(live));
}

/** Hide `id` for `ALERT_DISMISS_DAYS`. Returns the resulting set, for immediate render. */
export function dismissAlert(
  id: string,
  now: number = Date.now()
): Set<string> {
  const store = read();
  store[id] = now + ALERT_DISMISS_DAYS * DAY_MS;
  write(store);
  return loadActiveDismissals(now);
}
