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
/** How long an anchor must stay gone, once found, before the rail says it is not on screen. */
const GONE_GRACE_MS = 700;

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
  // Keyed, so a new stop starts at `measuring` in the same render that asks for it, rather
  // than inheriting the last stop's `missing` until something re-measures.
  const key = `${id ?? ""}|${resetKey}`;
  const [keyed, setKeyed] = useState<{ key: string; state: AnchorState }>({ key, state: MEASURING });

  useEffect(() => {
    if (!id) return;
    let raf = 0;
    let cancelled = false;
    let observed: HTMLElement | null = null;
    let deadlinePassed = false;
    let goneTimer = 0;
    const set = (next: (s: AnchorState) => AnchorState) =>
      setKeyed((k) => {
        const current = k.key === key ? k.state : MEASURING;
        const state = next(current);
        return k.key === key && state === current ? k : { key, state };
      });

    const ro = new ResizeObserver(() => schedule());
    ro.observe(document.documentElement);

    const measure = () => {
      raf = 0;
      if (cancelled) return;
      const el = firstVisible(id);
      if (!el) {
        set((s) => (s.status === "found" ? MEASURING : s));
        // Gone after the deadline (a view switched, a search emptied the list): say so, after
        // a beat so a swap that remounts the element doesn't flash the hint.
        if (deadlinePassed && !goneTimer) {
          goneTimer = window.setTimeout(() => {
            goneTimer = 0;
            if (!cancelled && !firstVisible(id)) set(() => MISSING);
          }, GONE_GRACE_MS);
        }
        return;
      }
      if (goneTimer) {
        window.clearTimeout(goneTimer);
        goneTimer = 0;
      }
      if (el !== observed) {
        if (observed) ro.unobserve(observed);
        ro.observe(el);
        observed = el;
      }
      const r = el.getBoundingClientRect();
      const rect = { top: r.top, left: r.left, width: r.width, height: r.height };
      set((s) => (s.el === el && same(s.rect, rect) ? s : { rect, el, status: "found" }));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    const deadline = window.setTimeout(() => {
      deadlinePassed = true;
      if (!cancelled) set((s) => (s.status === "found" ? s : MISSING));
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
      if (goneTimer) window.clearTimeout(goneTimer);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
    // `key` carries `resetKey` (the stop id): a new stop that reuses an anchor id restarts
    // the deadline.
  }, [id, key]);

  if (!id) return MISSING;
  return keyed.key === key ? keyed.state : MEASURING;
}
