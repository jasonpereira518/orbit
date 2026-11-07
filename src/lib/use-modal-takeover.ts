"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Make a hand-built full-screen moment (the plan celebration, the credits intro) behave as a
 * modal dialog for keyboard and screen-reader users, the way Base UI's Dialog does for the
 * ordinary ones:
 *
 * - Everything outside it is `inert` while it is mounted: not focusable, not clickable, and
 *   gone from the accessibility tree. Without this, Tab walked out of the overlay onto
 *   controls hidden underneath it, and a screen reader could read the page behind.
 * - Tab and Shift+Tab cycle through the overlay's own controls. While it has none (the
 *   animation before its Continue button appears), focus stays on the overlay itself.
 *
 * Inert is applied to the siblings of every ancestor from the overlay up to <body>, so it
 * works whether the overlay is portalled to <body> or rendered inside the app tree. Only
 * elements this hook made inert are restored when it unmounts.
 */
export function useModalTakeover(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const madeInert: HTMLElement[] = [];
    for (let node: HTMLElement = root; node.parentElement; node = node.parentElement) {
      const parent = node.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue;
        if (sibling.inert || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
        sibling.inert = true;
        madeInert.push(sibling);
      }
      if (parent === document.body) break;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const el of madeInert) el.inert = false;
    };
  }, [rootRef]);
}
