"use client";

import { useEffect, useState, type Dispatch, type RefObject } from "react";
import { motion } from "motion/react";
import { EASE_HOUSE } from "@/lib/motion";
import type { DemoAction, DemoState } from "./demo-state";
import { TOUR } from "./demo-tour";

type Point = { x: number; y: number };

const CANCELLED = Symbol("tour cancelled");

/** Scroll `el` into view inside `pane` only — `scrollIntoView` would scroll the page too. */
function revealInPane(el: Element, pane: HTMLElement | null): boolean {
  if (!pane || !pane.contains(el)) return false;
  const e = el.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  const margin = 24;
  if (e.top >= p.top + margin && e.bottom <= p.bottom - margin) return false;
  const delta = e.top - p.top - margin;
  pane.scrollTo({ top: pane.scrollTop + delta, behavior: "smooth" });
  return true;
}

/** Where on a target the cursor lands: the centre of a control, near the corner of a card. */
function aimAt(el: Element, root: HTMLElement): Point {
  const e = el.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const big = e.width > 260 || e.height > 120;
  return {
    x: e.left - r.left + (big ? Math.min(e.width * 0.3, 90) : e.width / 2),
    y: e.top - r.top + (big ? Math.min(e.height * 0.3, 44) : e.height / 2),
  };
}

/**
 * Plays `TOUR` while `active`: moves the cursor to each beat's target, "clicks" by
 * dispatching the beat's action, holds for its dwell, and loops. Time only passes while
 * the window is on screen and the tab is visible (`pausedRef`).
 */
export function useDemoTour({
  active,
  reduced,
  rootRef,
  paneRef,
  pausedRef,
  stateRef,
  dispatch,
}: {
  active: boolean;
  reduced: boolean;
  rootRef: RefObject<HTMLElement | null>;
  paneRef: RefObject<HTMLElement | null>;
  pausedRef: RefObject<boolean>;
  stateRef: RefObject<DemoState>;
  dispatch: Dispatch<DemoAction>;
}) {
  const [cursor, setCursor] = useState<Point | null>(null);
  const [pressing, setPressing] = useState(false);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const tick = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const sleep = async (ms: number) => {
      let left = ms;
      while (left > 0) {
        if (cancelled) throw CANCELLED;
        await tick(100);
        if (!pausedRef.current) left -= 100;
      }
      if (cancelled) throw CANCELLED;
    };
    const find = async (id: string) => {
      for (let waited = 0; waited < 8000; waited += 100) {
        const el = rootRef.current?.querySelector(`[data-demo-target="${id}"]`);
        if (el) return el;
        await sleep(100);
      }
      return null;
    };

    (async () => {
      try {
        dispatch({ type: "reset" });
        await sleep(700);
        for (let i = 0; ; i = (i + 1) % TOUR.length) {
          const b = TOUR[i]!;
          setBeat(i);
          const el = await find(b.target);
          const root = rootRef.current;
          if (el && root) {
            if (revealInPane(el, paneRef.current)) await sleep(450);
            setCursor(aimAt(el, root));
            await sleep(reduced ? 300 : 900);
          }
          if (b.action) {
            setPressing(true);
            await sleep(160);
            const action = typeof b.action === "function" ? b.action(stateRef.current) : b.action;
            if (action) dispatch(action);
            setPressing(false);
            if (action && (action.type === "reset" || action.type === "openProfile" || action.type === "go" || action.type === "ask")) {
              paneRef.current?.scrollTo({ top: 0 });
            }
          }
          await sleep(b.dwell);
        }
      } catch (err) {
        if (err !== CANCELLED) throw err;
      }
    })();

    return () => {
      cancelled = true;
      setPressing(false);
    };
  }, [active, reduced, rootRef, paneRef, pausedRef, stateRef, dispatch]);

  return { cursor, pressing, beat };
}

export function TourCursor({ at, pressing, reduced }: { at: Point; pressing: boolean; reduced: boolean }) {
  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-40"
      // Placed at its first target on mount, then glides between targets.
      initial={{ x: at.x, y: at.y }}
      animate={{ x: at.x, y: at.y }}
      transition={reduced ? { duration: 0 } : { duration: 0.85, ease: EASE_HOUSE }}
    >
      {pressing && !reduced && (
        <motion.span
          className="absolute -left-4 -top-4 size-8 rounded-full border-2 border-[#f2c14e]"
          initial={{ scale: 0.3, opacity: 0.9 }}
          animate={{ scale: 1.4, opacity: 0 }}
          transition={{ duration: 0.45 }}
        />
      )}
      <motion.svg
        width="22"
        height="24"
        viewBox="0 0 22 24"
        animate={{ scale: pressing ? 0.86 : 1 }}
        transition={{ duration: 0.12 }}
        style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.55))", transformOrigin: "2px 2px" }}
      >
        <path d="M2 2 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z" fill="#fff" stroke="#0e1524" strokeWidth="1.3" strokeLinejoin="round" />
      </motion.svg>
    </motion.div>
  );
}
