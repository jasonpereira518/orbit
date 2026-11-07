/**
 * The in-app "Reduce motion" setting (Settings → Appearance), alongside the system's
 * `prefers-reduced-motion`. Either one turns motion down; the setting exists for people who
 * want calm in Orbit without changing their whole computer, and for looping animations the
 * system setting doesn't reach (WCAG 2.2.2).
 *
 * Stored per device in localStorage, like the system preference it mirrors, and applied as
 * `html[data-motion="reduce"]` before first paint by `MOTION_PREPAINT_SCRIPT` (root layout),
 * so nothing animates for a frame before React loads. Everything reads it from here:
 *   - CSS: the global clamp in theme.css and the `motion-reduce:` / `motion-safe:` variants
 *   - JS: `prefersReducedMotion()` and `usePrefersReducedMotion()`
 *   - motion/react: `MotionPreferenceConfig` sets `reducedMotion="always"`
 */

export const REDUCE_MOTION_KEY = "orbit:reduce-motion";
export const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const CHANGE_EVENT = "orbit:motion-preference";

/** Runs during HTML parsing, ahead of every script; dependency-free on purpose. */
export const MOTION_PREPAINT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(REDUCE_MOTION_KEY)})==="1")document.documentElement.setAttribute("data-motion","reduce")}catch(e){}`;

/** The in-app setting alone (false on the server). */
export function appReducesMotion(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-motion") === "reduce";
}

/** The system preference or the in-app setting: whether to animate at all. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(REDUCE_MOTION_QUERY).matches === true || appReducesMotion();
}

export function setAppReduceMotion(on: boolean) {
  try {
    if (on) localStorage.setItem(REDUCE_MOTION_KEY, "1");
    else localStorage.removeItem(REDUCE_MOTION_KEY);
  } catch {
    // Private mode or blocked storage: it still applies until the page reloads.
  }
  if (on) document.documentElement.setAttribute("data-motion", "reduce");
  else document.documentElement.removeAttribute("data-motion");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Calls `onChange` when either the system preference or the in-app setting changes. */
export function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia?.(REDUCE_MOTION_QUERY);
  mq?.addEventListener("change", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    mq?.removeEventListener("change", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
