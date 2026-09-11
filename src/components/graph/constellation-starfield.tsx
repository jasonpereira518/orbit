"use client";

import { useMemo, type CSSProperties } from "react";
import { CONSTELLATION_STAR_PX } from "@/lib/graph/starfield-scale";

/**
 * The DOM sky behind the React Flow chart: 220 twinkling spans.
 *
 * Its own module so `network-graph.tsx` can keep rendering it as a sibling of the chart
 * — it must stay ahead of the toolbars in DOM order to paint underneath them — without
 * that import dragging the React Flow chunk onto a phone. The canvas renderer paints an
 * equivalent field into its own backing store instead of mounting any of this.
 */
export function Starfield() {
  const stars = useMemo(
    () =>
      Array.from({ length: 220 }, (_, i) => ({
        id: i,
        left: `${(((i * 47 + 13) * 7) % 1000) / 10}%`,
        top: `${(((i * 83 + 29) * 11) % 1000) / 10}%`,
        // Named rather than inline: the warp intro sizes its own field off these, and the two
        // are drawn over the same box during the hand-off. See `starfield-scale.ts`.
        size:
          i % 17 === 0
            ? CONSTELLATION_STAR_PX.brightest
            : i % 5 === 0
              ? CONSTELLATION_STAR_PX.bright
              : CONSTELLATION_STAR_PX.common,
        delay: `${(i % 11) * 0.35}s`,
        dur: `${2.8 + (i % 6) * 0.7}s`,
        opacity: 0.25 + (i % 8) * 0.08,
      })),
    []
  );

  return (
    <div
      className="constellation-starfield pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <div className="constellation-milky-way absolute inset-0" />
      {stars.map((s) => (
        <span
          key={s.id}
          className="absolute rounded-full bg-white"
          style={
            {
              left: s.left,
              top: s.top,
              width: s.size,
              height: s.size,
              opacity: s.opacity,
              "--twinkle-delay": s.delay,
              "--twinkle-dur": s.dur,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
