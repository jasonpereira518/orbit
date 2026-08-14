"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Scene C centerpiece: a comet scrubbed across the reminders section as it
 * moves through the viewport — the visual for "streaks them back across
 * your sky". Overlay is decorative and never intercepts pointer events.
 * Reduced motion renders a resting comet instead of binding the scrub.
 */
export function CometStreak() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });

  const x = useTransform(scrollYProgress, [0, 1], ["-15vw", "105vw"]);
  const y = useTransform(scrollYProgress, [0, 1], ["0vh", "22vh"]);
  // Function transform keeps the fade off the WAAPI path (see scrub01).
  const opacity = useTransform(scrollYProgress, (v) =>
    v < 0.5 ? scrub01(v, 0.12, 0.5) : 1 - scrub01(v, 0.5, 0.88)
  );

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className="absolute left-0 top-[14%] rotate-[11deg]"
        style={
          reduced
            ? { left: "58%", top: "22%", opacity: 0.45 }
            : { x, y, opacity }
        }
      >
        {/* Tail sweeps behind the head. */}
        <div className="h-[2px] w-44 rounded-full bg-[linear-gradient(90deg,transparent,rgba(196,220,230,0.55),rgba(255,255,255,0.95))]" />
        <div className="absolute -right-1 top-1/2 size-[7px] -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_4px_rgba(196,220,230,0.45)]" />
      </motion.div>
    </div>
  );
}
