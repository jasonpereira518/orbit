"use client";

import { motion } from "motion/react";
import { FRONT_WAVE_REFERRALS } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The front-wave meter, drawn as moons on one ring around the pass's planet: one slot per
 * friend the front wave needs (`FRONT_WAVE_REFERRALS`), lit for each friend who has joined
 * and still waits. Three lit moons is the front wave.
 *
 * When `play` is true each lit moon drops in with a 90 ms stagger, then the whole ring
 * drifts on a CSS rotation. The ring is sized to sit just outside the planet: `size` is
 * its diameter.
 *
 * `play` already folds in the caller's reduced-motion answer AND whether it has mounted,
 * so the hidden `initial` styles never reach the server HTML: a `?me=` visit shows the
 * moons even with JS off, and they replay the drop once after hydration.
 */
export function Moons({ lit, play, size }: { lit: number; play: boolean; size: number }) {
  const reduced = usePrefersReducedMotion();
  const n = FRONT_WAVE_REFERRALS;
  const filled = Math.min(Math.max(lit, 0), n);
  const r = size / 2;

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#7aa896]/30 interest-moons-drift"
      style={{ width: size, height: size }}
    >
      {Array.from({ length: n }, (_, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = r + r * Math.cos(angle);
        const y = r + r * Math.sin(angle);
        const on = i < filled;
        return on ? (
          <motion.span
            key={i}
            className="absolute size-[9px] rounded-full bg-[#f2c14e] shadow-[0_0_10px_rgba(242,193,78,0.85)]"
            style={{ left: x - 4.5, top: y - 4.5 }}
            initial={play ? { scale: 0, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: DUR.base, ease: EASE_HOUSE, delay: 0.9 + i * 0.09 }
            }
          />
        ) : (
          <span
            key={i}
            className="absolute size-[9px] rounded-full border border-[#e8f3f1]/35 bg-[#05070f]"
            style={{ left: x - 4.5, top: y - 4.5 }}
          />
        );
      })}
    </span>
  );
}
