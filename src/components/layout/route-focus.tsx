"use client";

import { useEffect } from "react";

/** Only navigations move focus; the first page load leaves it where the browser puts it. */
let firstLoad = true;

/**
 * Where keyboard focus goes after a client-side navigation.
 *
 * `(app)/template.tsx` remounts the page on every navigation, so a link clicked inside the
 * page is destroyed with it and focus falls back to <body>: the next Tab started from the top
 * of the document again. When that happens, focus moves to the new page's heading (or the
 * content landmark), without scrolling. A link in the sidebar or the bottom nav survives the
 * navigation and keeps its focus, so it is left alone. The page name itself is announced by
 * Next's route announcer, from the page title.
 */
export function RouteFocus() {
  useEffect(() => {
    if (firstLoad) {
      firstLoad = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const main = document.getElementById("main-content");
      const target = main?.querySelector<HTMLElement>("h1") ?? main;
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return null;
}
