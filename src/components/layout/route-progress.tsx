"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  PROGRESS_TIMEOUT_MS,
  ROUTE_PROGRESS_COMPLETE_MS,
  hasArrived,
  shouldTrackNavigation,
  type NavigationTarget,
} from "@/lib/route-progress";

/**
 * Lets code-driven navigation (`router.push`) opt into the bar, since there is no anchor
 * click for the observer to see. Dispatched on `window` rather than through React context so
 * a caller anywhere — including one outside this tree — can use it without a provider.
 */
const BEGIN_EVENT = "orbit:route-progress";

export function beginRouteProgress() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BEGIN_EVENT));
}

/**
 * A thin progress bar across the top of the window while a route transition is in flight.
 *
 * ## The gap it fills
 *
 * Clicking a link produced no feedback whatsoever until the new route committed. Measured on
 * this app's own sidebar routes (warm dev server, no throttling): 296-896ms, median 533.
 * Nothing moved in that window — not the link, not the sidebar's active state, not the page.
 * The app looked like it had ignored the click, which is exactly when people click again.
 *
 * `loading.tsx` does not cover this. It is nearly complete across this app and still only
 * helps AFTER the router has the new segment's payload; the wait for that payload is the
 * silent part.
 *
 * ## Why the bar is driven by the DOM rather than by React state
 *
 * The first version kept `progress` in state and advanced it on a rAF loop. It never worked,
 * for a reason worth keeping: the moment this bar most needs to be moving is the moment
 * React is busy rendering the route it is reporting on. Measured — a `setTimeout` at 150ms
 * fires on time, but React does not paint the resulting state update until the transition
 * commits, 331-784ms later. The bar only ever appeared at the very end, when it had nothing
 * left to say.
 *
 * So the element is mounted once and never re-rendered. A navigation flips one `data-`
 * attribute on it, directly, from the capture-phase click handler that runs BEFORE React
 * starts the transition; the crawl itself is a compositor-driven `scaleX` animation (see
 * `globals.css`) that keeps running through the 56-227ms long tasks measured during these
 * same transitions. React's only job here is to notice when the route has arrived.
 *
 * ## Why it watches the document
 *
 * See `@/lib/route-progress` — Next exposes no global navigation-pending signal, and the
 * per-link hook it does expose would have to be threaded through every link in the app.
 */
function RouteProgressBar() {
  const pathname = usePathname();

  const barRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<NavigationTarget | null>(null);
  const activeRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  /** The route React has actually rendered, as of the last commit effect below. */
  const renderedRef = useRef<NavigationTarget | null>(null);
  const pollRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    if (pollRef.current !== null) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  /** Back to nothing: no attribute, no pending timers, no destination being waited on. */
  const reset = useCallback(() => {
    clearTimers();
    activeRef.current = false;
    targetRef.current = null;
    barRef.current?.removeAttribute("data-route-progress");
  }, [clearTimers]);

  /** Run to 100% and fade, then clear. The bar's only ending that reads as success. */
  const finish = useCallback(() => {
    clearTimers();
    activeRef.current = false;
    targetRef.current = null;
    barRef.current?.setAttribute("data-route-progress", "done");
    timersRef.current.push(
      window.setTimeout(
        () => barRef.current?.removeAttribute("data-route-progress"),
        ROUTE_PROGRESS_COMPLETE_MS
      )
    );
  }, [clearTimers]);

  const begin = useCallback(
    (target: NavigationTarget | null) => {
      const bar = barRef.current;
      if (!bar) return;
      clearTimers();
      targetRef.current = target;
      activeRef.current = true;

      // Restart the animation even if one is already running — a second click while the
      // first navigation is still in flight should start the crawl over, not continue a
      // curve that is already most of the way along.
      bar.removeAttribute("data-route-progress");
      void bar.offsetWidth; // force a style recalculation so the animation actually restarts
      bar.setAttribute("data-route-progress", "running");

      // Always ends. A tracked click can redirect, be cancelled, or hit a guard that throws,
      // and none of those produce the arrival the completion effect waits for. A bar that
      // never finishes is a worse lie than one that finishes early.
      timersRef.current.push(window.setTimeout(reset, PROGRESS_TIMEOUT_MS));

      // Watch the address bar as well as React's committed route.
      //
      // `usePathname` alone cannot see a navigation that changes only the query string —
      // /contacts to /contacts?q=ada, which is how the A-Z rail and the contacts search both
      // move — because the path never changes and the effect never re-runs. The obvious fix,
      // `useSearchParams`, cannot be used here: this component is mounted in the ROOT layout,
      // and calling that hook there hangs the marketing route's compile outright (measured:
      // the landing page returns in 3.8s without it and never returns with it, Suspense
      // boundary notwithstanding).
      //
      // So the query half is read from `location` instead. Runs only while a navigation is in
      // flight and stops the moment it lands, so it costs a few hundred milliseconds of
      // polling per navigation and nothing at rest.
      if (target !== null) {
        const poll = window.setInterval(() => {
          if (!activeRef.current) return;
          const now = { pathname: window.location.pathname, search: window.location.search };
          if (hasArrived(target, now)) {
            clearInterval(poll);
            finish();
          }
        }, 50);
        pollRef.current = poll;
      }

      // Back and forward can be finished before they are noticed.
      //
      // Next registers its own popstate handler on `window`, and it runs before this one:
      // it updates the router synchronously, React commits, and the commit effect below has
      // already run and found nothing active by the time `begin` is called. Measured — the
      // bar went to "running" on back and stayed there until the 20s timeout.
      //
      // So for a targetless begin, check on the next tick whether the route React has
      // rendered already matches the address bar. If it does, the navigation is over and the
      // bar should close rather than crawl for twenty seconds.
      if (target === null) {
        timersRef.current.push(
          window.setTimeout(() => {
            const rendered = renderedRef.current;
            if (!activeRef.current || !rendered) return;
            const now = {
              pathname: window.location.pathname,
              search: window.location.search,
            };
            if (hasArrived(rendered, now)) finish();
          }, 0)
        );
      }
    },
    [clearTimers, finish, reset]
  );

  // -------------------------------------------------------------- what starts the bar
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const decision = shouldTrackNavigation(
        event,
        {
          href: anchor.getAttribute("href") ?? "",
          target: anchor.getAttribute("target"),
          hasDownload: anchor.hasAttribute("download"),
          rel: anchor.getAttribute("rel"),
        },
        window.location.origin,
        { pathname: window.location.pathname, search: window.location.search }
      );
      if (decision.track) begin(decision.target);
    };

    // Capture phase, and this is not a detail — a bubble-phase listener on `document` never
    // fires for a real navigation at all.
    //
    // React attaches its handlers to the root container, which is INSIDE `document`, so
    // Next's `<Link>` onClick has already run by the time a bubbling event reaches here. It
    // calls preventDefault on every click it handles, so `defaultPrevented` is true for
    // exactly the clicks that ARE navigations. Measured on this app: the same click reads
    // `defaultPrevented: false` at capture@document and `true` at bubble@document. The first
    // version listened on the bubble and therefore refused every single navigation — the
    // browser check caught it, no unit test could have.
    //
    // The cost of capturing is that a component which preventDefaults an `<a href>` to do
    // something other than navigate has not run yet, so its click is tracked. Both anchors
    // in this app that do that are safe: the landing header's logo link is refused by the
    // "already here" rule, and the people-list tabs preventDefault only to navigate by
    // router instead — which arrives at the same href and clears the bar normally.
    // PROGRESS_TIMEOUT_MS bounds anything added later that is neither.
    document.addEventListener("click", onClick, true);

    // Back and forward have no anchor, and no destination to compare against — the URL
    // changes before React re-renders — so these are tracked with a null target, which the
    // completion effect treats as "any commit ends it".
    const onPopState = () => begin(null);
    window.addEventListener("popstate", onPopState);

    const onBegin = () => begin(null);
    window.addEventListener(BEGIN_EVENT, onBegin);

    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(BEGIN_EVENT, onBegin);
    };
  }, [begin]);

  // --------------------------------------------------------------- what ends the bar
  //
  // `usePathname` updates when the transition lands, which is precisely the moment the user
  // can see the new page — so this is the real end of the wait rather than an approximation
  // of it. This is the one thing React is still needed for; the query half comes from the
  // poll in `begin`, for the reason documented there.
  useEffect(() => {
    const current = { pathname, search: "" };
    // Recorded on every commit, including the ones that happen before a popstate `begin`
    // has had a chance to run — that is what makes the catch-up above possible.
    renderedRef.current = current;

    if (!activeRef.current) return;

    const target = targetRef.current;
    // A null target is a popstate or a programmatic begin: any commit ends it.
    if (target !== null && !hasArrived(target, current)) return;

    finish();
  }, [pathname, finish]);

  useEffect(() => clearTimers, [clearTimers]);

  return (
    // Always mounted, so a navigation never has to wait for React to create it — and
    // aria-hidden, because Next already ships a route announcer that reads the new page's
    // title on every navigation. A second live region here would talk over it.
    <div
      ref={barRef}
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
    >
      <div className="route-progress-fill h-full w-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
    </div>
  );
}

/**
 * No Suspense boundary, because there is nothing here that suspends any more.
 *
 * An earlier version read `useSearchParams`, which does force a client-render bailout — and
 * in the root layout, where this is mounted, it did worse than that: the marketing route
 * stopped compiling entirely. `usePathname` carries no such cost.
 */
export function RouteProgress() {
  return <RouteProgressBar />;
}
