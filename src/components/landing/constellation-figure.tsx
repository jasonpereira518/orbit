"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { scrub01 } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  VIRGO_CHAINS,
  VIRGO_FIELD_STARS,
  VIRGO_STARS,
  virgoChainPath,
} from "@/lib/virgo-figure";

/**
 * Scene B centerpiece: the Virgo figure draws itself in as the section
 * scrolls through the viewport — scrubbed and reversible, Apple-style.
 * Plain SSR-safe SVG; this component is the scene's reduced-motion gate
 * (scroll-linked bindings bypass the CSS clamp and MotionConfig).
 */
export function ConstellationFigure({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "center 0.45"],
  });

  // Chains overlap their draw windows so the figure feels continuous.
  // Function transforms (scrub01) keep pathLength off the WAAPI path.
  const chainProgress = [
    useTransform(scrollYProgress, (v) => scrub01(v, 0, 0.45)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.25, 0.7)),
    useTransform(scrollYProgress, (v) => scrub01(v, 0.5, 1)),
  ];

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("relative aspect-[4/3] w-full", className)}
    >
      <svg viewBox="0 0 280 220" className="absolute inset-0 h-full w-full">
        {VIRGO_FIELD_STARS.map(([x, y], i) => (
          <circle
            key={`field-${i}`}
            cx={x}
            cy={y}
            r={0.85}
            fill="rgba(232,243,241,0.26)"
          />
        ))}

        {VIRGO_CHAINS.map((chain, i) => (
          <motion.path
            key={i}
            d={virgoChainPath(chain)}
            fill="none"
            stroke="rgba(89,157,231,0.55)"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={reduced ? undefined : { pathLength: chainProgress[i] }}
          />
        ))}

        {VIRGO_STARS.map((star, i) => (
          <motion.circle
            key={star.id}
            cx={star.x}
            cy={star.y}
            r={star.r}
            fill={star.id === "spica" ? "#e8f3f1" : "#c5d4d1"}
            initial={reduced ? false : { opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: [0.72, 1, 0.72] }}
            transition={
              reduced
                ? { duration: 0 }
                : {
                    duration: 2.4 + (i % 3) * 0.3,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: i * 0.05,
                  }
            }
          />
        ))}
      </svg>
    </div>
  );
}
