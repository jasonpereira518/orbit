"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  consumeTraversal,
  markTraversal,
  scrollKeySearch,
  scrollStorageKey,
  scrollTargetFits,
  shouldRestoreScroll,
} from "@/lib/scroll-restore";

const MAIN_SCROLL_ID = "app-main-scroll";
/** How long a back/forward restore waits for the list to grow tall enough. */
const RESTORE_WAIT_MS = 1500;
// A timer, not rAF: background tabs and occluded panes get no animation frames at all.
const RESTORE_POLL_MS = 50;
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

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
    const target = saved ? Number(saved) || 0 : 0;
    main.scrollTop = target;

    // Always record on /contacts, so a later back/forward has an offset to resume.
    if (pathname !== "/contacts") return;

    // On back/forward the list hasn't rendered yet, so the set above clamps (often to 0).
    // Re-apply every poll until it fits, the wait runs out, or the person scrolls. Saving is
    // off meanwhile, or the clamped offset would overwrite the one being restored.
    let settling = !scrollTargetFits(target, main.scrollHeight, main.clientHeight);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + RESTORE_WAIT_MS;
    const stopSettling = () => {
      settling = false;
      clearTimeout(timer);
    };
    const tick = () => {
      main.scrollTop = target;
      if (scrollTargetFits(target, main.scrollHeight, main.clientHeight) || performance.now() > deadline) stopSettling();
      else timer = setTimeout(tick, RESTORE_POLL_MS);
    };
    if (settling) timer = setTimeout(tick, RESTORE_POLL_MS);

    const handleScroll = () => {
      if (!settling) sessionStorage.setItem(key, String(main.scrollTop));
    };
    main.addEventListener("scroll", handleScroll, { passive: true });
    for (const type of USER_SCROLL_EVENTS) main.addEventListener(type, stopSettling, { passive: true });
    return () => {
      stopSettling();
      main.removeEventListener("scroll", handleScroll);
      for (const type of USER_SCROLL_EVENTS) main.removeEventListener(type, stopSettling);
    };
  }, [pathname, searchKey]);

  return null;
}
