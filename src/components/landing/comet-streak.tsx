"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** The app's Red Comet (drifting connection) color — see the /graph legend. */
const RED = [255, 107, 74] as const;
const ICE = [196, 220, 230] as const;
const WHITE = [255, 255, 255] as const;
const FIRE_CORE = [255, 179, 71] as const;
const FIRE_HOT = [255, 241, 204] as const;

function mix(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
  alpha = 1
) {
  const c = from.map((f, i) => Math.round(f + (to[i]! - f) * t));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.min(1, Math.max(0, alpha))})`;
}

/**
 * Deterministic, seedable "flicker" for a value driven purely by scroll
 * progress (no rAF loop) — three sine waves at incommensurate frequencies
 * so it reads as irregular sputtering rather than a single smooth wobble.
 * Returns roughly [-1, 1].
 */
function flicker(v: number, seed: number) {
  return (
    Math.sin(v * 41 + seed) * 0.5 +
    Math.sin(v * 97 + seed * 2.3) * 0.3 +
    Math.sin(v * 233 + seed * 4.1) * 0.2
  );
}

/**
 * Scene C centerpiece: a comet scrubbed across the reminders section as it
 * moves through the viewport. The farther it travels, the more it drifts —
 * head and tail red-shift toward the app's Red Comet color and the bow
 * shock ahead of the head thickens. Overlay is decorative and never
 * intercepts pointer events. Reduced motion renders a resting comet
 * instead of binding the scrub.
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
  // Function transforms keep the fades/colors off the WAAPI path (scrub01).
  const opacity = useTransform(scrollYProgress, (v) =>
    v < 0.5 ? scrub01(v, 0.12, 0.5) : 1 - scrub01(v, 0.5, 0.88)
  );

  // Red shift with distance: 0 = fresh (ice/white), 1 = drifting (red).
  const drift = (v: number) => scrub01(v, 0.15, 0.85);
  const headColor = useTransform(scrollYProgress, (v) =>
    mix(WHITE, RED, drift(v))
  );
  // Two stacked shadows: a flickering hot core (the "fire") inside a cooler,
  // drift-colored halo (the existing ice→red glow, now lightly sputtering too).
  const headGlow = useTransform(scrollYProgress, (v) => {
    const d = drift(v);
    const core = flicker(v, 0);
    const halo = flicker(v, 5.2);
    const coreBlur = 9 + core * 4;
    const coreSpread = 2.5 + core * 1.5;
    const coreAlpha = 0.6 + core * 0.25;
    const haloBlur = 20 + halo * 6;
    const haloSpread = 7 + halo * 2;
    const haloAlpha = 0.5 + 0.2 * d + halo * 0.1;
    return [
      `0 0 ${coreBlur}px ${coreSpread}px ${mix(FIRE_HOT, FIRE_CORE, 0.45, coreAlpha)}`,
      `0 0 ${haloBlur}px ${haloSpread}px ${mix(ICE, RED, d, haloAlpha)}`,
    ].join(", ");
  });
  const tailGradient = useTransform(
    scrollYProgress,
    (v) =>
      `linear-gradient(90deg, transparent, ${mix(ICE, RED, drift(v), 0.55)}, ${mix(
        WHITE,
        RED,
        drift(v),
        0.95
      )})`
  );

  // Bow shock ahead of the head: thicker, larger, and more present the
  // farther the comet has drifted.
  const shockWidth = useTransform(
    scrollYProgress,
    (v) => 1.5 + 4.5 * drift(v) + flicker(v, 0) * 0.6
  );
  const shockScale = useTransform(scrollYProgress, (v) => 0.9 + 0.65 * drift(v));
  const shockOpacity = useTransform(
    scrollYProgress,
    (v) => Math.min(1, Math.max(0, 0.85 * drift(v) + flicker(v, 5.2) * 0.12))
  );
  const shockColor = useTransform(scrollYProgress, (v) =>
    mix(ICE, RED, drift(v), 0.8)
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
        <motion.div
          className="h-[3px] w-40 rounded-full md:w-64 bg-[linear-gradient(90deg,transparent,rgba(196,220,230,0.55),rgba(255,255,255,0.95))]"
          style={reduced ? undefined : { background: tailGradient }}
        />
        <motion.div
          className="absolute -right-1.5 top-1/2 size-[12px] -translate-y-1/2 rounded-full bg-white shadow-[0_0_20px_7px_rgba(196,220,230,0.5)]"
          style={
            reduced
              ? undefined
              : { backgroundColor: headColor, boxShadow: headGlow }
          }
        />
        {/* Bow shock — an arc bulging ahead of the head (travel is +x). */}
        {!reduced && (
          <motion.div
            className="absolute top-1/2 h-[32px] w-[20px] -translate-y-1/2 rounded-full border border-transparent blur-[1.5px]"
            style={{
              right: -19,
              borderRightColor: shockColor,
              borderWidth: shockWidth,
              scale: shockScale,
              opacity: shockOpacity,
            }}
          />
        )}
      </motion.div>
    </div>
  );
}
