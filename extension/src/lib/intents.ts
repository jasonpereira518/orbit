/**
 * Hand-off from the background worker to the panel: "the user just asked Orbit
 * to look at this tab."
 *
 * Why this exists: the toolbar click is the only gesture that grants the
 * extension a tab (`activeTab`). Measured on Chrome 153 (see
 * extension/docs/permission-spike.md): with `openPanelOnActionClick: true`
 * Chrome opens the panel itself and grants NOTHING — the panel can see a tab
 * exists and no more, which is why every site used to start behind a grant
 * wall. With the worker handling the click and calling `sidePanel.open()`
 * itself, the same click grants that tab.
 *
 * That leaves one gap: a click while the panel is ALREADY open grants the tab
 * but changes nothing the panel can observe — same tab, maybe the same URL, no
 * event. So the worker records the click here, and the panel re-reads.
 *
 * `chrome.storage.session` rather than runtime messaging: on the first open the
 * panel page doesn't exist yet when the worker writes, and a worker message to
 * a page that isn't there is simply lost. Session storage lives in memory,
 * survives the worker being torn down, and is gone when the browser closes.
 */

export const INTENT_KEY = "orbit:intent";

/** How long a click stays actionable. Older ones describe a moment that's gone. */
export const INTENT_TTL_MS = 10_000;

export type Intent = {
  /** Unique per click, so the same click is never acted on twice. */
  id: string;
  /** When the click happened (ms since epoch). */
  at: number;
  kind: "action";
  tabId: number;
  windowId: number;
};

export function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.at === "number" &&
    v.kind === "action" &&
    typeof v.tabId === "number" &&
    typeof v.windowId === "number"
  );
}

/**
 * Should THIS panel act on this intent?
 *
 * - never twice (the mount read and the change event can both see one click)
 * - never stale (a panel opened a minute later must not re-run an old click)
 * - never another window's: each window has its own panel, and a click in
 *   window 2 is not a reason for window 1's panel to re-read its tab
 */
export function shouldAccept(
  value: unknown,
  context: { now: number; windowId: number | null; lastAcceptedId: string | null }
): value is Intent {
  if (!isIntent(value)) return false;
  if (value.id === context.lastAcceptedId) return false;
  if (context.now - value.at > INTENT_TTL_MS) return false;
  if (value.at - context.now > INTENT_TTL_MS) return false; // clock skew guard
  if (context.windowId !== null && value.windowId !== context.windowId) return false;
  return true;
}

/**
 * What identifies "the thing the panel is showing": which tab, at which URL.
 *
 * The panel used to follow the tab by URL alone and skip any tab whose URL it
 * couldn't see. Under activeTab that is most tabs — so switching to an
 * unclicked tab left the PREVIOUS person on screen beside a page about someone
 * else. Keying on the tab too means an unreadable tab is still a change.
 */
export function targetKey(tab: { id?: number; url?: string } | undefined): string | null {
  if (!tab || tab.id === undefined) return null;
  return `${tab.id}|${tab.url ?? ""}`;
}
