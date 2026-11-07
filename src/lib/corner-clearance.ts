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
const SHIFT_VAR = "--orbit-corner-shift";

/**
 * One ref-counted claim store per CSS variable: the variable holds the MAX of the live
 * claims, and is removed (falling back to theme.css's 0px) when none are left.
 */
function claimStore(cssVar: string) {
  const claims = new Map<string, number>();
  return (id: string, px: number | null) => {
    if (px == null || px <= 0) claims.delete(id);
    else claims.set(id, px);
    let max = 0;
    for (const v of claims.values()) if (v > max) max = v;
    const root = document.documentElement;
    if (max > 0) root.style.setProperty(cssVar, `${max}px`);
    else root.style.removeProperty(cssVar);
  };
}

/** Set (or clear, with null) one claimant's lift. Safe to call every measurement. */
export const claimCornerLift = claimStore(LIFT_VAR);

/**
 * Set (or clear, with null) one claimant's leftward shift of the corner.
 *
 * For floating windows anchored to the right edge (notifications, feedback): the toast
 * column and the job stack slide to the window's left instead of landing on it. Only
 * honoured at `md`+ in theme.css — below that the window is (nearly) full width and there
 * is no room beside it, so toasts overlay it there.
 */
export const claimCornerShift = claimStore(SHIFT_VAR);

/** Shift the corner left by `px` for as long as `enabled` holds. Release keys off the flag, not unmount. */
export function useCornerShift(px: number, enabled: boolean) {
  const id = useId();
  useEffect(() => {
    if (!enabled) return;
    claimCornerShift(id, px);
    return () => claimCornerShift(id, null);
  }, [id, px, enabled]);
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
