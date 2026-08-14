"use client";

import { useRef, useState } from "react";
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

const CLUSTER_NAME = "Amazon Web Services (AWS)";
const CLUSTER_BRAND = "#ff9900";

/** Demo people, one per figure star (landing-only; the shared Virgo data
 * in src/lib/virgo-figure.ts stays name-free). */
const STAR_NAMES: Record<string, string> = {
  vir109: "Maya Patel",
  mu: "Dan Kowalski",
  iota: "Priya Raman",
  kappa: "Chris Okafor",
  lambda: "Sofia Reyes",
  zeta: "Ben Liu",
  spica: "Sarah Chen",
  eps: "Tom Nguyen",
  delta: "Alicia Gomez",
  gamma: "Marcus Webb",
  eta: "Nina Shah",
  omi: "Jake Turner",
  beta: "Elena Petrova",
  nu: "Omar Haddad",
};

const FADE = {
  transitionDuration: "var(--transition-duration-base)",
  transitionTimingFunction: "var(--ease-house)",
} as const;

/**
 * Scene B centerpiece: the Virgo figure draws itself in as the section
 * scrolls through the viewport — scrubbed and reversible, Apple-style.
 * Hovering the figure reveals its cluster name (styled like the /graph
 * ClusterLabelNodeComponent); hovering a star fades in a person's name.
 * Plain SSR-safe SVG; this component is the scene's reduced-motion gate
 * (scroll-linked bindings bypass the CSS clamp and MotionConfig).
 */
export function ConstellationFigure({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [figureHovered, setFigureHovered] = useState(false);
  const [hoveredStar, setHoveredStar] = useState<string | null>(null);

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
      onMouseEnter={() => setFigureHovered(true)}
      onMouseLeave={() => {
        setFigureHovered(false);
        setHoveredStar(null);
      }}
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

        {/* Star name reveals — fade in under the hovered star, fade out
            on leave. Rendered before the hit circles so hits stay on top. */}
        {VIRGO_STARS.map((star) => {
          const name = STAR_NAMES[star.id];
          if (!name) return null;
          return (
            <text
              key={`name-${star.id}`}
              x={star.x}
              y={star.y + star.r + 8}
              textAnchor="middle"
              className="pointer-events-none transition-opacity"
              style={{
                ...FADE,
                fill: "rgba(255,255,255,0.95)",
                fontSize: 6,
                fontWeight: 500,
                opacity: hoveredStar === star.id ? 1 : 0,
              }}
            >
              {name}
            </text>
          );
        })}

        {/* Invisible hit circles — the visual stars (r 1.6–4.4) are too
            small to hover reliably. */}
        {VIRGO_STARS.map((star) => (
          <circle
            key={`hit-${star.id}`}
            cx={star.x}
            cy={star.y}
            r={9}
            fill="transparent"
            style={{ pointerEvents: "all" }}
            onMouseEnter={() => setHoveredStar(star.id)}
            onMouseLeave={() =>
              setHoveredStar((prev) => (prev === star.id ? null : prev))
            }
          />
        ))}
      </svg>

      {/* Cluster name — the /graph cluster-label treatment: white text over
          a brand-color copy offset by 0.75px. */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-[2%] -translate-x-1/2 transition-opacity",
          figureHovered ? "opacity-100" : "opacity-0"
        )}
        style={FADE}
      >
        <span className="relative inline-block whitespace-nowrap text-center text-[11px] font-semibold tracking-[0.08em]">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 translate-x-[0.75px] translate-y-[0.75px] select-none"
            style={{ color: CLUSTER_BRAND }}
          >
            {CLUSTER_NAME}
          </span>
          <span className="relative text-white">{CLUSTER_NAME}</span>
        </span>
      </div>
    </div>
  );
}
