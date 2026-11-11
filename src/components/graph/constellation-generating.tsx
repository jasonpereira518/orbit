"use client";

import { useSyncExternalStore } from "react";
import { getGenerating, subscribe } from "@/lib/graph/generating-signal";
import { STAGE_GENERATING_LAYER, STAGE_GROUND } from "@/lib/graph/stage-layers";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The scene while a new view is drawn: stars light up and join around the prompt the person
 * wrote, then the real sky fades in under it.
 *
 * Mounted beside `ConstellationIntro`, outside the Suspense boundary, so it survives the route
 * swap to the new view and the bus (`generating-signal.ts`) decides when it ends.
 */

/** One fixed figure (viewBox 0 0 100 60), so the scene reads the same every time. */
const STARS: ReadonlyArray<readonly [number, number, number]> = [
  [14, 38, 1.4],
  [27, 22, 1.8],
  [41, 31, 1.2],
  [50, 12, 2.2],
  [58, 40, 1.6],
  [71, 26, 1.3],
  [84, 16, 1.9],
  [86, 44, 1.2],
  [33, 50, 1.1],
];
/** Pairs of STARS indices; drawn in this order. */
const LINES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 3],
  [3, 5],
  [5, 6],
  [5, 7],
];

export function ConstellationGenerating() {
  const generating = useSyncExternalStore(subscribe, getGenerating, () => null);
  const reduced = usePrefersReducedMotion();
  if (!generating) return null;
  const leaving = generating.phase === "leaving";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl px-6",
        STAGE_GROUND,
        STAGE_GENERATING_LAYER,
        "animate-in fade-in-0 duration-300 transition-opacity motion-reduce:animate-none",
        leaving && "opacity-0"
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 100 60"
        className={cn("w-[min(22rem,80%)]", !reduced && "constellation-generating")}
      >
        {LINES.map(([a, b], i) => (
          <line
            key={i}
            x1={STARS[a][0]}
            y1={STARS[a][1]}
            x2={STARS[b][0]}
            y2={STARS[b][1]}
            pathLength={1}
            stroke="rgba(170,200,255,0.45)"
            strokeWidth={0.35}
            strokeLinecap="round"
            className="constellation-generating-line"
            style={{ animationDelay: `${0.9 + i * 0.35}s` }}
          />
        ))}
        {STARS.map(([x, y, r], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={r * 0.6}
            fill="#f4f7ff"
            className="constellation-generating-star"
            // Two delays, one per animation in the CSS: the twinkle starts once this star is in.
            style={{ animationDelay: `${i * 0.12}s, ${i * 0.12 + 0.6}s` }}
          />
        ))}
      </svg>
      <div className="max-w-md text-center">
        {/* User input: plain text only, held to two lines. */}
        <p className="line-clamp-2 break-words font-[family-name:var(--font-display)] text-lg text-white/85">
          “{generating.prompt}”
        </p>
        <p className="mt-1.5 text-sm text-white/55">Charting your constellation…</p>
      </div>
    </div>
  );
}
