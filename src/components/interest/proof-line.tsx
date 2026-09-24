"use client";

import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { formatTicketNumber } from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * "1,284 people on the waitlist", or "Opening in waves" below the count floor.
 *
 * The server renders the final number; after hydration the digits roll up from a few
 * dozen below, once. The roll starts in an effect, never in render, so the HTML and the
 * first client render agree.
 */
export function ProofLine({ proof, showCount }: { proof: InterestProof; showCount: boolean }) {
  return (
    <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs leading-[1.6] text-[#9aada8]">
      <span className="flex items-center" aria-hidden="true">
        {proof.recent.map((planet, i) => (
          <PlanetArt
            key={`${planet}-${i}`}
            planet={planet}
            size={14}
            className={i > 0 ? "-ml-1" : undefined}
          />
        ))}
      </span>
      {showCount ? (
        <span>
          <RollingCount value={proof.count} /> people on the waitlist
        </span>
      ) : (
        <span>Opening in waves</span>
      )}
    </p>
  );
}

/** Rolls from `value − 40` to `value` after mount; instant under reduced motion. */
export function RollingCount({ value, delay = 0 }: { value: number; delay?: number }) {
  const reduced = usePrefersReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => formatTicketNumber(Math.round(v)));
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (reduced) {
      mv.set(value);
      return;
    }
    mv.set(Math.max(1, value - 40));
    const controls = animate(mv, value, { duration: DUR.celestial, ease: EASE_HOUSE, delay });
    return () => controls.stop();
  }, [value, reduced, mv, delay]);

  // Before mount, the static number — identical to the server HTML.
  if (!mounted) return <span className="tabular-nums">{formatTicketNumber(value)}</span>;
  return <motion.span className="tabular-nums">{text}</motion.span>;
}
