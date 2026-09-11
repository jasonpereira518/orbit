"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The stakes, drawn: Priya Raman — the referral the comets scene introduced, three weeks
 * without a follow-up — drifting off her orbit as the reader scrolls into the ending. The
 * counter under her ticks from three weeks to six, the tether to the centre fades, and her
 * star slides outward past the ring and dims.
 *
 * It exists so the closing ask lands on someone the reader has already met, rather than on
 * an abstraction. It is illustration only — aria-hidden — and the heading beside it carries
 * the meaning in words. Reduced motion gets the end state, still.
 *
 * Every scrubbed value is a scrub01 function transform, never a range map: motion promotes
 * range-mapped opacity to a ViewTimeline that disagrees with target-based useScroll.
 */

/** Orbit geometry in view units. The star leaves along one radius, up and to the right. */
const CX = 180;
const CY = 104;
const RING_R = 62;
const DRIFT_R = 138;
const ANGLE = (-38 * Math.PI) / 180;
const COS = Math.cos(ANGLE);
const SIN = Math.sin(ANGLE);

/** The drift runs over the middle of the scroll window, so it reads as happening, not done. */
const drift = (v: number) => scrub01(v, 0.12, 0.82);

/** Distance from the centre at drift `d`, 0 on the ring → 1 well past it. */
const radius = (d: number) => RING_R + (DRIFT_R - RING_R) * d;

// Each scrubbed quantity as a function of drift. Module-level, so their identity is stable.
const F = {
  starX: (d: number) => radius(d) * COS,
  starY: (d: number) => radius(d) * SIN,
  starOpacity: (d: number) => 1 - 0.4 * d,
  glowOpacity: (d: number) => 0.6 - 0.35 * d,
  tetherOpacity: (d: number) => 0.5 * (1 - d),
  tetherX2: (d: number) => CX + radius(d) * COS,
  tetherY2: (d: number) => CY + radius(d) * SIN,
  weeks: (d: number) => 3 + Math.round(3 * d),
  warmOpacity: (d: number) => 1 - scrub01(d, 0.55, 0.85),
  coldOpacity: (d: number) => scrub01(d, 0.55, 0.85),
};

function useDrift(progress: MotionValue<number>, f: (d: number) => number) {
  return useTransform(progress, (v) => f(drift(v)));
}

export function FinaleDrift() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress: p } = useScroll({
    target: ref,
    // From the composition entering the bottom of the viewport to it sitting just above
    // centre — the stretch over which the reader is actually looking at it.
    offset: ["start 0.95", "end 0.45"],
  });

  const live = {
    starX: useDrift(p, F.starX),
    starY: useDrift(p, F.starY),
    starOpacity: useDrift(p, F.starOpacity),
    glowOpacity: useDrift(p, F.glowOpacity),
    tetherOpacity: useDrift(p, F.tetherOpacity),
    tetherX2: useDrift(p, F.tetherX2),
    tetherY2: useDrift(p, F.tetherY2),
    weeks: useDrift(p, F.weeks),
    warmOpacity: useDrift(p, F.warmOpacity),
    coldOpacity: useDrift(p, F.coldOpacity),
  };
  // Reduced motion renders the END of the drift as plain numbers, decided at render time —
  // not by branching inside the transformers, which would only re-run on scroll. The still
  // frame still has to say "six weeks, gone past the ring".
  const v = <K extends keyof typeof F>(k: K) => (reduced ? F[k](1) : live[k]);

  const starX = v("starX");
  const starY = v("starY");
  const starOpacity = v("starOpacity");
  const glowOpacity = v("glowOpacity");
  const tetherOpacity = v("tetherOpacity");
  const tetherX2 = v("tetherX2");
  const tetherY2 = v("tetherY2");
  const weeks = v("weeks");
  const warmOpacity = v("warmOpacity");
  const coldOpacity = v("coldOpacity");

  return (
    <div ref={ref} aria-hidden className="relative mx-auto mb-10 w-full max-w-[460px]">
      <svg viewBox="0 0 360 176" className="h-auto w-full overflow-visible">
        <defs>
          <radialGradient id="finale-drift-glow">
            <stop offset="0%" stopColor="#f2c14e" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#f2c14e" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Her orbit, and the reader at its centre. */}
        <circle
          cx={CX}
          cy={CY}
          r={RING_R}
          fill="none"
          stroke="#e8f3f1"
          strokeOpacity={0.2}
          strokeDasharray="3 5"
        />
        <circle cx={CX} cy={CY} r={5} fill="#e8f3f1" fillOpacity={0.85} />
        <circle cx={CX} cy={CY} r={14} fill="#e8f3f1" fillOpacity={0.06} />
        {/* The bond to the centre, thinning as she goes. */}
        <motion.line
          x1={CX}
          y1={CY}
          x2={tetherX2}
          y2={tetherY2}
          stroke="#f2c14e"
          strokeWidth={1}
          strokeDasharray="2 4"
          style={{ opacity: tetherOpacity }}
        />
        <motion.g style={{ x: starX, y: starY }}>
          <g transform={`translate(${CX} ${CY})`}>
            <motion.circle r={16} fill="url(#finale-drift-glow)" style={{ opacity: glowOpacity }} />
            <motion.circle r={5} fill="#f2c14e" style={{ opacity: starOpacity }} />
          </g>
        </motion.g>
      </svg>

      <div className="mx-auto -mt-1 flex w-fit items-center gap-3 rounded-full border border-[#e8f3f1]/[0.12] bg-[#05070f]/60 py-1.5 pl-1.5 pr-3 text-left">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#0f3d3e] text-xs font-medium text-[#e8f3f1]">
          PR
        </span>
        <span className="text-sm leading-tight">
          <span className="block text-[#e8f3f1]">Priya Raman</span>
          <span className="block text-xs text-[#9aada8]">
            Referral call · <motion.span className="tabular-nums">{weeks}</motion.span> weeks
            ago
          </span>
        </span>
        {/* The two states share one slot and cross-fade, so the pill never jumps width. */}
        <span className="relative ml-1 grid shrink-0 text-xs">
          <motion.span
            className="col-start-1 row-start-1 rounded-full bg-[#f2c14e]/15 px-2.5 py-1 text-[#f2c14e]"
            style={{ opacity: warmOpacity }}
          >
            Follow up today
          </motion.span>
          <motion.span
            className="col-start-1 row-start-1 rounded-full bg-[#9aada8]/10 px-2.5 py-1 text-center text-[#9aada8]"
            style={{ opacity: coldOpacity }}
          >
            Going cold
          </motion.span>
        </span>
      </div>
    </div>
  );
}
