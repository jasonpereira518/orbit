"use client";

import { useEffect, useState } from "react";
import { tourAnchorSelector, type TourAnchorId } from "@/lib/tour/tour-anchors";

export type AnchorRect = { top: number; left: number; width: number; height: number };

export type AnchorState = {
  rect: AnchorRect | null;
  el: HTMLElement | null;
  /** `measuring` until found or the deadline passes; `missing` means "not on this screen". */
  status: "measuring" | "found" | "missing";
};

const MISSING: AnchorState = { rect: null, el: null, status: "missing" };
const MEASURING: AnchorState = { rect: null, el: null, status: "measuring" };

/** How long a stop waits for its control to appear (Suspense, a dynamic import, a tab). */
const DEADLINE_MS = 4000;

function firstVisible(id: TourAnchorId): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(tourAnchorSelector(id));
  for (const el of nodes) {
    const shown =
      typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
    if (!shown) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function same(a: AnchorRect | null, b: AnchorRect) {
  return (
    a != null &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Where the first visible element carrying `data-tour="<id>"` is, kept current without an
 * interval: one rAF-coalesced re-measure on resize, on any scroll (capture phase, so a
 * scrolling pane counts), on a body-subtree mutation (which is what catches a Suspense
 * boundary resolving, a tab switching, an AnimatePresence swap) and on tab visibility.
 * `null` id means "this stop points at nothing".
 */
export function useAnchorRect(id: TourAnchorId | null, resetKey: string): AnchorState {
  const [state, setState] = useState<AnchorState>(id ? MEASURING : MISSING);

  useEffect(() => {
    if (!id) return;
    let raf = 0;
    let cancelled = false;
    let observed: HTMLElement | null = null;

    const ro = new ResizeObserver(() => schedule());
    ro.observe(document.documentElement);

    const measure = () => {
      raf = 0;
      if (cancelled) return;
      const el = firstVisible(id);
      if (!el) {
        setState((s) => (s.status === "found" ? MEASURING : s));
        return;
      }
      if (el !== observed) {
        if (observed) ro.unobserve(observed);
        ro.observe(el);
        observed = el;
      }
      const r = el.getBoundingClientRect();
      const rect = { top: r.top, left: r.left, width: r.width, height: r.height };
      setState((s) => (s.el === el && same(s.rect, rect) ? s : { rect, el, status: "found" }));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    const deadline = window.setTimeout(() => {
      if (!cancelled) setState((s) => (s.status === "found" ? s : MISSING));
    }, DEADLINE_MS);

    const mo = new MutationObserver(schedule);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "style", "data-state", "aria-hidden"],
    });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();

    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
    // `resetKey` (the stop id) restarts the deadline for a new stop that reuses an anchor id.
  }, [id, resetKey]);

  return id ? state : MISSING;
}
