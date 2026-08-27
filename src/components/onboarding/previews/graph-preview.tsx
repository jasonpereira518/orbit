"use client";

import { motion } from "motion/react";
import type { PreviewProps } from "@/components/onboarding/tour-config";
import {
  VIRGO_CHAINS as CHAINS,
  VIRGO_FIELD_STARS as FIELD_STARS,
  VIRGO_STARS as STARS,
} from "@/lib/virgo-figure";

export function GraphPreview({ reducedMotion }: PreviewProps) {
  const byId = Object.fromEntries(STARS.map((s) => [s.id, s]));

  return (
    <div className="space-y-3 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-ink">
        Constellation
      </p>
      <div
        data-tour-hotspot="figure"
        className="relative h-[180px] overflow-hidden rounded-xl border border-border/60 bg-[radial-gradient(ellipse_at_center,_#1a2030_0%,_#0a0c12_60%,_#05060a_100%)]"
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
