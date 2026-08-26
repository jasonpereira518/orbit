"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { OrbitLogo } from "@/components/orbit-logo";
import { BackControl } from "@/components/pricing/back-control";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Wraps a page's header and body so pressing Back plays an exit before actually
 * navigating, instead of cutting away instantly: the body slides off to the right, then
 * once that's clear, the header (the back button included) fades out and the real
 * navigation fires.
 *
 * Scoped to /upgrade for now — BackControl's default (instant) behavior is untouched
 * everywhere else it's used, since `onBeforeNavigate` is opt-in.
 */
export function PageExitOnBack({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<"idle" | "sliding" | "fading">("idle");
  // Holds the real router navigation, captured at click time and run once the exit
  // finishes — a ref rather than state because invoking it must never itself re-render.
  const navigateRef = useRef<() => void>(() => {});

  function handleBack(navigate: () => void) {
    navigateRef.current = navigate;
    if (reduced || phase !== "idle") {
      navigate();
      return;
    }
    setPhase("sliding");
  }

  return (
    <>
      <motion.header
        className="relative z-10 mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-6 md:px-8"
        initial={false}
        animate={{ opacity: phase === "fading" ? 0 : 1 }}
        transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
        onAnimationComplete={() => {
          if (phase === "fading") navigateRef.current();
        }}
      >
        <div className="flex items-center gap-4">
          <BackControl onBeforeNavigate={handleBack} />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
              Orbit
            </span>
          </Link>
        </div>
      </motion.header>

      <motion.div
        initial={false}
        animate={{ x: phase === "idle" ? 0 : "100%" }}
        transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
        // Mid-exit, the body is on its way off-screen — stop it (and whatever's still
        // reachable behind it) from taking clicks or a screen reader's attention.
        aria-hidden={phase !== "idle" || undefined}
        style={phase !== "idle" ? { pointerEvents: "none" } : undefined}
        onAnimationComplete={() => {
          if (phase === "sliding") setPhase("fading");
        }}
      >
        {children}
      </motion.div>
    </>
  );
}
