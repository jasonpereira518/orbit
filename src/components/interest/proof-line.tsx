"use client";

import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { formatTicketNumber } from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { planetForSignupNumber, planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * "1,284 people on the waitlist", or "Next up:" and the next three planets to be handed out, below the count floor.
 *
 * The server renders the final number; after hydration the digits roll up from a few
 * dozen below, once. The roll starts in an effect, never in render, so the HTML and the
 * first client render agree.
 */
export function ProofLine({ proof, showCount }: { proof: InterestProof; showCount: boolean }) {
  const stack = (list: WelcomePlanet[]) => (
    <span className="flex items-center" aria-hidden="true">
      {list.map((planet, i) => (
        <PlanetArt
          key={`${planet}-${i}`}
          planet={planet}
          size={20}
          className={i > 0 ? "-ml-1" : undefined}
        />
      ))}
    </span>
  );
  // Planets go out by join ordinal, so the next three signups' planets are known now.
  const upcoming = [1, 2, 3].map((n) => planetForSignupNumber(proof.total + n));
  return (
    <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm leading-[1.6] text-[#9aada8]">
      {showCount ? (
        <>
          {stack(proof.recent)}
          <span>
            <RollingCount value={proof.count} /> people on the waitlist
          </span>
        </>
      ) : (
        <>
          <span>Next up: {planetLabel(upcoming[0])}</span>
          {stack(upcoming)}
        </>
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
