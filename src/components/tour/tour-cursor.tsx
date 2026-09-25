"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
import { SPRING_SOFT, SPRING_TAP } from "@/lib/motion";
import type { TourCursorMode } from "@/lib/tour/tour-stops";

export type CursorPoint = { x: number; y: number };

/** How long the cursor waits at a `click` stop before pressing, so the person sees it coming. */
const CLICK_PAUSE_MS = 1200;
/** The press lands this long before the real click, so the ripple and the effect line up. */
const PRESS_LEAD_MS = 160;
const DEMO_EVERY_MS = 4000;
const NUDGE_EVERY_MS = 2500;

/**
 * The tour's guide: a friendly cursor, labelled "Orbit" like a collaborator's, that glides
 * to whatever the current stop is about and points at it, demonstrates a click, or — on the
 * few stops where that is harmless (opening a profile, opening the log sheet, focusing the
 * search) — clicks it for real. It never presses anything that saves or spends the user's AI
 * key; the stop table decides, and the tour-stops smoke keeps that list short.
 *
 * Any real input from the person during the pause before a real click cancels it: they
 * took over. Above the spotlight's scrim, under the coach rail, never interactive.
 */
export function TourCursor({
  target,
  mode,
  stopKey,
  origin,
  reduced,
  onClick,
}: {
  /** Where the tip should be; null hides the cursor. */
  target: CursorPoint | null;
  mode: TourCursorMode;
  /** Changes on every stop entry: a real click happens at most once per key. */
  stopKey: string;
  /** Where it first appears (the coach card), so it visibly comes out of the rail. */
  origin: CursorPoint;
  reduced: boolean;
  onClick?: () => void;
}) {
  const x = useMotionValue(origin.x);
  const y = useMotionValue(origin.y);
  const scale = useMotionValue(1);
  const nudge = useMotionValue(0);
  const [arrivedAt, setArrivedAt] = useState<string | null>(null);
  const [ripples, setRipples] = useState<number[]>([]);
  const clicked = useRef<string | null>(null);
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onClickRef.current = onClick;
  }, [onClick]);

  const tx = target?.x ?? null;
  const ty = target?.y ?? null;
  const arrivalKey = tx == null || ty == null ? null : `${stopKey}:${Math.round(tx)}:${Math.round(ty)}`;

  // Glide to the target. Arrival (the promise settling) is what starts the stop's gesture.
  useEffect(() => {
    if (tx == null || ty == null || !arrivalKey) return;
    if (reduced) {
      x.set(tx);
      y.set(ty);
      const t = window.setTimeout(() => setArrivedAt(arrivalKey), 0);
      return () => window.clearTimeout(t);
    }
    const ax = animate(x, tx, SPRING_SOFT);
    const ay = animate(y, ty, SPRING_SOFT);
    let cancelled = false;
    Promise.all([ax, ay]).then(() => {
      if (!cancelled) setArrivedAt(arrivalKey);
    });
    return () => {
      cancelled = true;
      ax.stop();
      ay.stop();
    };
  }, [arrivalKey, reduced, tx, ty, x, y]);

  const arrived = arrivalKey != null && arrivedAt === arrivalKey;

  // The stop's gesture, once it has arrived.
  useEffect(() => {
    if (!arrived) return;
    const press = () => {
      if (!reduced) {
        animate(scale, [1, 0.86, 1], { duration: 0.32, times: [0, 0.4, 1] });
        setRipples((r) => [...r.slice(-2), Date.now()]);
      }
    };

    if (mode === "click") {
      if (clicked.current === stopKey) return;
      let cancelled = false;
      const takeOver = (e: Event) => {
        if (e.isTrusted) cancelled = true;
      };
      window.addEventListener("pointerdown", takeOver, true);
      window.addEventListener("pointermove", takeOver, true);
      window.addEventListener("keydown", takeOver, true);
      const pressT = window.setTimeout(() => {
        if (!cancelled) press();
      }, CLICK_PAUSE_MS - PRESS_LEAD_MS);
      const clickT = window.setTimeout(() => {
        if (cancelled || clicked.current === stopKey) return;
        clicked.current = stopKey;
        onClickRef.current?.();
      }, CLICK_PAUSE_MS);
      return () => {
        window.clearTimeout(pressT);
        window.clearTimeout(clickT);
        window.removeEventListener("pointerdown", takeOver, true);
        window.removeEventListener("pointermove", takeOver, true);
        window.removeEventListener("keydown", takeOver, true);
      };
    }

    if (reduced) return;
    if (mode === "demo-click") {
      const first = window.setTimeout(press, 500);
      const every = window.setInterval(press, DEMO_EVERY_MS);
      return () => {
        window.clearTimeout(first);
        window.clearInterval(every);
      };
    }
    // point: a small lean toward the target now and then, so it reads as "this one".
    const every = window.setInterval(() => {
      animate(nudge, [0, -5, 0], { duration: 0.6, ease: "easeInOut" });
    }, NUDGE_EVERY_MS);
    return () => window.clearInterval(every);
  }, [arrived, mode, nudge, reduced, scale, stopKey]);

  const visible = target != null;

  return (
    <motion.div
      aria-hidden
      data-tour-cursor
      className="pointer-events-none fixed top-0 left-0 z-[56]"
      style={{ x, y }}
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Ripples expand from the tip, which is this element's origin. */}
      <AnimatePresence>
        {ripples.map((id) => (
          <motion.span
            key={id}
            className="absolute -top-4 -left-4 size-8 rounded-full border-2 border-primary"
            initial={{ scale: 0.2, opacity: 0.7 }}
            animate={{ scale: 1.6, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            onAnimationComplete={() => setRipples((r) => r.filter((k) => k !== id))}
          />
        ))}
      </AnimatePresence>
      <motion.div style={{ scale, x: nudge, y: nudge, transformOrigin: "0 0" }} transition={SPRING_TAP}>
        <svg
          viewBox="0 0 24 24"
          className="size-[18px] drop-shadow-[0_2px_4px_rgb(0_0_0/0.25)] md:size-[22px]"
        >
          {/* A rounded arrow with its tip at (1.5, 1.5), which sits on the target point. */}
          <path
            d="M2.6 1.9 20.3 9.6c.9.4.8 1.7-.1 2l-6.9 2.2a1.2 1.2 0 0 0-.8.8l-2.2 6.9c-.3.9-1.6 1-2 .1L1.9 2.6c-.3-.5.2-1 .7-.7Z"
            className="fill-primary stroke-white"
            strokeWidth={1.5}
            strokeLinejoin="round"
            transform="translate(-0.4 -0.4)"
          />
        </svg>
        <span className="absolute top-4 left-4 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-primary-foreground shadow-sm md:top-5 md:left-5">
          Orbit
        </span>
      </motion.div>
    </motion.div>
  );
}
