"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import "./comet-streak.css";

/**
 * Sparks are CSS-animated (not scroll-scrubbed). Driving opacity/x/y from
 * useTransform on every spark forced ~24 MotionValue updates per scroll
 * frame and was the main hitch when this section entered view.
 */
const SPARKS = [
  { top: "38%", left: "62%", size: 2.5, hot: true, delay: "0s" },
  { top: "46%", left: "74%", size: 2, hot: false, delay: "0.2s" },
  { top: "54%", left: "68%", size: 2.5, hot: true, delay: "0.38s" },
  { top: "32%", left: "70%", size: 1.5, hot: false, delay: "0.55s" },
] as const;

/**
 * Scene C centerpiece: a meteor scrubbed across the reminders section.
 * Performance: a single motion wrapper owns x/y/opacity. Glow, trail, and
 * sparks are static (or CSS-animated) children so scroll doesn’t re-paint
 * blurs or re-run per-spark transforms. Reduced motion: resting pose.
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
  const opacity = useTransform(scrollYProgress, (v) =>
    v < 0.5 ? scrub01(v, 0.12, 0.5) : 1 - scrub01(v, 0.5, 0.88)
  );

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <motion.div
        className="comet-streak absolute left-0 top-[6%] rotate-[11deg]"
        style={
          reduced
            ? { left: "58%", top: "14%", opacity: 0.45 }
            : { x, y, opacity }
        }
      >
        {/* Art’s ~45° diagonal neutralized with -rotate-45 so the rock leads
            along +x; container’s 11° is the shallow dive. */}
        <div className="relative h-14 w-14 md:h-[4.25rem] md:w-[4.25rem]">
          {/* Trail — sits behind the flame (left), fades out; no filled disc. */}
          <div
            className="absolute top-[46%] right-[55%] h-3 w-48 -translate-y-1/2 rounded-full opacity-50 blur-[6px] md:w-72"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,107,74,0.35) 55%, rgba(255,179,71,0.45) 100%)",
            }}
          />
          <div
            className="absolute top-[48%] right-[52%] h-[3px] w-56 -translate-y-1/2 rounded-full opacity-80 blur-[1.5px] md:h-[3.5px] md:w-80"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,107,74,0.15) 35%, rgba(255,179,71,0.55) 75%, rgba(255,241,204,0.7) 100%)",
            }}
          />
          <div
            className="absolute top-[48%] right-[50%] h-px w-64 -translate-y-1/2 rounded-full opacity-70 md:w-96"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,179,71,0.2) 50%, rgba(255,241,204,0.65) 100%)",
            }}
          />

          {/* Soft bloom behind the rock only — never a hard circular plate. */}
          <div
            className="absolute left-[52%] top-[48%] z-[1] h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-90 blur-md md:h-9 md:w-9"
            style={{
              background:
                "radial-gradient(circle, rgba(255,241,204,0.9) 0%, rgba(255,179,71,0.55) 45%, transparent 70%)",
            }}
          />
          <div
            className="absolute left-[52%] top-[48%] z-[1] h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70 blur-lg md:h-12 md:w-12"
            style={{
              background:
                "radial-gradient(circle, rgba(255,107,74,0.45) 0%, rgba(255,107,74,0.15) 50%, transparent 70%)",
            }}
          />

          {/* eslint-disable-next-line @next/next/no-img-element -- local landing bitmap */}
          <img
            src="/landing/meteor.png"
            alt=""
            draggable={false}
            decoding="async"
            className="relative z-10 size-full -scale-x-100 -rotate-45 object-contain"
          />

          {!reduced &&
            SPARKS.map((spark) => (
              <span
                key={spark.delay + spark.left}
                className="comet-spark absolute z-20 rounded-full"
                style={{
                  top: spark.top,
                  left: spark.left,
                  width: spark.size,
                  height: spark.size,
                  backgroundColor: spark.hot
                    ? "rgb(255, 241, 204)"
                    : "rgb(255, 179, 71)",
                  boxShadow: spark.hot
                    ? "0 0 6px 1px rgba(255,107,74,0.85)"
                    : "0 0 5px 1px rgba(255,179,71,0.7)",
                  animationDelay: spark.delay,
                }}
              />
            ))}
        </div>
      </motion.div>
    </div>
  );
}
