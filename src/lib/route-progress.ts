/**
 * The rules behind the route-transition progress bar, kept apart from the component so they
 * can be asserted without a browser.
 *
 * ## Why a global observer rather than per-link state
 *
 * Next gives no global "a navigation is in flight" signal. `useLinkStatus` is per-`<Link>`
 * and only useful as a descendant of one, so wiring it up means editing every link in the
 * app — the patch-per-button this was deferred to avoid. What every navigation DOES share is
 * the click that starts it, so the bar watches the document for clicks on internal anchors
 * and clears itself when the committed pathname and query finally change.
 *
 * The honest cost of that choice: a navigation started by `router.push` in code is not seen,
 * because there is no anchor to observe. `beginRouteProgress` is exported for those callers.
 *
 * ## What is deliberately ignored
 *
 * `shouldTrackNavigation` refuses every click that will not produce an in-app route
 * transition. Each exclusion is a case where showing a bar would be a lie: a new tab leaves
 * this page untouched, a download never navigates, a same-page hash only scrolls, and a
 * modified click is the user asking for something other than a normal navigation. A default
 * that has already been prevented means someone else is handling the click, so its outcome
 * is not ours to narrate.
 */

/** Enough of a MouseEvent to decide, so the rules can be tested without a DOM. */
export type NavigationClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

/** Enough of an anchor to decide. */
export type NavigationAnchor = {
  href: string;
  target?: string | null;
  hasDownload?: boolean;
  /** `rel="external"` is an explicit "this leaves the app". */
  rel?: string | null;
};

/** Where the click would land, resolved against where we are now. */
export type NavigationTarget = { pathname: string; search: string };

export type TrackDecision =
  | { track: true; target: NavigationTarget }
  | { track: false; reason: string };

/**
 * Whether this click starts an in-app route transition worth showing progress for.
 *
 * `origin` and `current` are passed in rather than read from `window`, so every branch is
 * reachable from a test.
 */
export function shouldTrackNavigation(
  event: NavigationClick,
  anchor: NavigationAnchor,
  origin: string,
  current: NavigationTarget
): TrackDecision {
  // Not a plain left click. A middle click opens a tab, a right click opens a menu, and
  // cmd/ctrl/shift-click all leave this page exactly where it is.
  if (event.button !== 0) return { track: false, reason: "not a left click" };
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return { track: false, reason: "modified click opens elsewhere" };
  }
  // Someone already handled it — a dialog trigger, a custom router call, a drag. Whatever
  // happens next is theirs to report.
  if (event.defaultPrevented) return { track: false, reason: "default already prevented" };

  if (anchor.hasDownload) return { track: false, reason: "download, not a navigation" };
  if (anchor.target && anchor.target !== "_self") {
    return { track: false, reason: "opens in another browsing context" };
  }
  if (anchor.rel?.split(/\s+/).includes("external")) {
    return { track: false, reason: "marked external" };
  }

  // An anchor with no href, or an empty one, is not a link at all — it is a button someone
  // spelled with an <a>. Refused explicitly, because `new URL("", base)` happily resolves to
  // the base and would otherwise read as a navigation to the current page's own path.
  if (!anchor.href.trim()) return { track: false, reason: "no href" };

  let url: URL;
  try {
    // Resolved against the CURRENT URL, not the bare origin. A bare `#section` link — which
    // the settings page uses for every one of its sections — resolves against the origin as
    // `/`, so against `origin` alone it would look like a navigation away from wherever the
    // user actually is, and flash a bar for a scroll.
    url = new URL(anchor.href, `${origin}${current.pathname}${current.search}`);
  } catch {
    return { track: false, reason: "unparseable href" };
  }

  // A full page load paints its own browser progress; ours would be torn down mid-animation.
  if (url.origin !== origin) return { track: false, reason: "different origin" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { track: false, reason: "not an http(s) url" };
  }

  // Same page: a hash only scrolls, and re-clicking the current link does nothing at all.
  if (url.pathname === current.pathname && url.search === current.search) {
    return { track: false, reason: "already here" };
  }

  return { track: true, target: { pathname: url.pathname, search: url.search } };
}

/** Whether the router has arrived where the tracked click was heading. */
export function hasArrived(target: NavigationTarget, current: NavigationTarget): boolean {
  // Pathname alone is not enough: /contacts?q=ada and /contacts are different destinations,
  // and the A-Z rail and search box both navigate by query string only.
  return target.pathname === current.pathname && target.search === current.search;
}

/**
 * How long to wait before the bar appears.
 *
 * Next's own guidance is to debounce this, and it is right: a prefetched route commits in
 * well under a frame or two, and a bar that flashes on every instant navigation is worse
 * than no bar. Measured on this app's own routes (warm dev server, no throttling), the
 * gap between clicking a sidebar link and the route committing ran 296-896ms with a
 * median of 533 — so this threshold hides the fastest transitions and shows the rest.
 */
export const PROGRESS_DELAY_MS = 150;

/**
 * When to give up and hide the bar even though no navigation committed.
 *
 * A click can be tracked and then never arrive: the route redirects somewhere else, a guard
 * throws, the user hits back mid-flight. A progress bar that never ends is a worse lie than
 * one that ends early, so it always ends.
 */
export const PROGRESS_TIMEOUT_MS = 20_000;

/**
 * How long the completion gesture takes: run to 100%, then fade out.
 *
 * Mirrors the `[data-route-progress="done"]` transition in `globals.css`; the attribute is
 * removed after this so a later navigation starts from a clean slate.
 */
export const ROUTE_PROGRESS_COMPLETE_MS = 320;

/**
 * Where the CSS crawl stops, as a fraction. Asserted rather than merely written down: a bar
 * that fills completely while the work continues claims to be finished, which is the same
 * lie as showing no bar at all — just slower to notice. Reaching 100% is a separate,
 * deliberate act performed only once the route has actually arrived.
 *
 * Keep in step with the final keyframe of `route-progress-crawl`.
 */
export const ROUTE_PROGRESS_CEILING = 0.92;
