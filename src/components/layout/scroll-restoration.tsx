"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { consumeTraversal, markTraversal, scrollKeySearch, shouldRestoreScroll } from "@/lib/scroll-restore";

const MAIN_SCROLL_ID = "app-main-scroll";
const RESTORE_KEY_PREFIX = "orbit:scroll:";

if (typeof window !== "undefined") {
  window.addEventListener("popstate", markTraversal);
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
  // Keyed too, so a query-only change on /contacts goes back to the top.
  const searchKey = scrollKeySearch(pathname, useSearchParams().toString());

  useEffect(() => {
    const main = document.getElementById(MAIN_SCROLL_ID);
    if (!main) return;

    const restore = shouldRestoreScroll(pathname, consumeTraversal());
    const saved = restore ? sessionStorage.getItem(RESTORE_KEY_PREFIX + pathname) : null;
    main.scrollTop = saved ? Number(saved) || 0 : 0;

    // Always record on /contacts, so a later back/forward has an offset to resume.
    if (pathname !== "/contacts") return;
    const handleScroll = () => {
      sessionStorage.setItem(RESTORE_KEY_PREFIX + pathname, String(main.scrollTop));
    };
    main.addEventListener("scroll", handleScroll, { passive: true });
    return () => main.removeEventListener("scroll", handleScroll);
  }, [pathname, searchKey]);

  return null;
}
