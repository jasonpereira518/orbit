"use client";

import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { tierTheme, type PaidPlan } from "@/lib/celebration/tier-theme";
import { EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const FIELD = "#0d121b";
const DRAIN_MS = 1550;
const REST_MS = 2000;

export function PlanDowngradeStage({
  fromPlan,
  forceReducedMotion = false,
  onDone,
}: {
  fromPlan: PaidPlan;
  /** Local preview only; production follows the user's system preference. */
  forceReducedMotion?: boolean;
  onDone: () => void;
}) {
  const theme = tierTheme(fromPlan);
  const systemReduced = usePrefersReducedMotion();
  const reduced =
    forceReducedMotion ||
    systemReduced ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [phase, setPhase] = useState<"start" | "drain" | "rest">("start");
  const [skipped, setSkipped] = useState(false);
  const [entered, setEntered] = useState(false);
  const [exiting, setExiting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const exitingRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const skip = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
    setSkipped(true);
    setPhase("rest");
  }, []);
  const dismiss = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    exitTimerRef.current = setTimeout(onDone, reduced ? 160 : 250);
  }, [onDone, reduced]);

  useEffect(() => {
    if (reduced) return;
    const drain = setTimeout(() => setPhase("drain"), 180);
    const rest = setTimeout(() => setPhase("rest"), REST_MS);
    timersRef.current = [drain, rest];
    return () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    };
  }, [reduced]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.documentElement.setAttribute("data-plan-downgrade", "");
    rootRef.current?.focus();
    const frame = requestAnimationFrame(() => setEntered(true));
    const fallback = setTimeout(() => setEntered(true), 250);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      document.documentElement.removeAttribute("data-plan-downgrade");
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (phase === "rest" || reduced) buttonRef.current?.focus();
  }, [phase, reduced]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        if (phase === "rest" || reduced) buttonRef.current?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (phase === "rest" || reduced) dismiss();
      else skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, reduced, dismiss, skip]);

  // A tab hidden mid-animation returns directly to the actionable Free state.
  useEffect(() => {
    if (reduced) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") skip();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reduced, skip]);

  const rest = reduced || phase === "rest";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${theme.name} access ended`}
      tabIndex={-1}
      onClick={rest ? undefined : skip}
      className="fixed inset-0 z-[9998] flex min-h-dvh w-full items-center justify-center overflow-y-auto overscroll-contain p-6 text-white outline-none sm:p-10"
      style={{
        backgroundColor: FIELD,
        opacity: exiting || (reduced && !entered) ? 0 : 1,
        transition: `opacity ${reduced ? 160 : 250}ms ease-out`,
      }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 40%, ${theme.field.hot}, ${theme.field.mid} 58%, ${theme.field.edge})`,
        }}
        initial={false}
        animate={{ opacity: reduced || phase !== "start" ? 0 : 1 }}
        transition={{ duration: reduced || skipped ? 0 : DRAIN_MS / 1000, ease: EASE_HOUSE }}
      />

      <div className="relative z-10 flex w-full max-w-xl flex-col items-center text-center">
        <div className="relative mb-9 size-24 sm:mb-11">
          <div aria-hidden className="absolute inset-0">
            <OrbitLogo size="hero" plan="free" priority />
          </div>
          <motion.div
            aria-hidden
            className="absolute inset-0"
            initial={false}
            animate={{ opacity: reduced || phase !== "start" ? 0 : 1, scale: phase === "start" ? 1 : 1.1 }}
            transition={{ duration: reduced || skipped ? 0 : 1.25, ease: EASE_HOUSE }}
          >
            <OrbitLogo size="hero" plan={fromPlan} priority />
          </motion.div>
        </div>

        {!rest && (
          <motion.p
            className="max-w-lg font-[family-name:var(--font-display)] text-2xl leading-tight tracking-tight sm:text-4xl"
            style={{ color: theme.ink }}
            initial={false}
            animate={{ opacity: phase === "start" ? 1 : 0 }}
            transition={{ duration: 1.15, ease: EASE_HOUSE }}
          >
            Your {theme.name} access has ended
          </motion.p>
        )}

        {rest && (
          <motion.div
            className="flex flex-col items-center"
            initial={{ opacity: 0, y: reduced ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0.16 : 0.38, ease: EASE_HOUSE }}
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-300">
              Your {theme.name} access has ended
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight sm:text-5xl">
              You&apos;re on the Free Plan
            </h2>
            <p className="mt-5 max-w-md text-base leading-relaxed text-slate-300 sm:text-lg">
              Your saved contacts and notes are still here.
            </p>
            <Button
              ref={buttonRef}
              type="button"
              size="lg"
              onClick={dismiss}
              className="mt-9 min-w-52 bg-white text-slate-950 hover:bg-slate-200"
            >
              Continue on Free
            </Button>
          </motion.div>
        )}
      </div>

      {!rest && (
        <p
          className="absolute bottom-8 left-0 right-0 text-center text-xs font-medium tracking-wide"
          style={{ color: theme.ink }}
        >
          Press Escape or tap to skip
        </p>
      )}
    </div>
  );
}
