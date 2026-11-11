/**
 * Whether the chat history rail is open — a per-browser preference, kept across visits.
 *
 * Shared by the panel and by its loading placeholder, so the placeholder holds the same space
 * the rail will: a sidebar that appears (or vanishes) the moment the panel finishes loading
 * reads as it having been closed and reopened.
 */
/**
 * The rail's two widths. Here, not in the rail component, because the loading placeholder
 * needs them and is rendered by page skeletons far outside chat: importing them from the
 * component pulled the whole rail into those pages' bundles.
 * Open is wide enough for a title to wrap to two lines; closed is room for one icon button.
 */
export const RAIL_OPEN_WIDTH = 224;
export const RAIL_CLOSED_WIDTH = 48;

export const RAIL_OPEN_KEY = "orbit:chat-rail-open";

/** Open unless the person closed it: a first visit, or storage that cannot be read, gets the rail. */
export function readRailOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(RAIL_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRailOpen(open: boolean) {
  try {
    window.localStorage.setItem(RAIL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the toggle still works, it just is not remembered.
  }
}
