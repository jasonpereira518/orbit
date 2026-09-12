/**
 * The struck Orbit emblem, drawn flat.
 *
 * Pure painting: no React, no time, no state. The caller owns the clock and
 * passes the frame's values in.
 *
 * The whole file follows one rule: **every fill on the emblem is a solid
 * hex.** There is not a single gradient inside the object. Flat shading comes
 * from three primitives and nothing else —
 *
 *   1. annulus sectors  — `arc` out, `arc` back with `true`, so every tonal
 *                         boundary is a straight radial cut or a hard arc;
 *   2. chord-clipped half-planes — a straight terminator across the face;
 *   3. offset silhouettes — the same path filled twice, displaced along the
 *                         anti-light vector, which is relief without shading.
 *
 * The only gradients in the whole scene belong to the FIELD (its hotspot, its
 * vignette, and the emblem's seat shadow). Those are ground, not object — a
 * gradient on the ground reads as light in the room, a gradient on the object
 * reads as a render of a real coin, which is the look we are not doing.
 */

import { MARK_EDGES, MARK_FIELD, MARK_NODES } from "@/lib/celebration/mark-geometry";
import type { FacetRamp, TierTheme } from "@/lib/celebration/tier-theme";

const TAU = Math.PI * 2;

/** Where the light comes from: up and to the left, so every cast shadow falls
 * down-right the way a struck medal photographed on a desk does. */
export const LIGHT_ANGLE = -2.24;

/** Mark radius as a fraction of the emblem's. `MARK_NODES` span x ∈ [-0.92,
 * 0.782], so 0.60 seats the handle tip at 0.55R — clear of the rim's cast
 * shadow at 0.70R. */
export const MARK_RATIO = 0.6;

export type EmblemOpts = {
  /** 0..1 assembly. Grows the face out of nothing and reveals the mark, so
   * the emblem ASSEMBLES rather than fading up. 1 from the strike onward. */
  forged: number;
  /** Strike scale: 1.55 → 1.0 → damped wobble. */
  scale: number;
  /** Hard white overlay at the instant of contact, 1 → 0. */
  flash: number;
  alpha: number;
  /** Radians. Turns the LIGHT, never the silhouette — a flat emblem catches
   * light by re-cutting its facets. One that rotates in space stops being
   * flat. */
  tilt: number;
  /** 0..1 of the plan ring lit by the finale sweep. */
  ringLit: number;
};

function sector(
  ctx: CanvasRenderingContext2D,
  ro: number,
  ri: number,
  a0: number,
  a1: number,
) {
  ctx.beginPath();
  ctx.arc(0, 0, ro, a0, a1);
  ctx.arc(0, 0, ri, a1, a0, true);
  ctx.closePath();
}

/** The mark's four-pointed concave star: four quadratics with a pinched
 * waist, which is what makes it a star rather than a diamond. */
export function sparkPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
) {
  const w = r * 0.28;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + w * 0.6, y - w * 0.6, x + r, y);
  ctx.quadraticCurveTo(x + w * 0.6, y + w * 0.6, x, y + r);
  ctx.quadraticCurveTo(x - w * 0.6, y + w * 0.6, x - r, y);
  ctx.quadraticCurveTo(x - w * 0.6, y - w * 0.6, x, y - r);
  ctx.closePath();
}

/** Reveal ramps: nodes pop in order, each edge follows the later of the two
 * nodes it joins, so the constellation draws itself handle-first. */
function nodeReveal(i: number, forged: number) {
  return Math.max(0, Math.min(1, forged * MARK_NODES.length - i));
}

function edgeReveal(i: number, forged: number) {
  const [a, b] = MARK_EDGES[i];
  const after = Math.max(a, b);
  return Math.max(0, Math.min(1, forged * MARK_NODES.length - after - 0.2));
}

/**
 * The mark as relief: three identical passes at three offsets in three flat
 * tones. Displacement plus solid colour IS the shading — no gradient, no
 * blur. Deep offset down-right is the groove's shadow, light on centre is the
 * body, highlight offset up-left and thinner is the lit ridge.
 */
function drawMarkRelief(
  ctx: CanvasRenderingContext2D,
  mr: number,
  m: FacetRamp,
  forged: number,
) {
  const lift = mr * 0.036;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Field sparkles first — they sit under the asterism and stop the face from
  // going flat between its arms.
  for (const s of MARK_FIELD) {
    const sr = mr * 0.03 * (0.6 + s.size);
    ctx.fillStyle = m.deep;
    sparkPath(ctx, s.x * mr + lift, s.y * mr + lift, sr * 1.5);
    ctx.fill();
    ctx.fillStyle = m.light;
    sparkPath(ctx, s.x * mr, s.y * mr, sr * 1.2);
    ctx.fill();
  }

  const pass = (ox: number, oy: number, colour: string, barW: number, nodeK: number) => {
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = mr * barW;
    MARK_EDGES.forEach(([ai, bi], i) => {
      const e = edgeReveal(i, forged);
      if (e <= 0) return;
      const a = MARK_NODES[ai];
      const b = MARK_NODES[bi];
      ctx.beginPath();
      ctx.moveTo(a.x * mr + ox, a.y * mr + oy);
      ctx.lineTo(
        a.x * mr + (b.x - a.x) * mr * e + ox,
        a.y * mr + (b.y - a.y) * mr * e + oy,
      );
      ctx.stroke();
    });
    MARK_NODES.forEach((node, i) => {
      const n = nodeReveal(i, forged);
      if (n <= 0) return;
      const nr = mr * 0.088 * node.size * nodeK * n;
      if (node.kind === "spark") {
        sparkPath(ctx, node.x * mr + ox, node.y * mr + oy, nr * 1.8);
      } else {
        ctx.beginPath();
        ctx.arc(node.x * mr + ox, node.y * mr + oy, nr, 0, TAU);
      }
      ctx.fill();
    });
  };

  pass(lift, lift, m.deep, 0.052, 1.06);
  pass(0, 0, m.light, 0.048, 1.0);
  pass(-lift * 0.55, -lift * 0.55, m.highlight, 0.018, 0.62);
  ctx.restore();
}

/**
 * The constellation as bare struck chips, before there is any coin. Drawn at
 * the SAME centre and the SAME radius the emblem's mark will occupy, so at
 * the strike the metal floods in around stars that never move.
 */
export function drawMarkSkeleton(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  markR: number,
  theme: TierTheme,
  opts: {
    /** 0..1 per node, already eased by the caller. */
    nodeAt: (i: number) => number;
    edgeAt: (i: number) => number;
    /** Pulls the whole constellation inward at the collapse. */
    squeeze: number;
  },
) {
  const mr = markR * opts.squeeze;
  const ink = `rgba(${theme.inkRgb}, 0.55)`;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  MARK_EDGES.forEach(([ai, bi], i) => {
    const e = opts.edgeAt(i);
    if (e <= 0) return;
    const a = MARK_NODES[ai];
    const b = MARK_NODES[bi];
    const ex = a.x * mr + (b.x - a.x) * mr * e;
    const ey = a.y * mr + (b.y - a.y) * mr * e;
    ctx.lineWidth = mr * 0.03;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.moveTo(a.x * mr + 2, a.y * mr + 2);
    ctx.lineTo(ex + 2, ey + 2);
    ctx.stroke();
    ctx.strokeStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.moveTo(a.x * mr, a.y * mr);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  });

  MARK_NODES.forEach((node, i) => {
    const n = opts.nodeAt(i);
    if (n <= 0) return;
    const nr = mr * 0.088 * node.size;
    const x = node.x * mr;
    const y = node.y * mr;

    // A hard expanding ring on arrival — flat and graphic, not a soft flare.
    if (n < 1) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${1 - n})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, nr * (1 + 6 * (1 - n)), 0, TAU);
      ctx.stroke();
    }

    const r = nr * Math.min(1, n * 1.4);
    ctx.fillStyle = ink;
    if (node.kind === "spark") sparkPath(ctx, x + 2, y + 2, r * 1.8);
    else {
      ctx.beginPath();
      ctx.arc(x + 2, y + 2, r, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    if (node.kind === "spark") sparkPath(ctx, x, y, r * 1.8);
    else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();
  });

  ctx.restore();
}

export function drawEmblem(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  theme: TierTheme,
  opts: EmblemOpts,
) {
  const { forged, scale, flash, alpha, tilt, ringLit } = opts;
  if (alpha <= 0 || scale <= 0) return;
  const m = theme.emblem;
  const R = radius * scale;
  const aL = LIGHT_ANGLE + tilt;
  const off = R * 0.055;
  const dx = Math.cos(aL + Math.PI) * off;
  const dy = Math.sin(aL + Math.PI) * off;

  ctx.save();
  ctx.globalAlpha = alpha;

  // 0 — the field darkens under the coin. The one soft edge in the whole
  //     composition, and it belongs to the ground rather than the object.
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  const seat = ctx.createRadialGradient(
    cx + dx,
    cy + dy,
    R * 0.7,
    cx + dx,
    cy + dy,
    R * 1.85,
  );
  seat.addColorStop(0, `rgba(${theme.field.vignetteRgb}, 0.34)`);
  seat.addColorStop(1, `rgba(${theme.field.vignetteRgb}, 0)`);
  ctx.fillStyle = seat;
  ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
  ctx.restore();

  ctx.translate(cx, cy);

  // 1, 2 — thickness (the chunk) and body.
  ctx.fillStyle = m.deep;
  ctx.beginPath();
  ctx.arc(dx * 1.5, dy * 1.5, R, 0, TAU);
  ctx.fill();
  ctx.fillStyle = m.base;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();

  // 3, 4 — the bevel: two bands lit on OPPOSITE sides. That opposition is the
  //        only thing that says "bevel" rather than "painted arc", and it is
  //        the flat equivalent of an incised-versus-raised relief argument.
  const RO = R;
  const RM = R * 0.905;
  const RI = R * 0.8;
  ctx.fillStyle = m.light;
  sector(ctx, RO, RM, aL - 1.15, aL + 1.15);
  ctx.fill();
  ctx.fillStyle = m.highlight;
  sector(ctx, RO, RM, aL - 0.5, aL + 0.5);
  ctx.fill();
  ctx.fillStyle = m.shadow;
  sector(ctx, RO, RM, aL + Math.PI - 1.3, aL + Math.PI + 1.3);
  ctx.fill();
  ctx.fillStyle = m.shadow;
  sector(ctx, RM, RI, aL - 1.2, aL + 1.2);
  ctx.fill();
  ctx.fillStyle = m.light;
  sector(ctx, RM, RI, aL + Math.PI - 1.1, aL + Math.PI + 1.1);
  ctx.fill();

  // 5, 6, 7 — the face, its straight terminator, and the rim's cast shadow.
  const faceR = RI * Math.min(1, forged * 1.25);
  if (faceR > 1) {
    ctx.fillStyle = m.shadow;
    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, TAU);
    ctx.clip();
    ctx.translate(Math.cos(aL) * R * 0.1, Math.sin(aL) * R * 0.1);
    ctx.rotate(aL);
    ctx.fillStyle = m.base;
    ctx.fillRect(-R * 2, -R * 2, R * 2, R * 4);
    ctx.restore();

    // The single biggest struck-coin cue: the rim throws a shadow inward.
    ctx.fillStyle = m.deep;
    sector(ctx, faceR, faceR * 0.88, aL + Math.PI - 1.45, aL + Math.PI + 1.45);
    ctx.fill();

    // 8 — the mark.
    drawMarkRelief(ctx, R * MARK_RATIO, m, forged);
  }

  // 9 — the plan ring, swept alight at the finale. In the tier's own accent
  //     rather than in the emblem's metal: this is literally the ring the
  //     sidebar logo wears from now on.
  if (ringLit > 0) {
    ctx.fillStyle = m.ringLit;
    sector(ctx, R, R * 0.955, -Math.PI / 2, -Math.PI / 2 + ringLit * TAU);
    ctx.fill();
  }

  // 10 — the contour. On a saturated field an un-outlined struck shape
  //      dissolves into the ground; this is what keeps it a sticker.
  ctx.strokeStyle = m.contour;
  ctx.lineWidth = R * 0.018;
  ctx.beginPath();
  ctx.arc(0, 0, R - R * 0.009, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = R * 0.01;
  ctx.beginPath();
  ctx.arc(0, 0, RI, 0, TAU);
  ctx.stroke();

  // 11 — the strike: pure white for a few frames, resolving into facets.
  if (flash > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${flash})`;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}
