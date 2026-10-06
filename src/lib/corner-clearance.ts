"use client";

import { useEffect, useId, type RefObject } from "react";

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
 * Claims are ref-counted and the corner takes the MAX of the live ones. Capture's
 * review step and the constellation's full screen never co-occur, but the guided
 * tour's coach rail can sit on the same screen as either, which is the third
 * claimant this store was always going to need.
 */

const LIFT_VAR = "--orbit-corner-lift";

const claims = new Map<string, number>();

function apply() {
  const root = document.documentElement;
  let max = 0;
  for (const px of claims.values()) if (px > max) max = px;
  if (max > 0) root.style.setProperty(LIFT_VAR, `${max}px`);
  else root.style.removeProperty(LIFT_VAR);
}

/** Set (or clear, with null) one claimant's lift. Safe to call every measurement. */
export function claimCornerLift(id: string, px: number | null) {
  if (px == null || px <= 0) claims.delete(id);
  else claims.set(id, px);
  apply();
}

/** Raise the corner by a fixed amount for as long as `px` is non-null. */
export function useCornerClearance(px: number | null) {
  const id = useId();
  useEffect(() => {
    if (px == null) return;
    claimCornerLift(id, px);
    return () => claimCornerLift(id, null);
  }, [id, px]);
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
  const id = useId();
  useEffect(() => {
    if (!enabled) {
      claimCornerLift(id, null);
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
      claimCornerLift(id, lift);
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
      claimCornerLift(id, null);
    };
  }, [id, ref, enabled, gap]);
}
