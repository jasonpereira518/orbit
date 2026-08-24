"use client";

import { useRef, useState, type MouseEvent } from "react";
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from "motion/react";
import { scrub01 } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  DIPPER_CHAINS,
  DIPPER_FIELD_STARS,
  DIPPER_STARS,
  dipperChainPath,
} from "@/lib/big-dipper-figure";

const CLUSTER_NAME = "Amazon Web Services (AWS)";
const CLUSTER_BRAND = "#ff9900";
const VIEW_W = 280;
const VIEW_H = 220;
/** Hover radius in viewBox units — generous so the small stars are easy to hit. */
const HOVER_R2 = 22 * 22;

/** Scroll-progress linger after a line crosses a node (0–1 scrub range). */
const NAME_FADE_IN = 0.012;
const NAME_HOLD = 0.16;
const NAME_FADE_OUT = 0.055;

/** Demo people, one per figure star (landing-only; the shared Big Dipper data
 * in src/lib/big-dipper-figure.ts stays name-free). */
const STAR_NAMES: Record<string, string> = {
  dubhe: "Maya Patel",
  merak: "Dan Kowalski",
  phecda: "Priya Raman",
  megrez: "Marcus Webb",
  alioth: "Sarah Chen",
  mizar: "Nina Shah",
  alkaid: "Elena Petrova",
};

const FADE = {
  transitionDuration: "var(--transition-duration-base)",
  transitionTimingFunction: "var(--ease-house)",
} as const;

/** Overlapping draw windows — compact so the figure completes quickly. */
const CHAIN_WINDOWS = [
  [0, 0.36],
  [0.18, 0.64],
  [0.42, 1],
] as const;

/** Every time a chain stroke reaches a node — junction stars included,
 * and the same star may appear more than once (Megrez closes the bowl and
 * starts the handle, so it fires three times). */
const CROSSINGS_BY_STAR: Record<string, number[]> = (() => {
  const map: Record<string, number[]> = {};
  DIPPER_CHAINS.forEach((chain, i) => {
    const [a, b] = CHAIN_WINDOWS[i]!;
    const segs = Math.max(1, chain.length - 1);
    chain.forEach((id, j) => {
      const t = a + (j / segs) * (b - a);
      (map[id] ??= []).push(t);
    });
  });
  return map;
})();

function crossingOpacity(v: number, times: number[]) {
  let max = 0;
  const window = NAME_FADE_IN + NAME_HOLD + NAME_FADE_OUT;

  for (const t of times) {
    const dt = v - t;
    if (dt < 0 || dt > window) continue;
    if (dt <= NAME_FADE_IN) {
      max = Math.max(max, dt / NAME_FADE_IN);
    } else if (dt <= NAME_FADE_IN + NAME_HOLD) {
      max = Math.max(max, 1);
    } else {
      max = Math.max(
        max,
        1 - (dt - NAME_FADE_IN - NAME_HOLD) / NAME_FADE_OUT
      );
    }
  }

  return max;
}

function nearestStarId(x: number, y: number): string | null {
  let best: string | null = null;
  let bestD = HOVER_R2;
  for (const star of DIPPER_STARS) {
    const d = (star.x - x) ** 2 + (star.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = star.id;
    }
  }
  return best;
}

/**
 * Scene B centerpiece: the Big Dipper draws itself in as the section
 * scrolls through the viewport — scrubbed and reversible, Apple-style.
 * Each chain crossing triggers that node's name; junction stars fire on
 * every line that reaches them. Names hold, then fade. Hover near a star
 * to pin its name. This component is the scene's reduced-motion gate.
 */
export function ConstellationFigure({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [figureHovered, setFigureHovered] = useState(false);
  const [hoveredStar, setHoveredStar] = useState<string | null>(null);

  // Completes with the figure's centre a third of the way up the viewport
  // rather than at the midpoint — the draw kept finishing while there was
  // still a good deal of the scene left to scroll past.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.78", "center 0.3"],
  });

  const chainProgress = [
    useTransform(scrollYProgress, (v) =>
      scrub01(v, CHAIN_WINDOWS[0][0], CHAIN_WINDOWS[0][1])
    ),
    useTransform(scrollYProgress, (v) =>
      scrub01(v, CHAIN_WINDOWS[1][0], CHAIN_WINDOWS[1][1])
    ),
    useTransform(scrollYProgress, (v) =>
      scrub01(v, CHAIN_WINDOWS[2][0], CHAIN_WINDOWS[2][1])
    ),
  ];

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW_H;
    const id = nearestStarId(x, y);
    setHoveredStar((prev) => (prev === id ? prev : id));
  }

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("relative aspect-[4/3] w-full overflow-visible", className)}
      onMouseEnter={() => setFigureHovered(true)}
      onMouseMove={onMove}
      onMouseLeave={() => {
        setFigureHovered(false);
        setHoveredStar(null);
      }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        {DIPPER_FIELD_STARS.map(([x, y], i) => (
          <circle
            key={`field-${i}`}
            cx={x}
            cy={y}
            r={0.85}
            fill="rgba(232,243,241,0.26)"
          />
        ))}

        {DIPPER_CHAINS.map((chain, i) => (
          <motion.path
            key={i}
            d={dipperChainPath(chain)}
            fill="none"
            stroke="rgba(89,157,231,0.55)"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={reduced ? undefined : { pathLength: chainProgress[i] }}
          />
        ))}

        {DIPPER_STARS.map((star, i) => (
          <motion.circle
            key={star.id}
            cx={star.x}
            cy={star.y}
            r={star.r}
            fill={star.hotspot ? "#e8f3f1" : "#c5d4d1"}
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

      {DIPPER_STARS.map((star) => {
        const name = STAR_NAMES[star.id];
        const crossings = CROSSINGS_BY_STAR[star.id];
        if (!name || !crossings?.length) return null;
        return (
          <StarNameLabel
            key={`name-${star.id}`}
            star={star}
            name={name}
            crossings={crossings}
            scrollYProgress={scrollYProgress}
            reduced={reduced}
            hovered={hoveredStar === star.id}
          />
        );
      })}

      {/* Cluster name — the /graph cluster-label treatment: white text over
          a brand-color copy offset by 0.75px. Sits over the bowl rather than
          the box's centre line: the tilted figure's high ground is Dubhe on
          the right, so a box-centred label floated in empty sky. */}
      <div
        className={cn(
          "pointer-events-none absolute left-[72%] top-[19%] -translate-x-1/2 transition-opacity",
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

function StarNameLabel({
  star,
  name,
  crossings,
  scrollYProgress,
  reduced,
  hovered,
}: {
  star: (typeof DIPPER_STARS)[number];
  name: string;
  crossings: number[];
  scrollYProgress: MotionValue<number>;
  reduced: boolean;
  hovered: boolean;
}) {
  const scrollOpacity = useTransform(scrollYProgress, (v) =>
    reduced ? 0 : crossingOpacity(v, crossings)
  );

  return (
    <motion.div
      className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-[11px] font-medium tracking-wide text-white/95"
      style={{
        left: `${(star.x / VIEW_W) * 100}%`,
        top: `${((star.y + star.r + 8) / VIEW_H) * 100}%`,
        opacity: hovered ? 1 : scrollOpacity,
      }}
    >
      {name}
    </motion.div>
  );
}
