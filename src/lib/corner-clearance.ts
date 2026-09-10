"use client";

import { useEffect, type RefObject } from "react";

/**
 * Raising the shared bottom-right corner.
 *
 * Toasts are interactive again (hover pauses, click dismisses, drag flings), so
 * they hit-test — which is exactly what `globals.css` used to disable, because a
 * toast covering the Capture review card's Accept button meant the click did
 * nothing, twice in a row, on the demo's worst possible step. These hooks are
 * what replaces that blanket fix: a page that owns this corner raises it while
 * it needs it, and the toast stack moves out of the way.
 *
 * The lift is set on `<html>` rather than on a wrapper because the toaster is
 * portalled to `<body>`, so it is not a descendant of anything a page could
 * scope a variable to.
 *
 * Both hooks write the same single `--orbit-corner-lift` slot, so two
 * simultaneous claimants would fight. Today's two — Capture's review step and
 * the constellation's full screen — cannot co-occur. If a third appears, this
 * should become a small ref-counted store taking `Math.max` of live claims.
 */

const LIFT_VAR = "--orbit-corner-lift";

/** Raise the corner by a fixed amount for as long as `px` is non-null. */
export function useCornerClearance(px: number | null) {
  useEffect(() => {
    if (px == null) return;
    const root = document.documentElement;
    root.style.setProperty(LIFT_VAR, `${px}px`);
    return () => {
      root.style.removeProperty(LIFT_VAR);
    };
  }, [px]);
}

/**
 * Raise the corner just far enough to clear the top edge of `ref`.
 *
 * For actions that are in-flow rather than corner-anchored — the Capture review
 * card's Accept row is a plain grid whose viewport position depends on the
 * card's height and the scroll offset — where no fixed number is right at every
 * viewport size. Measuring is what makes this hold in both the compact and full
 * layouts without either of them knowing about it.
 */
export function useCornerClearanceAbove(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  gap = 8
) {
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      root.style.removeProperty(LIFT_VAR);
      return;
    }

    const measure = () => {
      const el = ref.current;
      if (!el) return;
      // Distance from the viewport bottom up to the element's top edge. Clamped
      // at 0 so an element scrolled off the bottom never pulls the corner down
      // past its own baseline.
      const lift = Math.max(
        0,
        window.innerHeight - el.getBoundingClientRect().top + gap
      );
      root.style.setProperty(LIFT_VAR, `${lift}px`);
    };

    measure();

    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    // Capture phase: the review card scrolls inside its own container in the
    // compact layout, and a scroll event there does not bubble to window.
    window.addEventListener("scroll", measure, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      root.style.removeProperty(LIFT_VAR);
    };
  }, [ref, enabled, gap]);
}
