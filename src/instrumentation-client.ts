import { markNavStart } from "@/lib/nav-timing";
import { loadSentry, reportClientError, sentryIfLoaded } from "@/lib/sentry-lazy";

/**
 * Browser-side Sentry, loaded after the page is up rather than with it.
 *
 * The SDK is ~83 KB gzipped. Initialized here at startup, it sat on every route's critical
 * path: on a cold mobile load of the landing page it competed with the render-blocking CSS
 * and the app's own chunks, and hydration landed ~5 s in (Oct 13 audit). Now it loads at the
 * first idle moment after `load`. An error before then is queued by loading Sentry at once
 * to report it, so nothing is dropped; what is given up is the pageload trace for the 10%
 * tracing sample and breadcrumbs from before init. Sentry's own handlers take over once it
 * has initialized, so these early listeners step aside.
 */
// Once Sentry is up its own global handlers report these, so the early ones go quiet.
const onEarlyError = (event: ErrorEvent) => {
  if (!sentryIfLoaded()) reportClientError(event.error ?? new Error(event.message));
};
const onEarlyRejection = (event: PromiseRejectionEvent) => {
  if (!sentryIfLoaded()) reportClientError(event.reason);
};
window.addEventListener("error", onEarlyError);
window.addEventListener("unhandledrejection", onEarlyRejection);

function start() {
  void loadSentry().then(() => {
    window.removeEventListener("error", onEarlyError);
    window.removeEventListener("unhandledrejection", onEarlyRejection);
  });
}
const startWhenIdle = () =>
  typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(start, { timeout: 5_000 })
    : window.setTimeout(start, 2_000);
if (document.readyState === "complete") startWhenIdle();
else window.addEventListener("load", startWhenIdle, { once: true });

/**
 * Every client-side navigation starts here. Page-load timing gets its clock start
 * (`src/lib/nav-timing.ts`, read back by the pageview beacon), and Sentry its breadcrumb once
 * it has loaded.
 */
export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse"
) {
  markNavStart(url);
  sentryIfLoaded()?.captureRouterTransitionStart(url, navigationType);
}
