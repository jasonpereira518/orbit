/**
 * Whether the chat history rail is open — a per-browser preference, kept across visits.
 *
 * Shared by the panel and by its loading placeholder, so the placeholder holds the same space
 * the rail will: a sidebar that appears (or vanishes) the moment the panel finishes loading
 * reads as it having been closed and reopened.
 */
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
