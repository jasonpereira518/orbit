"use client";

import { useEffect, useRef } from "react";
import { animate, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { Glass, type GlassOptics } from "@samasante/liquid-glass";
import { TabRowFace, type TabFaceItem } from "@/components/layout/tab-row-face";

/**
 * The active-tab pill as a liquid-glass lens: it magnifies and bends the tab it sits on.
 *
 * Decorative only, laid over the real tab row with `pointer-events: none`, so every tap,
 * drag and long-press still lands on the real row underneath. It refracts a COPY of the
 * row (`TabRowFace`) rather than the row itself; see `tab-row-face.tsx` for why. The
 * lens body is a solid fill (`--nav-lens-fill`), which hides the real icons directly
 * beneath it, so the bent copy never shows next to a crisp duplicate.
 *
 * Bending the page BEHIND the bar is deliberately not attempted: that needs
 * `backdrop-filter: url()`, which no iOS browser supports, so iPhones would never see it.
 *
 * Loaded with `next/dynamic`, so the package stays out of the chunk every app page needs;
 * `MobileNav` keeps its plain CSS pill until `onReady` fires.
 */

// Refraction strength. Barely there at rest, so a stationary lens leaves its tab almost
// untouched; pressing turns it up, so the lifted lens visibly bends and magnifies what's
// under it, with the colour split at the rim growing with it. No blur either way: the
// press reads as more glass, not frosted glass.
const REST_STRENGTH = 0.02;
const LIFT_STRENGTH = 0.07;
const STRENGTH_EASE = { duration: 0.22, ease: "easeOut" } as const;

// How the sharp copy (see `crispRef` below) hands over on a press: it pulls in to the
// lens's flat core fast, so the rim's refraction shows at once, and widens back once the
// lift has mostly settled, so the release still reads as glass before it goes sharp.
const CORE_IN = { duration: 0.12, ease: "easeOut" } as const;
const CORE_OUT = { duration: 0.18, delay: 0.12, ease: "easeOut" } as const;
// Where the sharp core's soft edge starts, as a fraction of its radius.
const CORE_SOLID = 0.65;

// `depth` is how far in from the rim the bend reaches; with no `curvature` the middle
// inside it stays flat, not domed. That flat middle is what lets a sharp, unfiltered copy
// stand in for it exactly (a dome would magnify, and the two would disagree), so the
// lifted lens bends only at the rim and keeps a crisp centre. DEPTH is read below too.
const DEPTH = 0.3;

const OPTICS: Partial<GlassOptics> = {
  strength: REST_STRENGTH,
  depth: DEPTH,
  curvature: 0,
  bend: 0.3,
  dispersion: 0.15,
  sheen: 0.35,
  glow: 0.12,
  // Follows the lens. Faint at rest (the old pill's shadow-sm and hairline ring), and
  // deepened by `shadowOpacity` when lifted, so the swollen lens reads as raised off the
  // bar rather than as a flat disc. Neutral black so it works on both themes.
  edgeShadow: "0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 8px 20px -6px rgba(0, 0, 0, 0.35)",
};

const REST_SHADOW = 0.3;

// `--ease-glide` and the 280ms of the CSS pill, so the lens moves exactly like the
// fallback it replaces.
const GLIDE = { duration: 0.28, ease: [0.77, 0, 0.175, 1] as const };

// While dragging, the lens trails the finger on a stiff spring: close enough to feel held,
// loose enough to read as glass with some mass rather than a cursor.
const FOLLOW = { type: "spring", stiffness: 900, damping: 55 } as const;

// Holding the active tab lifts the lens off the bar, like iOS: it swells past the bar's
// top and bottom edges while the finger is down and settles back on release. A springy
// rise reads as the glass answering the press; a firmer settle stops it wobbling.
const LIFT = { type: "spring", stiffness: 520, damping: 26 } as const;
const SETTLE = { type: "spring", stiffness: 420, damping: 34 } as const;
// How far the lifted lens overhangs the bar, above and below. It scales up uniformly to
// get there, keeping the pill's own proportions rather than rounding into a circle.
const LIFT_OVERHANG_PX = 9;
// The package clamps the lens centre so the lens never leaves its own box, so the box
// has to be bigger than the row for the lifted lens to overhang it. The layer reaches
// this far past the row, and the copy is inset by the same amounts so it still lines up
// with the real row. Y must exceed LIFT_OVERHANG_PX; X covers the lifted lens's extra
// width at the end tabs (about 19px a side, plus spring overshoot, less the row's
// 6px padding).
const STAGE_MARGIN_X = 24;
const STAGE_MARGIN_Y = 12;

export type PillBox = { x: number; y: number; w: number; h: number };

export default function NavLens({
  pillBox,
  listSize,
  visible,
  reducedMotion,
  items,
  entryIndex,
  highlightIndex,
  pressedIndex,
  pendingIndex,
  lifted,
  dragging,
  dragX,
  dragBounds,
  onReady,
}: {
  pillBox: PillBox;
  listSize: { w: number; h: number };
  visible: boolean;
  reducedMotion: boolean;
  items: TabFaceItem[];
  entryIndex: number[];
  highlightIndex: number;
  pressedIndex: number | null;
  pendingIndex: number;
  /** A finger is down on the active tab (or dragging it): swell past the bar. */
  lifted: boolean;
  /**
   * While true the lens follows `dragX` (the finger, in px from the row's left edge)
   * anywhere between `dragBounds`, instead of sitting on a tab. On release it snaps to
   * `pillBox`, whichever tab the drag ended on.
   */
  dragging: boolean;
  dragX: MotionValue<number>;
  dragBounds: { min: number; max: number };
  onReady: (ready: boolean) => void;
}) {
  const stageW = listSize.w + STAGE_MARGIN_X * 2;
  const stageH = listSize.h + STAGE_MARGIN_Y * 2;
  const targetX = (STAGE_MARGIN_X + pillBox.x + pillBox.w / 2) / stageW;
  const targetY = (STAGE_MARGIN_Y + pillBox.y + pillBox.h / 2) / stageH;
  const x = useMotionValue(targetX);
  const y = useMotionValue(targetY);

  // At rest, and on release, the lens goes to its tab. `dragging` is a dependency so the
  // snap still runs when the drag ends on the tab it started from, where `targetX` never
  // changed.
  useEffect(() => {
    if (dragging) return;
    if (reducedMotion) {
      x.jump(targetX);
      y.jump(targetY);
      return;
    }
    const ax = animate(x, targetX, GLIDE);
    const ay = animate(y, targetY, GLIDE);
    return () => {
      ax.stop();
      ay.stop();
    };
  }, [targetX, targetY, dragging, reducedMotion, x, y]);

  // Mid-drag, the lens follows the finger, held inside the row's first and last tabs.
  // Each move restarts the spring from the current velocity, so a flick carries through.
  const { min: dragMin, max: dragMax } = dragBounds;
  useEffect(() => {
    if (!dragging) return;
    let follow: ReturnType<typeof animate> | null = null;
    const toStage = (px: number) =>
      (STAGE_MARGIN_X + Math.min(dragMax, Math.max(dragMin, px))) / stageW;
    const move = (px: number) => {
      follow?.stop();
      if (reducedMotion) x.jump(toStage(px));
      else follow = animate(x, toStage(px), FOLLOW);
    };
    move(dragX.get());
    const unsubscribe = dragX.on("change", move);
    return () => {
      unsubscribe();
      follow?.stop();
    };
  }, [dragging, dragX, dragMin, dragMax, stageW, reducedMotion, x]);

  // The lens is centred on the pill, so growing it overhangs the bar evenly above and
  // below. One scale for both axes: the lifted lens is the resting pill, only bigger.
  const liftScale = lifted ? (listSize.h + LIFT_OVERHANG_PX * 2) / pillBox.h : 1;
  const targetW = pillBox.w * liftScale;
  const targetH = pillBox.h * liftScale;
  const w = useMotionValue(targetW);
  const h = useMotionValue(targetH);
  const radius = useTransform(h, (v) => v / 2);
  const shadow = useMotionValue(lifted ? 1 : REST_SHADOW);
  // Passed as the package's `scale`, a live value: it retunes the displacement each frame
  // without re-rendering, so it can ride along with the lift.
  const strength = useMotionValue(lifted ? LIFT_STRENGTH : REST_STRENGTH);

  useEffect(() => {
    const targetShadow = lifted ? 1 : REST_SHADOW;
    const targetStrength = lifted ? LIFT_STRENGTH : REST_STRENGTH;
    if (reducedMotion) {
      w.jump(targetW);
      h.jump(targetH);
      shadow.jump(targetShadow);
      strength.jump(targetStrength);
      return;
    }
    const transition = lifted ? LIFT : SETTLE;
    const aw = animate(w, targetW, transition);
    const ah = animate(h, targetH, transition);
    const as = animate(shadow, targetShadow, { duration: 0.2, ease: "easeOut" });
    const af = animate(strength, targetStrength, STRENGTH_EASE);
    return () => {
      aw.stop();
      ah.stop();
      as.stop();
      af.stop();
    };
  }, [targetW, targetH, lifted, reducedMotion, w, h, shadow, strength]);

  // A sharp copy of the row over the lens, so the lens's centre stays full resolution.
  //
  // Everything the lens shows comes through an SVG filter, and Safari renders filters at
  // 1×: on a 3× iPhone whatever sat under the lens came out soft, pressed or not. So this
  // unfiltered copy stands in wherever the lens isn't bending anything:
  //   - at rest (`core` 0) it covers the whole lens, glyphs only, and the bent copy is
  //     hidden (the two stacked read as a soft halo around each glyph);
  //   - lifted (`core` 1) it pulls in to the flat middle, feathered, on its own patch of
  //     lens fill, and the bent copy shows around it: refraction at the rim, sharp centre.
  // Clip and mask follow the lens every frame from the same motion values, so it can't
  // lag or overhang the lens.
  const crispRef = useRef<HTMLDivElement | null>(null);
  const crispFillRef = useRef<HTMLDivElement | null>(null);
  const bentRef = useRef<HTMLDivElement | null>(null);
  const core = useMotionValue(lifted ? 1 : 0);
  useEffect(() => {
    const el = crispRef.current;
    if (!el) return;
    const place = () => {
      const lw = w.get();
      const lh = h.get();
      const k = core.get();
      const left = x.get() * stageW - lw / 2;
      const top = y.get() * stageH - lh / 2;
      el.style.clipPath = `inset(${top}px ${stageW - left - lw}px ${stageH - top - lh}px ${left}px round ${lh / 2}px)`;
      // At k=0 an ellipse bigger than the lens, solid throughout (no mask in effect); at
      // k=1 the flat core inside the bend band, fading out towards it.
      const rim = (DEPTH * Math.min(lw, lh)) / 2;
      const rx = lw + (Math.max(1, lw / 2 - rim) - lw) * k;
      const ry = lh + (Math.max(1, lh / 2 - rim) - lh) * k;
      const solid = 100 + (CORE_SOLID * 100 - 100) * k;
      const mask = `radial-gradient(ellipse ${rx}px ${ry}px at ${left + lw / 2}px ${top + lh / 2}px, #000 ${solid}%, transparent 100%)`;
      el.style.maskImage = mask;
      el.style.setProperty("-webkit-mask-image", mask);
      if (crispFillRef.current) crispFillRef.current.style.opacity = String(k);
      if (bentRef.current) bentRef.current.style.opacity = String(k);
    };
    place();
    const subs = [x, y, w, h, core].map((v) => v.on("change", place));
    return () => subs.forEach((unsubscribe) => unsubscribe());
  }, [x, y, w, h, core, stageW, stageH]);
  useEffect(() => {
    const target = lifted ? 1 : 0;
    if (reducedMotion) {
      core.jump(target);
      return;
    }
    const a = animate(core, target, lifted ? CORE_IN : CORE_OUT);
    return () => a.stop();
  }, [lifted, reducedMotion, core]);

  const face = (
    <TabRowFace
      items={items}
      entryIndex={entryIndex}
      highlightIndex={highlightIndex}
      pressedIndex={pressedIndex}
      pendingIndex={pendingIndex}
    />
  );
  const facePadding = { padding: `${STAGE_MARGIN_Y}px ${STAGE_MARGIN_X}px` };

  // Let the CSS pill take over again if this ever unmounts.
  useEffect(() => () => onReady(false), [onReady]);

  return (
    <div
      aria-hidden="true"
      inert
      className="pointer-events-none absolute z-20 transition-opacity duration-200"
      style={{
        inset: `${-STAGE_MARGIN_Y}px ${-STAGE_MARGIN_X}px`,
        opacity: visible ? 1 : 0,
      }}
    >
      <Glass
        style={{ width: "100%", height: "100%" }}
        refract={
          <div
            // The package mounts this copy on its own schedule, possibly after the effect
            // above has run, so it takes its starting opacity as it attaches.
            ref={(el) => {
              bentRef.current = el;
              if (el) el.style.opacity = String(core.get());
            }}
            style={facePadding}
          >
            {face}
          </div>
        }
        behind="var(--nav-lens-fill)"
        width={w}
        height={h}
        radius={radius}
        center={{ x, y }}
        // A small lens over a wide, short surface: without pixel units the map is
        // stretched to the whole row's box and the lens shatters into colour noise.
        pixelUnits
        optics={OPTICS}
        scale={strength}
        unstable_lens={{ shadowOpacity: shadow }}
        onLensMapChange={(url) => onReady(url !== null)}
      />
      <div ref={crispRef} className="absolute inset-0" style={facePadding}>
        <div
          ref={crispFillRef}
          className="absolute inset-0"
          style={{ background: "var(--nav-lens-fill)", opacity: 0 }}
        />
        <div className="relative">{face}</div>
      </div>
    </div>
  );
}
