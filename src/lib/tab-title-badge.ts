/**
 * "(+2) Early access — …" in the tab title while the waitlist tab is in the background and
 * friends join through the visitor's link, so the news reaches them in another tab. The
 * badge clears shortly after the tab is shown again, once the pass has had a moment to
 * celebrate on screen — the badge pointed at that, so it should not vanish before it plays.
 *
 * Only while hidden: a visible tab gets the on-page celebration instead. No React, no
 * aliases; a no-op outside the browser.
 */
const CLEAR_AFTER_MS = 1500;

let count = 0;
let base: string | null = null;
let clearTimer = 0;
let listening = false;

function render() {
  if (base === null) return;
  document.title = count > 0 ? `(+${count}) ${base}` : base;
}

function onVisibility() {
  if (document.visibilityState !== "visible" || count === 0) return;
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    count = 0;
    render();
  }, CLEAR_AFTER_MS);
}

/** Adds `friends` to the badge, if the tab is currently hidden. */
export function bumpTitleBadge(friends: number) {
  if (typeof document === "undefined" || friends <= 0 || !document.hidden) return;
  if (!listening) {
    document.addEventListener("visibilitychange", onVisibility);
    listening = true;
  }
  window.clearTimeout(clearTimer);
  if (count === 0) base = document.title;
  count += friends;
  render();
}
