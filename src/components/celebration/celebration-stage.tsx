"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CASCADE_START,
  COLLAPSE,
  ENTER_FADE_MS,
  EXIT_MS,
  IGNITE,
  REDUCED_MS,
  RING_SWEEP_MS,
  SHAKE_MS,
  SKIPPABLE_FROM,
  cardAt,
  finaleAt,
  restAt,
} from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { createSting, type Sting } from "@/lib/celebration/sting";
import { stageLayout } from "@/lib/celebration/stage-layout";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { EASE_HOUSE } from "@/lib/motion";
import { CelebrationCanvas } from "@/components/celebration/celebration-canvas";
import { CelebrationContent } from "@/components/celebration/celebration-content";
import { CelebrationReduced } from "@/components/celebration/celebration-reduced";

/**
 * The full-screen takeover. Sits one layer below warp's z-[9999] — if a warp
 * ever runs concurrently it should win the screen — and above everything else
 * in the app, swallowing stray clicks aimed at the page beneath.
 *
 * Beat clock: phase timers live in one array and are cleared together, so a
 * skip can never be stepped on by a stale timer's tail. The canvas reads
 * phase and t0 through refs and never restarts.
 *
 * Skip is fast-forward, not abort: it jumps to the rest state with everything
 * in final position. Dismissal is the only exit.
 */
export function CelebrationStage({
  theme,
  /** "ignite" when restarting mid-play for an even higher tier — the
   * anticipation was already spent on the first accretion. */
  startAt = "accrete",
  onDone,
}: {
  theme: TierTheme;
  startAt?: "accrete" | "ignite";
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<CelebrationPhase>(
    startAt === "ignite" ? "ignite" : "accrete",
  );
  const [collapsed, setCollapsed] = useState(startAt === "ignite");
  const [skipped, setSkipped] = useState(false);
  const [exiting, setExiting] = useState(false);
  // First paint is transparent so the veil fades up from the app beneath it.
  const [entered, setEntered] = useState(false);
  // The stage renders client-only (dynamic ssr:false), so window is real here.
  const [layout, setLayout] = useState(() =>
    stageLayout(window.innerWidth, window.innerHeight),
  );

  const phaseRef = useRef<CelebrationPhase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stingRef = useRef<Sting | null>(null);
  // The moment "t=0" of the choreography happened, shifted back when the
  // stage starts at the ignition so beat maths stays absolute. Assigned by
  // the arc effect before anything reads it (render must stay pure).
  const t0Ref = useRef(0);
  const exitingRef = useRef(false);

  const perkCount = theme.perks.length;

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const dismiss = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    clearTimers();
    stingRef.current?.stopAll();
    setExiting(true);
    timers.current.push(setTimeout(onDone, reduced ? REDUCED_MS : EXIT_MS));
  }, [clearTimers, onDone, reduced]);

  const skipToRest = useCallback(() => {
    if (phaseRef.current === "rest" || exitingRef.current) return;
    clearTimers();
    stingRef.current?.stopAll();
    stingRef.current?.restPad();
    setSkipped(true);
    setCollapsed(true);
    setPhase("rest");
  }, [clearTimers]);

  useEffect(() => {
    const onResize = () =>
      setLayout(stageLayout(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The playing arc. Reduced motion renders a different composition entirely
  // and never enters this machinery.
  useEffect(() => {
    if (reduced) {
      stingRef.current = createSting();
      stingRef.current.restPad();
      return () => {
        stingRef.current?.dispose();
        stingRef.current = null;
      };
    }

    const sting = createSting();
    stingRef.current = sting;
    t0Ref.current = performance.now() - (startAt === "ignite" ? IGNITE : 0);

    const at = (ms: number, fn: () => void) => {
      const delay = ms - (performance.now() - t0Ref.current);
      if (delay <= 0) fn();
      else timers.current.push(setTimeout(fn, delay));
    };

    if (startAt === "accrete") sting.sweep(COLLAPSE[0]);
    at(COLLAPSE[0], () => setCollapsed(true));
    at(IGNITE, () => {
      setPhase("ignite");
      sting.ignite();
    });
    at(CASCADE_START, () => setPhase("cascade"));
    for (let i = 0; i < perkCount; i++) {
      at(cardAt(i), () => sting.tick(i));
    }
    at(finaleAt(perkCount), () => {
      setPhase("finale");
      sting.finaleSwell();
    });
    at(finaleAt(perkCount) + RING_SWEEP_MS, () => sting.chime());
    at(restAt(perkCount), () => {
      setPhase("rest");
      sting.restPad();
    });

    return () => {
      clearTimers();
      sting.dispose();
      stingRef.current = null;
    };
    // Restarts (new theme / startAt) come through a remount key, never props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  // Escape and click share one rule: swallowed until the slam has landed,
  // fast-forward while playing, dismiss at rest.
  const onAdvance = useCallback(() => {
    if (reduced) {
      dismiss();
      return;
    }
    if (performance.now() - t0Ref.current < SKIPPABLE_FROM) return;
    if (phaseRef.current !== "rest") skipToRest();
    else dismiss();
  }, [dismiss, reduced, skipToRest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAdvance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAdvance]);

  // A hidden tab fast-forwards: rAF is throttled anyway, and a spectacle
  // nobody watched should not replay its tail on return.
  useEffect(() => {
    if (reduced) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && phaseRef.current !== "rest") {
        skipToRest();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reduced, skipToRest]);

  // Best-effort audio unlock: the comped path has no launching gesture, so
  // the first real interaction (usually the skip click) resumes the context.
  useEffect(() => {
    const unlock = () => stingRef.current?.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Mirror of `data-warp`: lets CSS elsewhere react, and marks the takeover
  // for anything that must not fight it. Focus comes here, returns on unmount.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.documentElement.setAttribute("data-celebration", "");
    rootRef.current?.focus();
    // Two frames in, so the transparent first paint has actually committed —
    // with a timer fallback: if rAF is starved (occluded pane), an invisible
    // click-swallowing overlay must still become visible.
    const raf = requestAnimationFrame(() => setEntered(true));
    const fallback = setTimeout(() => setEntered(true), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
      document.documentElement.removeAttribute("data-celebration");
      previous?.focus?.();
    };
  }, []);

  const style = useMemo(
    () => ({
      backgroundColor: theme.deep,
      opacity: exiting || !entered ? 0 : 1,
      transition: `opacity ${exiting ? EXIT_MS : reduced ? REDUCED_MS : ENTER_FADE_MS}ms ease-out`,
    }),
    [entered, exiting, reduced, theme.deep],
  );

  const shaken = phase !== "accrete" && !skipped;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`You now have ${theme.name}`}
      onClick={onAdvance}
      className="fixed inset-0 z-[9998] h-full w-full touch-none overscroll-none outline-none"
      style={style}
    >
      {reduced ? (
        <CelebrationReduced theme={theme} onDismiss={dismiss} />
      ) : (
        <>
          <motion.div
            // The ignition shakes the whole composition — sky included —
            // never the page behind it.
            className="absolute inset-0"
            initial={false}
            animate={
              shaken
                ? { x: [0, -7, 6, -4, 3, 0], y: [0, 4, -5, 2, -1, 0] }
                : { x: 0, y: 0 }
            }
            transition={{ duration: SHAKE_MS / 1000, ease: "easeOut" }}
          >
            <CelebrationCanvas theme={theme} phaseRef={phaseRef} t0Ref={t0Ref} />
            <CelebrationContent
              theme={theme}
              phase={phase}
              collapsed={collapsed}
              skipped={skipped}
              layout={layout}
              onDismiss={dismiss}
            />
          </motion.div>

          {/* Impact flash: white with a breath of the tier colour, gone fast. */}
          <AnimatePresence>
            {phase === "ignite" && !skipped && (
              <motion.div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `radial-gradient(circle at ${layout.cx}px ${layout.cy}px, rgba(255,255,255,0.98), rgba(${theme.glowRgb}, 0.55) 42%, transparent 72%)`,
                }}
                initial={{ opacity: 0.95 }}
                animate={{ opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45, ease: EASE_HOUSE }}
              />
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
