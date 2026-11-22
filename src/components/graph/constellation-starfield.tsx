"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  isCameraMoving,
  SKY_DRIFT_MAX_PX,
  subscribeCameraMoving,
  subscribeSkyDrift,
} from "@/components/graph/camera-motion";
import { CONSTELLATION_STAR_PX } from "@/lib/graph/starfield-scale";

/** Which of the two twinkle groups a star belongs to, or null for a steady star. */
function twinkleGroup(i: number): "a" | "b" | null {
  if (i % 9 === 0) return "a";
  if (i % 9 === 4) return "b";
  return null;
}

const FIELD_STARS = 220;
/** Spare stars in the margin ring that a drift slides into view. */
const MARGIN_STARS = 40;
/** The drift layer overhangs the pane by this much on every side (a little over the max drift). */
const MARGIN_PX = SKY_DRIFT_MAX_PX + 4;
const M = `${MARGIN_PX}px`;

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
 * The stars also trail the camera by a few pixels (`setSkyDrift`, camera-motion.ts), which
 * is what gives the chart depth. They sit in a layer that overhangs the pane by `MARGIN_PX`
 * so a drift never uncovers an edge; the first 220 stars are placed so that, at rest, the
 * pane looks exactly as it did before the layer existed, and `MARGIN_STARS` more fill the
 * overhang. The milky way stays put as the farthest layer. Under reduced motion the drift is
 * never set (and `.constellation-starfield-drift` is pinned in theme.css).
 *
 * Its own module so `network-graph.tsx` can keep rendering it as a sibling of the chart
 * — it must stay ahead of the toolbars in DOM order to paint underneath them — without
 * that import dragging the React Flow chunk onto a phone. The canvas renderer paints an
 * equivalent field into its own backing store instead of mounting any of this.
 */
export function Starfield() {
  const driftRef = useRef<HTMLDivElement>(null);

  // Written straight to the DOM: a pan must not re-render 260 spans. The layer is promoted
  // only while the camera moves, like the chart's own (`.constellation-moving`).
  useEffect(() => {
    const el = driftRef.current;
    if (!el) return;
    const unDrift = subscribeSkyDrift((x, y) => {
      el.style.transform = x || y ? `translate3d(${x}px, ${y}px, 0)` : "";
    });
    const syncLayer = () => {
      el.style.willChange = isCameraMoving() ? "transform" : "";
    };
    const unMoving = subscribeCameraMoving(syncLayer);
    syncLayer();
    return () => {
      unDrift();
      unMoving();
    };
  }, []);

  const stars = useMemo(
    () =>
      Array.from({ length: FIELD_STARS + MARGIN_STARS }, (_, i) => {
        // Stars 0–219 sit inside the pane; the rest sit in the overhang, on side `j % 4`.
        const j = i - FIELD_STARS;
        const t = (((i * 47 + 13) * 7) % 1000) / 1000; // along the side
        const u = (((i * 83 + 29) * 11) % 1000) / 1000; // across it
        const depth = `${u * MARGIN_PX}px`;
        const pos =
          j < 0
            ? {
                left: `calc(${M} + (100% - 2 * ${M}) * ${t})`,
                top: `calc(${M} + (100% - 2 * ${M}) * ${u})`,
              }
            : [
                { left: `${t * 100}%`, top: depth },
                { left: `${t * 100}%`, top: `calc(100% - ${depth})` },
                { left: depth, top: `${t * 100}%` },
                { left: `calc(100% - ${depth})`, top: `${t * 100}%` },
              ][j % 4];
        return {
          id: i,
          group: j < 0 ? twinkleGroup(i) : null,
          ...pos,
          // Named rather than inline: the warp intro sizes its own field off these, and the two
          // are drawn over the same box during the hand-off. See `starfield-scale.ts`.
          size:
            i % 17 === 0
              ? CONSTELLATION_STAR_PX.brightest
              : i % 5 === 0
                ? CONSTELLATION_STAR_PX.bright
                : CONSTELLATION_STAR_PX.common,
          opacity: 0.25 + (i % 8) * 0.08,
        };
      }),
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
      <div
        ref={driftRef}
        className="constellation-starfield-drift absolute"
        style={{ inset: `-${M}` }}
      >
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
    </div>
  );
}
