"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const MAIN_SCROLL_ID = "app-main-scroll";
const RESTORE_KEY_PREFIX = "orbit:scroll:";

// Only the contacts list resumes where you left off — every other route
// (including /contacts/[id] and /contacts/new) starts at the top like normal.
function isRestorablePath(pathname: string) {
  return pathname === "/contacts";
}

/**
 * `(app)/template.tsx` remounts on every navigation, so mounting this here
 * gives each nav a fresh effect run without needing to key off pathname by
 * hand. The app doesn't scroll the window (see app-shell.tsx) — the `<main>`
 * it renders is the actual scroll container, so that's what gets reset or
 * restored instead of `window.scrollTo`.
 */
export function ScrollRestoration() {
  const pathname = usePathname();

  useEffect(() => {
    const main = document.getElementById(MAIN_SCROLL_ID);
    if (!main) return;

    if (isRestorablePath(pathname)) {
      const saved = sessionStorage.getItem(RESTORE_KEY_PREFIX + pathname);
      main.scrollTop = saved ? Number(saved) || 0 : 0;

      const handleScroll = () => {
        sessionStorage.setItem(RESTORE_KEY_PREFIX + pathname, String(main.scrollTop));
      };
      main.addEventListener("scroll", handleScroll, { passive: true });
      return () => main.removeEventListener("scroll", handleScroll);
    }

    main.scrollTop = 0;
  }, [pathname]);

  return null;
}
