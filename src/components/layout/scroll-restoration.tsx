"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { consumeTraversal, markTraversal, scrollKeySearch, scrollStorageKey, shouldRestoreScroll } from "@/lib/scroll-restore";

const MAIN_SCROLL_ID = "app-main-scroll";

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

    // Read and write the same URL's key; the old page's listener is already gone, so the
    // reset below can only record into this page's slot.
    const key = scrollStorageKey(pathname, searchKey);
    const restore = shouldRestoreScroll(pathname, consumeTraversal());
    const saved = restore ? sessionStorage.getItem(key) : null;
    main.scrollTop = saved ? Number(saved) || 0 : 0;

    // Always record on /contacts, so a later back/forward has an offset to resume.
    if (pathname !== "/contacts") return;
    const handleScroll = () => {
      sessionStorage.setItem(key, String(main.scrollTop));
    };
    main.addEventListener("scroll", handleScroll, { passive: true });
    return () => main.removeEventListener("scroll", handleScroll);
  }, [pathname, searchKey]);

  return null;
}
