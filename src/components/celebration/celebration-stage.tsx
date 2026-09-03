"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CASCADE_START,
  COLLAPSE,
  ENTER_FADE_MS,
  EXIT_MS,
  HANDOFF_MS,
  IGNITE,
  REDUCED_MS,
  RING_SWEEP_MS,
  SHAKE_MS,
  SKIPPABLE_FROM,
  perkAt,
  finaleAt,
  restAt,
} from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { createSting, type Sting } from "@/lib/celebration/sting";
import {
  HERO_LOGO_PX,
  findAppLogoTarget,
  stageLayout,
} from "@/lib/celebration/stage-layout";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { EASE_HOUSE } from "@/lib/motion";
import { CelebrationCanvas } from "@/components/celebration/celebration-canvas";
import { CelebrationContent } from "@/components/celebration/celebration-content";
import { CelebrationReduced } from "@/components/celebration/celebration-reduced";
import { OrbitLogo } from "@/components/orbit-logo";

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
  onHandoff,
  onDone,
}: {
  theme: TierTheme;
  startAt?: "accrete" | "ignite";
  /** Fired when the mark starts flying home, while the veil still covers the
   * app — the caller uses it to refresh the shell so the mark lands on a
   * logo already wearing the new tier's ring. */
  onHandoff?: () => void;
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<CelebrationPhase>(
    startAt === "ignite" ? "ignite" : "accrete",
  );
  const [collapsed, setCollapsed] = useState(startAt === "ignite");
  const [skipped, setSkipped] = useState(false);
  const [exiting, setExiting] = useState(false);
  // Set when the mark is in flight to the app's own logo: the delta and
  // scale that take it there.
  const [handoff, setHandoff] = useState<{
    dx: number;
    dy: number;
    /** The emblem's scale in logo-units, so the flight starts where the
     * canvas emblem ended rather than popping to 96px. */
    from: number;
    scale: number;
  } | null>(null);
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
  // Read inside `dismiss` without making it depend on every resize.
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

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

    // The mark hands itself off: it flies out of the middle of the stage and
    // lands on the app's own logo, which is where the user will look for
    // their tier from now on. Reduced motion never flies anything across the
    // screen, and a stage that never reached the finale has no mark to send.
    const target =
      reduced || phaseRef.current !== "rest" ? null : findAppLogoTarget();
    if (target) {
      const l = layoutRef.current;
      setHandoff({
        dx: target.cx - l.cx,
        dy: target.cy - l.cy,
        from: (2 * l.emblemR) / HERO_LOGO_PX,
        scale: target.size / HERO_LOGO_PX,
      });
      // The app's own logo steps aside for the whole flight — otherwise it
      // already shows the new ring (the shell refreshes below) while a
      // second mark is still crossing the screen toward it, which reads as
      // a duplicate rather than an arrival. It fades back in on its own
      // 180ms transition (see globals.css) timed to land exactly as the
      // flying mark below starts its own matching fade-out.
      document.documentElement.setAttribute("data-celebration-handoff", "");
      timers.current.push(
        setTimeout(
          () => document.documentElement.removeAttribute("data-celebration-handoff"),
          HANDOFF_MS - 180,
        ),
      );
      // Refresh the shell now, under the veil, so the logo being flown into
      // already wears the new ring when the flight lands on it.
      onHandoff?.();
      timers.current.push(setTimeout(onDone, HANDOFF_MS));
      return;
    }
    timers.current.push(setTimeout(onDone, reduced ? REDUCED_MS : EXIT_MS));
  }, [clearTimers, onDone, onHandoff, reduced]);

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
      at(perkAt(i), () => sting.tick(i));
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
      // Safety net: the scheduled removal in `dismiss` normally clears this
      // first, but an unmount that skips that timer (StrictMode, a forced
      // remount mid-flight) must not leave the app's own logo hidden forever.
      document.documentElement.removeAttribute("data-celebration-handoff");
      previous?.focus?.();
    };
  }, []);

  const style = useMemo(
    () => ({
      backgroundColor: theme.field.edge,
      opacity: exiting || !entered ? 0 : 1,
      transition: `opacity ${exiting ? EXIT_MS : reduced ? REDUCED_MS : ENTER_FADE_MS}ms ease-out`,
    }),
    [entered, exiting, reduced, theme.field.edge],
  );

  const shaken = phase !== "accrete" && !skipped;

  return (
    <>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`You now have ${theme.name}`}
        onClick={onAdvance}
        className={`fixed inset-0 z-[9998] h-full w-full touch-none overscroll-none outline-none ${
          exiting ? "pointer-events-none" : ""
        }`}
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
                    background: `radial-gradient(circle at ${layout.cx}px ${layout.cy}px, rgba(255,255,255,0.98) 0%, rgba(${theme.coreRgb}, 0.6) 42%, ${theme.field.hot} 78%)`,
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

      {/* The handoff. Rendered outside the veil so it keeps travelling after
          the veil has faded, over the live app — the mark leaves the
          celebration and lands on the logo the user will see from now on. */}
      {handoff && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed z-[9998]"
          style={{
            left: layout.cx - HERO_LOGO_PX / 2,
            top: layout.cy - HERO_LOGO_PX / 2,
          }}
          // Starts at the emblem's own size and shrinks all the way to the
          // sidebar mark. Without this the 96px logo would pop out of a
          // ~300px emblem at the instant the flight begins.
          initial={{ x: 0, y: 0, scale: handoff.from }}
          animate={{
            x: handoff.dx,
            y: handoff.dy,
            scale: [handoff.from, handoff.from * 1.06, handoff.scale],
          }}
          transition={{
            duration: HANDOFF_MS / 1000,
            ease: EASE_HOUSE,
            // A breath of anticipation before it goes — the mark gathers
            // itself rather than simply being tweened away.
            scale: {
              duration: HANDOFF_MS / 1000,
              times: [0, 0.14, 1],
              ease: EASE_HOUSE,
            },
          }}
        >
          <motion.div
            style={{ filter: `drop-shadow(0 6px 10px rgba(${theme.inkRgb}, 0.35))` }}
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            // Fades only at the very end, on top of the app's own logo, so
            // the swap is a dissolve between two identical marks.
            transition={{ duration: 0.18, delay: (HANDOFF_MS - 180) / 1000 }}
          >
            <OrbitLogo size="hero" plan={theme.plan} />
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
