"use client";

import { useMemo } from "react";
import { CONSTELLATION_STAR_PX } from "@/lib/graph/starfield-scale";

/** Which of the two twinkle groups a star belongs to, or null for a steady star. */
function twinkleGroup(i: number): "a" | "b" | null {
  if (i % 9 === 0) return "a";
  if (i % 9 === 4) return "b";
  return null;
}

/**
 * The DOM sky behind the React Flow chart: 220 stars, almost all of them steady.
 *
 * Every span used to run its own infinite twinkle, and an element with a running opacity
 * animation is a compositor layer — 220 layers standing permanently under a chart that
 * already holds a thousand more. That was part of the GPU memory pressure that made Chrome
 * drop the sidebar's tiles, which read as the sidebar flashing blank. Now the steady stars
 * paint once, and the twinkle lives on two wrappers of ~25 stars each that breathe in
 * counter-phase: two layers, and still a sky that is quietly alive.
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
        group: twinkleGroup(i),
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
        opacity: 0.25 + (i % 8) * 0.08,
      })),
    []
  );

  const renderStars = (group: "a" | "b" | null) =>
    stars
      .filter((s) => s.group === group)
      .map((s) => (
        <span
          key={s.id}
          className="absolute rounded-full bg-white"
          style={{
            left: s.left,
            top: s.top,
            width: s.size,
            height: s.size,
            opacity: s.opacity,
          }}
        />
      ));

  return (
    <div
      className="constellation-starfield pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <div className="constellation-milky-way absolute inset-0" />
      {renderStars(null)}
      <div className="constellation-twinkle-group absolute inset-0">
        {renderStars("a")}
      </div>
      <div
        className="constellation-twinkle-group absolute inset-0"
        style={{ animationDelay: "-3.5s" }}
      >
        {renderStars("b")}
      </div>
    </div>
  );
}
