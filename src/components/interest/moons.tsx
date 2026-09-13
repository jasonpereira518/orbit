"use client";

import { motion } from "motion/react";
import { MOONS_DRAWN_MAX } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The people who joined through a ticket, drawn as moons on one ring around its planet.
 *
 * Up to `MOONS_DRAWN_MAX`; the count line carries the rest. When `play` is true each moon
 * drops in with a 90 ms stagger, then the whole ring drifts on a CSS rotation. The ring
 * is sized to sit just outside the planet: `size` is the ring's diameter.
 */
export function Moons({ count, play, size }: { count: number; play: boolean; size: number }) {
  const reduced = usePrefersReducedMotion();
  const n = Math.min(count, MOONS_DRAWN_MAX);
  if (n === 0) return null;
  const r = size / 2;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#7aa896]/30 interest-moons-drift"
      )}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: n }, (_, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = r + r * Math.cos(angle);
        const y = r + r * Math.sin(angle);
        return (
          <motion.span
            key={i}
            className="absolute size-[7px] rounded-full bg-[#e8f3f1] shadow-[0_0_8px_rgba(232,243,241,0.85)]"
            style={{ left: x - 3.5, top: y - 3.5 }}
            initial={play && !reduced ? { scale: 0, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: DUR.base, ease: EASE_HOUSE, delay: 0.9 + i * 0.09 }
            }
          />
        );
      })}
    </span>
  );
}
