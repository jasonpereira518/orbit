"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

/**
 * Virgo stick figure from the IAU constellation lines, projected from
 * J2000 RA/Dec (RA increases left, Dec up — standard sky-chart orientation).
 */
const STARS: Array<{
  id: string;
  x: number;
  y: number;
  r: number;
  hotspot?: "spica";
}> = [
  { id: "vir109", x: 28.0, y: 89.1, r: 2.0 },
  { id: "mu", x: 31.8, y: 140.0, r: 2.1 },
  { id: "iota", x: 65.5, y: 142.3, r: 1.9 },
  { id: "kappa", x: 69.3, y: 171.1, r: 1.8 },
  { id: "lambda", x: 61.6, y: 192.0, r: 1.6 },
  { id: "zeta", x: 116.7, y: 105.9, r: 2.4 },
  { id: "spica", x: 128.5, y: 177.1, r: 4.4, hotspot: "spica" },
  { id: "eps", x: 157.1, y: 28.0, r: 2.9 },
  { id: "delta", x: 165.3, y: 79.0, r: 2.5 },
  { id: "gamma", x: 182.5, y: 111.7, r: 3.1 },
  { id: "eta", x: 209.6, y: 106.4, r: 2.2 },
  { id: "omi", x: 227.8, y: 43.0, r: 1.9 },
  { id: "beta", x: 245.8, y: 89.9, r: 2.3 },
  { id: "nu", x: 252.0, y: 57.9, r: 1.8 },
];

/** IAU Virgo stick-figure segments (pen-up between arrays). */
const CHAINS: string[][] = [
  ["vir109", "mu", "iota", "kappa", "lambda"],
  ["iota", "gamma", "eta", "beta", "nu", "omi", "eta"],
  ["eps", "delta", "gamma", "zeta", "spica"],
];

const FIELD_STARS: Array<[number, number]> = [
  [48, 52],
  [92, 34],
  [110, 168],
  [148, 148],
  [198, 62],
  [220, 168],
  [248, 132],
  [42, 108],
  [176, 198],
];

export function GraphPreview({ reducedMotion }: PreviewProps) {
  const byId = Object.fromEntries(STARS.map((s) => [s.id, s]));

  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Constellation
      </p>
      <div
        data-tour-hotspot="figure"
        className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border/60 bg-[radial-gradient(ellipse_at_center,_#1a2030_0%,_#0a0c12_60%,_#05060a_100%)]"
      >
        <svg
          viewBox="0 0 280 220"
          className="absolute inset-0 h-full w-full"
          aria-label="Virgo constellation"
          role="img"
        >
          <title>Virgo constellation</title>

          {FIELD_STARS.map(([x, y], i) => (
            <circle
              key={`field-${i}`}
              cx={x}
              cy={y}
              r={0.85}
              fill="rgba(232,243,241,0.26)"
            />
          ))}

          {CHAINS.flatMap((chain) =>
            chain.slice(0, -1).map((a, i) => {
              const b = chain[i + 1]!;
              const from = byId[a]!;
              const to = byId[b]!;
              return (
                <line
                  key={`${a}-${b}-${i}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="rgba(89,157,231,0.55)"
                  strokeWidth={1.2}
                  strokeLinecap="round"
                />
              );
            })
          )}

          {STARS.map((star, i) => (
            <motion.circle
              key={star.id}
              data-tour-hotspot={
                star.hotspot === "spica" ? "spica" : undefined
              }
              cx={star.x}
              cy={star.y}
              r={star.r}
              fill={star.id === "spica" ? "#e8f3f1" : "#c5d4d1"}
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={
                reducedMotion
                  ? { opacity: 1 }
                  : { opacity: [0.72, 1, 0.72] }
              }
              transition={
                reducedMotion
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
    </div>
  );
}
