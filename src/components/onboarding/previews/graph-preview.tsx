"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const CENTER = { x: 140, y: 110 };

/** Two logarithmic-ish spiral arms, drawn as faint dust lanes behind everything. */
const ARMS = [
  "M140,110 C120,80 70,70 40,95 C15,116 5,150 20,180",
  "M140,110 C165,140 215,150 245,125 C270,104 275,68 258,42",
];

/** A couple of orbit rings around the user, matching the real inner/mid/outer bands. */
const ORBITS = [46, 82];

/** Small mini-constellation shapes (unit-scaled) standing in for company/school clusters. */
const CLUSTER_SHAPES = [
  {
    center: { x: 78, y: 62 },
    scale: 16,
    stars: [
      { x: -1, y: 0.15 },
      { x: 0, y: 0 },
      { x: 1, y: -0.12 },
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
  },
  {
    center: { x: 205, y: 150 },
    scale: 15,
    stars: [
      { x: -1.05, y: 0.25 },
      { x: -0.4, y: -0.5 },
      { x: 0.15, y: 0.4 },
      { x: 0.75, y: -0.35 },
      { x: 1.1, y: 0.15 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
] as const;

const FIELD_STARS: Array<[number, number]> = [
  [48, 30], [95, 22], [232, 70], [255, 160], [190, 25],
  [30, 145], [115, 195], [265, 195], [155, 30], [60, 175],
];

export function GraphPreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Constellation
      </p>
      <div
        data-tour-hotspot="sun"
        className="relative h-[180px] overflow-hidden rounded-xl border border-border/60 bg-[radial-gradient(ellipse_at_center,_#1a2030_0%,_#0a0c12_60%,_#05060a_100%)]"
      >
        <svg
          viewBox="0 0 280 220"
          className="absolute inset-0 h-full w-full"
          aria-label="Your network as a spiral galaxy, centered on you with clusters orbiting by company and closeness"
          role="img"
        >
          <title>Your network, arranged as a spiral galaxy around you</title>

          {FIELD_STARS.map(([x, y], i) => (
            <circle
              key={`field-${i}`}
              cx={x}
              cy={y}
              r={0.8}
              fill="rgba(232,243,241,0.22)"
            />
          ))}

          {ARMS.map((d, i) => (
            <path
              key={`arm-${i}`}
              d={d}
              fill="none"
              stroke="rgba(89,157,231,0.16)"
              strokeWidth={10}
              strokeLinecap="round"
            />
          ))}

          {ORBITS.map((r) => (
            <circle
              key={`orbit-${r}`}
              cx={CENTER.x}
              cy={CENTER.y}
              r={r}
              fill="none"
              stroke="rgba(232,243,241,0.14)"
              strokeDasharray="1.5 3"
            />
          ))}

          {CLUSTER_SHAPES.map((cluster, ci) =>
            cluster.edges.map(([a, b], i) => {
              const from = cluster.stars[a]!;
              const to = cluster.stars[b]!;
              return (
                <line
                  key={`cluster-${ci}-edge-${i}`}
                  x1={cluster.center.x + from.x * cluster.scale}
                  y1={cluster.center.y + from.y * cluster.scale}
                  x2={cluster.center.x + to.x * cluster.scale}
                  y2={cluster.center.y + to.y * cluster.scale}
                  stroke="rgba(89,157,231,0.5)"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                />
              );
            })
          )}

          {CLUSTER_SHAPES.flatMap((cluster, ci) =>
            cluster.stars.map((s, i) => (
              <motion.circle
                key={`cluster-${ci}-star-${i}`}
                data-tour-hotspot={ci === 0 && i === 1 ? "cluster" : undefined}
                cx={cluster.center.x + s.x * cluster.scale}
                cy={cluster.center.y + s.y * cluster.scale}
                r={i === 1 ? 2.4 : 1.9}
                fill="#c5d4d1"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={
                  reducedMotion ? { opacity: 1 } : { opacity: [0.72, 1, 0.72] }
                }
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : {
                        duration: 2.4 + ((ci + i) % 3) * 0.3,
                        repeat: Infinity,
                        ease: "easeInOut",
                        delay: (ci + i) * 0.08,
                      }
                }
              />
            ))
          )}

          {/* The user, glowing at the center as "the sun" */}
          <motion.circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={6.5}
            fill="#f4d58d"
            initial={reducedMotion ? false : { opacity: 0.6 }}
            animate={
              reducedMotion
                ? { opacity: 1 }
                : { opacity: [0.85, 1, 0.85], scale: [1, 1.08, 1] }
            }
            transition={
              reducedMotion
                ? { duration: 0 }
                : { duration: 3, repeat: Infinity, ease: "easeInOut" }
            }
          />
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={11}
            fill="none"
            stroke="rgba(244,213,141,0.35)"
            strokeWidth={1}
          />
        </svg>
      </div>
    </div>
  );
}
