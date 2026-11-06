"use client";

import { motion, useReducedMotionConfig } from "motion/react";
import { SPRING_SOFT } from "@/lib/motion";
import type { AnchorRect } from "@/lib/tour/use-anchor-rect";

const PAD = 6;
const RADIUS = 12;

/**
 * The dim-everything-but-this layer. One SVG: a mask cuts a rounded hole where the anchor
 * is, and the ring is a second rect on the same geometry, so both glide between anchors
 * as one shape. The whole layer is `pointer-events: none` — it never blocks a click and
 * never traps focus; the sidebar, bell and everything else stay usable under it.
 *
 * No `view-transition-name` and no backdrop blur on the scrim: the former makes a backdrop
 * root that kills descendants' blur, and the latter re-rasters the largest surface on
 * screen every frame of the glide.
 */
export function TourSpotlight({
  rect,
  chip,
  visible,
}: {
  rect: AnchorRect | null;
  /** ≤5 words beside the cutout, desktop only (the phone sheet carries the copy). */
  chip?: string;
  visible: boolean;
}) {
  const reduced = useReducedMotionConfig();
  if (!visible || !rect) return null;

  const x = Math.max(0, rect.left - PAD);
  const y = Math.max(0, rect.top - PAD);
  const width = rect.width + PAD * 2;
  const height = rect.height + PAD * 2;
  const transition = reduced ? { duration: 0 } : SPRING_SOFT;

  // Put the chip where there is most room: above the cutout unless that is off the top.
  const chipAbove = y > 56;
  const chipLeft = Math.min(
    Math.max(8, x),
    Math.max(8, window.innerWidth - 240),
  );

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[55]"
      aria-hidden
      data-tour-spotlight
    >
      <svg className="absolute inset-0 h-full w-full">
        <defs>
          <mask id="orbit-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <motion.rect
              rx={RADIUS}
              fill="black"
              initial={false}
              animate={{ attrX: x, attrY: y, width, height }}
              transition={transition}
            />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="var(--tour-scrim)"
          mask="url(#orbit-tour-mask)"
        />
        <motion.rect
          rx={RADIUS}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2}
          className="tour-ring-pulse"
          style={{
            filter:
              "drop-shadow(0 0 6px color-mix(in oklab, var(--primary) 45%, transparent))",
          }}
          initial={false}
          animate={{ attrX: x, attrY: y, width, height }}
          transition={transition}
        />
      </svg>
      {chip && (
        <motion.div
          initial={false}
          animate={{
            left: chipLeft,
            top: chipAbove ? y - 40 : y + height + 10,
          }}
          transition={transition}
          className="absolute hidden md:block"
        >
          {/* Glass on the inner span: `.liquid-glass` sets `position: relative` and would
              undo the absolute placement above. */}
          <span className="liquid-glass inline-block max-w-[15rem] truncate rounded-full px-3 py-1.5 text-xs font-medium text-ink">
            {chip}
          </span>
        </motion.div>
      )}
    </div>
  );
}
