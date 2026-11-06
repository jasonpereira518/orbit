"use client";

import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreditsIntroCanvas, medallionRadius } from "@/components/credits-intro/credits-intro-canvas";
import { OrbitLogo } from "@/components/orbit-logo";
import {
  COUNT,
  ENTER_FADE_MS,
  EXIT_MS,
  REDUCED_MS,
  REST,
  SETTLE,
  SKIPPABLE_FROM,
  creditsIntroCopy,
  creditsIntroTheme,
  type CreditsIntroCopy,
  type CreditsIntroNumbers,
  type CreditsIntroPhase,
  type CreditsIntroTheme,
} from "@/lib/credits-intro-scene";
import { EASE_HOUSE } from "@/lib/motion";
import type { Plan } from "@/lib/plans/plan-config";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The full-screen credits intro. Built on the plan celebration's contract
 * (`src/components/celebration/celebration-stage.tsx`), minus its sound, perks and logo
 * handoff: phase timers live in one array and are cleared together; skip is fast-forward to
 * rest, never abort; dismissal is the only exit; a hidden tab fast-forwards.
 *
 * One layer below warp's z-[9999], same as the celebration. Reduced motion renders a still
 * composition with a single fade — a different picture, never a degraded animation.
 */
export function CreditsIntroStage({
  plan,
  numbers,
  onDone,
}: {
  plan: Plan;
  numbers: CreditsIntroNumbers;
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const theme = useMemo(() => creditsIntroTheme(plan), [plan]);
  const copy = useMemo(() => creditsIntroCopy(plan, numbers), [plan, numbers]);
  const [phase, setPhase] = useState<CreditsIntroPhase>("gather");
  const [skipped, setSkipped] = useState(false);
  const [entered, setEntered] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const phaseRef = useRef<CreditsIntroPhase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const t0Ref = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const exitingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const counted = useMotionValue(0);
  const countText = useTransform(counted, (v) => Math.round(v).toLocaleString("en-US"));

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const dismiss = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    clearTimers();
    setExiting(true);
    timers.current.push(setTimeout(onDone, EXIT_MS));
  }, [clearTimers, onDone]);

  const skipToRest = useCallback(() => {
    if (phaseRef.current === "rest" || exitingRef.current) return;
    clearTimers();
    counted.jump(copy.monthly);
    setSkipped(true);
    setPhase("rest");
  }, [clearTimers, copy.monthly, counted]);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The playing arc. Reduced motion never enters it.
  useEffect(() => {
    if (reduced) return;
    t0Ref.current = performance.now();
    const at = (ms: number, fn: () => void) => {
      timers.current.push(setTimeout(fn, Math.max(0, ms - (performance.now() - t0Ref.current))));
    };
    at(SETTLE, () => setPhase("settle"));
    at(COUNT[0], () => {
      setPhase("count");
      animate(counted, copy.monthly, { duration: (COUNT[1] - COUNT[0]) / 1000, ease: EASE_HOUSE });
    });
    at(REST, () => setPhase("rest"));
    return clearTimers;
    // One arc per mount; a new plan comes through a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  // Escape and click: swallowed for the first beat, fast-forward while playing, dismiss at rest.
  const onAdvance = useCallback(() => {
    if (reduced) return dismiss();
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

  useEffect(() => {
    if (reduced) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") skipToRest();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reduced, skipToRest]);

  // Marks the takeover for anything that must not fight it; focus comes here and goes back.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.documentElement.setAttribute("data-credits-intro", "");
    rootRef.current?.focus();
    // With a timer fallback: if rAF is starved (occluded pane), an invisible click-swallowing
    // overlay must still become visible.
    const raf = requestAnimationFrame(() => setEntered(true));
    const fallback = setTimeout(() => setEntered(true), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
      document.documentElement.removeAttribute("data-credits-intro");
      previous?.focus?.();
    };
  }, []);

  const cx = size.w / 2;
  const cy = Math.round(size.h * 0.4);
  const radius = medallionRadius(size.w, size.h);
  const atRest = phase === "rest";
  const counting = phase === "count" || atRest;
  // Staggered entrances remount on skip so already-scheduled delays never trail in.
  const played = skipped ? "skipped" : "played";
  const enter = (delay: number) => ({
    initial: skipped ? (false as const) : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, ease: EASE_HOUSE, delay: skipped ? 0 : delay },
  });

  const continueButton = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        dismiss();
      }}
      className="pointer-events-auto rounded-full px-6 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4"
      style={{ backgroundColor: theme.button, color: theme.buttonInk, outlineColor: theme.rim }}
    >
      Continue
    </button>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={copy.ariaLabel}
      onClick={onAdvance}
      className={`fixed inset-0 z-[9998] h-full w-full touch-none overscroll-none outline-none ${exiting ? "pointer-events-none" : ""}`}
      style={{
        backgroundColor: theme.field,
        opacity: exiting || !entered ? 0 : 1,
        transition: `opacity ${exiting ? EXIT_MS : reduced ? REDUCED_MS : ENTER_FADE_MS}ms ease-out`,
      }}
    >
      {reduced ? (
        <div className="flex h-full w-full items-center justify-center overflow-y-auto px-6 py-10">
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <p className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.rim }}>
              {copy.kicker}
            </p>
            <div
              className="flex items-center justify-center rounded-full"
              style={{ width: 132, height: 132, backgroundColor: theme.disc, border: `3px solid ${theme.rim}` }}
            >
              <OrbitLogo size="hero" plan={plan} />
            </div>
            <Headline copy={copy} theme={theme} count={copy.monthly.toLocaleString("en-US")} />
            <p className="text-sm" style={{ color: theme.inkSoft }}>
              {copy.subline}
            </p>
            <p className="text-xs" style={{ color: theme.inkFaint }}>
              {copy.footnote}
            </p>
            {continueButton}
          </div>
        </div>
      ) : (
        <>
          <CreditsIntroCanvas
            theme={theme}
            starCount={copy.monthly}
            showerCount={plan === "free" ? numbers.starterCredits : 0}
            phaseRef={phaseRef}
            t0Ref={t0Ref}
          />
          <div className="pointer-events-none absolute inset-0">
            <motion.p
              className="absolute inset-x-0 text-center text-xs uppercase tracking-[0.18em]"
              style={{ top: Math.max(24, cy - radius - 96), color: theme.rim }}
              initial={skipped ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, ease: EASE_HOUSE, delay: skipped ? 0 : 0.2 }}
            >
              {copy.kicker}
            </motion.p>

            {/* The mark seats in the medallion as the cluster settles. */}
            {phase !== "gather" && (
              <motion.div
                key={`mark-${played}`}
                className="absolute flex items-center justify-center"
                style={{ left: cx - radius, top: cy - radius, width: radius * 2, height: radius * 2 }}
                initial={skipped ? false : { opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: EASE_HOUSE }}
              >
                <OrbitLogo size="hero" plan={plan} />
              </motion.div>
            )}

            <div
              className="absolute inset-x-0 flex flex-col items-center gap-3 px-6 text-center"
              style={{ top: cy + radius + 36 }}
            >
              {counting && (
                <motion.div key={`headline-${played}`} {...enter(0)}>
                  <Headline copy={copy} theme={theme} count={countText} />
                </motion.div>
              )}
              {atRest && (
                <>
                  <motion.p key={`sub-${played}`} className="text-sm" style={{ color: theme.inkSoft }} {...enter(0.05)}>
                    {copy.subline}
                  </motion.p>
                  <motion.p key={`foot-${played}`} className="text-xs" style={{ color: theme.inkFaint }} {...enter(0.12)}>
                    {copy.footnote}
                  </motion.p>
                  <motion.div key={`cta-${played}`} className="mt-2" {...enter(0.2)}>
                    {continueButton}
                  </motion.div>
                </>
              )}
            </div>

            {!atRest && (
              <p className="absolute right-5 bottom-4 text-xs" style={{ color: theme.inkFaint }}>
                Click anywhere to skip
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Headline({
  copy,
  theme,
  count,
}: {
  copy: CreditsIntroCopy;
  theme: CreditsIntroTheme;
  /** A plain string when still, the rolling value while it counts. */
  count: string | MotionValue<string>;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="font-heading text-[clamp(28px,6vw,44px)] leading-tight" style={{ color: theme.ink }}>
        <motion.span className="tabular-nums" style={{ color: theme.rim }}>
          {count}
        </motion.span>{" "}
        {copy.unit}
      </p>
      {copy.starter && (
        <p className="font-heading text-[clamp(18px,3.4vw,24px)]" style={{ color: `rgb(${theme.goldRgb})` }}>
          {copy.starter}
        </p>
      )}
    </div>
  );
}
