/**
 * The feedback dock's geometry and its session memory. Pure, no imports beyond a type, so
 * `scripts/smoke-feedback-dock.ts` can run it without a DOM.
 *
 * The dock is a column on the right that the page gives up room for (`--orbit-dock-w`,
 * theme.css) rather than an overlay. Whether there is room for it is decided here, from
 * the viewport width alone:
 *
 *   phone    < 768   no room at all: a full-width sheet over the page, closed by its control.
 *   overlay  < 1280  room for the panel but not for the page beside it (the 17rem sidebar
 *                    leaves the page under ~36rem): it floats over the right edge, BELOW the
 *                    bell and the feedback button, and nothing is squeezed.
 *   dock     >= 1280 the page narrows by `reservePx`.
 *
 * The 1280 line is the sidebar (272px) + a page that keeps >= 36rem + the narrower dock.
 */

/** Clear space on each side of the panel inside the reserved column. */
export const DOCK_GUTTER_PX = 12;
export const DOCK_MIN_VIEWPORT_PX = 1280;
const PHONE_MAX_PX = 768;
const WIDE_VIEWPORT_PX = 1440;
/** 22rem, and 24.5rem from `WIDE_VIEWPORT_PX` up. */
const PANEL_NARROW_PX = 352;
const PANEL_WIDE_PX = 392;

export type DockMode = "phone" | "overlay" | "dock";

export type DockLayout = {
  mode: DockMode;
  /** The panel's own width; null on a phone, where it is the whole screen. */
  panelPx: number | null;
  /** How far the page narrows (`--orbit-dock-w`). 0 unless docked. */
  squeezePx: number;
  /** How far the toast column and job stack move left (`useCornerShift`). */
  shiftPx: number;
};

export function dockLayoutFor(viewportWidth: number): DockLayout {
  if (viewportWidth < PHONE_MAX_PX) {
    return { mode: "phone", panelPx: null, squeezePx: 0, shiftPx: 0 };
  }
  if (viewportWidth < DOCK_MIN_VIEWPORT_PX) {
    // Never wider than the screen less its two gutters (a 768px tablet has room for 352).
    const panelPx = Math.min(PANEL_NARROW_PX, viewportWidth - DOCK_GUTTER_PX * 2);
    return { mode: "overlay", panelPx, squeezePx: 0, shiftPx: panelPx + DOCK_GUTTER_PX };
  }
  const panelPx = viewportWidth >= WIDE_VIEWPORT_PX ? PANEL_WIDE_PX : PANEL_NARROW_PX;
  const reservePx = panelPx + DOCK_GUTTER_PX * 2;
  return { mode: "dock", panelPx, squeezePx: reservePx, shiftPx: reservePx };
}

/** Where the panel was, so a reload inside the same tab puts it back. sessionStorage. */
export const DOCK_SESSION_KEY = "orbit.feedback.dock";

export type DockSessionView =
  | { view: "compose" }
  | { view: "list" }
  | { view: "thread"; id: string };

export function serializeDockSession(view: DockSessionView): string {
  return JSON.stringify({ v: 1, ...view });
}

/**
 * Anything unreadable is "closed": the storage is user-editable and survives deploys, so a
 * stale or hand-mangled value must never open a panel on a view that doesn't exist.
 */
export function parseDockSession(raw: string | null | undefined): DockSessionView | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, view, id } = value as Record<string, unknown>;
  if (v !== 1) return null;
  if (view === "compose" || view === "list") return { view };
  if (view === "thread" && typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { view, id };
  }
  return null;
}
