"use client";

import { useEffect } from "react";

/**
 * Only navigations move focus; the first page load leaves it where the browser puts it.
 * Flipped inside the frame callback rather than the effect body: Strict Mode runs the effect
 * twice on mount, and a flag spent by the discarded first run let the second one steal focus
 * from the skip link on a fresh load.
 */
let firstLoad = true;

/**
 * Where keyboard focus goes after a client-side navigation.
 *
 * `(app)/template.tsx` remounts the page on every navigation, so a link clicked inside the
 * page is destroyed with it and focus falls back to <body>: the next Tab started from the top
 * of the document again. When that happens, focus moves to the new page's content landmark
 * (`#main-content`, which renders its own tabIndex={-1}), without scrolling. A link in the
 * sidebar or the bottom nav survives the navigation and keeps its focus, so it is left alone.
 * The page name itself is announced by Next's route announcer, from the page title.
 *
 * Never the page's <h1>: giving it a tabindex here mutated markup React was still hydrating
 * (the page streams in after this effect runs) and broke hydration.
 */
export function RouteFocus() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (firstLoad) {
        firstLoad = false;
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return null;
}
