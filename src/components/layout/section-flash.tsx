"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Briefly glows the element named by the URL hash.
 *
 * Following an account alert drops the reader onto a long page of near-identical cards
 * with nothing to say which one they were sent to. The glow answers that and gets out of
 * the way. Mounted once in the app layout rather than per page, so any `#id` on any route
 * gets it for free — the alert only has to name a target.
 *
 * Driven from the DOM rather than by threading state through each page: the targets are
 * server-rendered cards scattered across several routes, and the alternative is making
 * every one of them a client component to receive a prop that is almost always false.
 *
 * Three things about that are fussier than they look, and all three were got wrong first:
 *
 *  1. It marks the target with a DATA ATTRIBUTE, not a class. React owns `className` on
 *     these elements and rewrites it on hydration, which silently stripped the class again
 *     a frame after it was added.
 *  2. It RETRIES for a short window. The effect can run before the target exists — on
 *     `/imports` the card may be inside a tab panel that has not mounted yet — and a
 *     single attempt that finds nothing has no second chance.
 *  3. It uses timers, NOT `requestAnimationFrame`, which does not fire at all in a hidden
 *     document. A page restored into a background tab would otherwise never glow.
 *  4. It re-runs on every PATHNAME change, not just on mount. This is mounted in the app
 *     layout, and a client-side route change does not remount a layout — nor does it fire
 *     `hashchange`, because Next pushes state rather than navigating a fragment. Without
 *     the dependency this fires exactly once per full page load and never again, which
 *     means never at all for the case it exists to serve: clicking an alert.
 */
const FLASH_ATTR = "data-section-flash";

/**
 * Fired by anything that navigates to a target on purpose (the account alerts do).
 *
 * Route/hash changes cover most arrivals, but not all of them: clicking an alert whose
 * card is on the page you are already looking at changes neither the pathname nor the
 * hash, so nothing re-arms and the card never glows. Naming the target explicitly also
 * sidesteps a race — the handler does not have to guess whether `location.hash` has been
 * updated yet by the time it runs.
 */
const FLASH_EVENT = "orbit:flash-section";

/** Ask for `id` to glow, whether or not navigating there changes the URL. */
export function flashSection(id: string) {
  if (typeof window === "undefined" || !id) return;
  window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { id } }));
}

/** Must outlast the CSS animation, which is the same duration. */
const FLASH_MS = 1600;

/** How long to keep looking for the target before giving up. */
const RESOLVE_TIMEOUT_MS = 2000;

/** Gap between attempts while waiting for it to render. */
const RETRY_INTERVAL_MS = 32;

export function SectionFlash() {
  const pathname = usePathname();

  useEffect(() => {
    let retry = 0;
    let timer = 0;
    let deadline = 0;
    let flashed: HTMLElement | null = null;

    function clear() {
      if (flashed) {
        flashed.removeAttribute(FLASH_ATTR);
        flashed = null;
      }
    }

    let requested: string | null = null;

    function attempt() {
      const id = requested ?? window.location.hash.slice(1);
      if (!id) return;

      const el = document.getElementById(id);
      // `offsetParent === null` catches a target inside a `hidden` tab panel: it exists but
      // is not on screen yet, so glowing it now would be wasted. Keep waiting for the tab
      // to open. (`position: fixed` elements also report null, but no flash target is one.)
      if (!el || el.offsetParent === null) {
        if (performance.now() < deadline) {
          retry = window.setTimeout(attempt, RETRY_INTERVAL_MS);
        }
        return;
      }

      clear();
      // Remove-reflow-set, so arriving at the same target twice restarts the animation
      // rather than doing nothing because the attribute is already there.
      el.removeAttribute(FLASH_ATTR);
      void el.offsetWidth;
      el.setAttribute(FLASH_ATTR, "on");
      flashed = el;

      window.clearTimeout(timer);
      timer = window.setTimeout(clear, FLASH_MS);
    }

    function start(id?: string) {
      requested = id ?? null;
      window.clearTimeout(retry);
      deadline = performance.now() + RESOLVE_TIMEOUT_MS;
      retry = window.setTimeout(attempt, RETRY_INTERVAL_MS);
    }

    function onRequest(e: Event) {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) start(id);
    }

    // Wrapped rather than passed straight in: `start` takes an optional id, and handing it
    // to an event listener would pass the Event object as that id.
    function onHashChange() {
      start();
    }

    start();
    window.addEventListener(FLASH_EVENT, onRequest);
    // Covers moving between targets by hash while already on the page, where this never
    // remounts.
    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(FLASH_EVENT, onRequest);
      clear();
    };
    // `pathname` so arriving on a new route re-arms this; `hashchange` inside covers
    // moving between targets without leaving the page.
  }, [pathname]);

  return null;
}
