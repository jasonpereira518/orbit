"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStoreApi, type Edge } from "@xyflow/react";
import type { GraphNodeData } from "@/lib/graph-layout";
import { edgeEmphasis, starEmphasis, type SkyFocusState } from "@/lib/graph/sky-emphasis";
import { starVisual, zoomRelief, type StarVisual } from "@/lib/graph/star-style";
import { deviceRatio } from "@/components/graph/sky-canvas/sky-sprites";
import { withAlpha } from "@/lib/school-color";
import { isCameraMoving, subscribeCameraMoving } from "@/components/graph/camera-motion";

type WorldBox = { x0: number; y0: number; x1: number; y1: number };
type Contact = { id: string; position: { x: number; y: number }; data: unknown };
type Line = {
  source: string;
  target: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  stroke: string;
  opacity: number;
  strokeWidth: number;
  kind?: string;
};

type Scene = {
  box: WorldBox;
  ids: readonly string[];
  contactById: ReadonlyMap<string, Contact>;
  skip: ReadonlySet<string>;
  focus: SkyFocusState;
  lines: readonly Line[];
  focusCluster: string | null;
};

/** What the canvas holds now. */
type Drawn = {
  scene: Scene;
  /** The zoom it was drawn at; the camera's transform scales it from there. */
  k: number;
  /** Window stars NOT on the canvas: DOM stars at the last full draw, minus any added since. */
  absent: Set<string>;
  /** Holds stars that have joined the DOM since: redraw once the camera stops. */
  stale: boolean;
};

/** Longest side of the backing store. A 1.5× window of a 1440px pane at DPR 2 is ~4,300px. */
const MAX_BACKING_PX = 4096;
const DEFAULT_EDGE_STROKE = "rgba(255, 255, 255, 0.75)";

const SPRITE_PX = 128;
const sprites = new Map<string, { canvas: HTMLCanvasElement; halo: number } | null>();

/**
 * One DOM star, baked: `ContactNode`'s halo span and disc, gradient for gradient.
 *
 * Not the phone renderer's `starSprite`: that one approximates the star (its body fades out at
 * 78% of the radius, where the DOM's `circle at 35% 30%` gradient runs to the far corner and
 * stays nearly opaque), and side by side with DOM stars a canvas star read smaller and dimmer.
 * Keyed by the handful of score tiers × cluster colours × emphasis states a sky has.
 */
function domStarSprite(v: StarVisual) {
  // As `ContactNode` sizes them, in node units before the zoom relief.
  const halo = Math.round(v.disc + v.glow * v.spotlightBoost * 6);
  const key = `${v.fill}|${v.core}|${v.spotlightBoost}|${v.alphaScale}|${v.disc}|${halo}`;
  const hit = sprites.get(key);
  if (hit !== undefined) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    sprites.set(key, null);
    return null;
  }
  const c = SPRITE_PX / 2;
  const haloCore = Math.round((v.disc / halo) * 100) / 100;
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(haloCore, withAlpha(v.fill, 0.32 * v.spotlightBoost * v.alphaScale));
  glow.addColorStop(Math.min(0.92, haloCore + 0.3), withAlpha(v.fill, 0.1 * v.alphaScale));
  glow.addColorStop(1, withAlpha(v.fill, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  // `radial-gradient(circle at 35% 30%, #fff 0%, core 50%, transparent 78%)` on a round disc:
  // the default size is the farthest corner of the disc's box.
  const d = (v.disc / halo) * SPRITE_PX;
  const left = c - d / 2;
  const top = c - d / 2;
  const body = ctx.createRadialGradient(
    left + 0.35 * d,
    top + 0.3 * d,
    0,
    left + 0.35 * d,
    top + 0.3 * d,
    d * Math.hypot(0.65, 0.7)
  );
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.5, v.core);
  body.addColorStop(0.78, withAlpha(v.core, 0));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, d / 2, 0, Math.PI * 2);
  ctx.fill();
  const sprite = { canvas, halo };
  sprites.set(key, sprite);
  return sprite;
}

function linesOf(edges: readonly Edge[], contactById: ReadonlyMap<string, Contact>): Line[] {
  const out: Line[] = [];
  for (const e of edges) {
    const a = contactById.get(e.source);
    const b = contactById.get(e.target);
    if (!a || !b) continue;
    out.push({
      source: e.source,
      target: e.target,
      ax: a.position.x,
      ay: a.position.y,
      bx: b.position.x,
      by: b.position.y,
      stroke: (typeof e.style?.stroke === "string" && e.style.stroke) || DEFAULT_EDGE_STROKE,
      opacity: Number(e.style?.opacity ?? 0.5),
      strokeWidth: Number(e.style?.strokeWidth ?? 1),
      kind: (e.data as { kind?: string } | undefined)?.kind,
    });
  }
  return out;
}

/**
 * Lines (bucketed into a few paths), then stars, in world units on a world-space context whose
 * backing store has `px` pixels per world unit.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  k: number,
  px: number,
  lines: Iterable<Line>,
  stars: Iterable<string>
) {
  const { box, contactById, focus } = scene;
  const edgeFocus = { ...focus, focusCluster: scene.focusCluster };
  const buckets = new Map<string, { stroke: string; alpha: number; width: number; segs: number[] }>();
  for (const l of lines) {
    if (
      Math.max(l.ax, l.bx) < box.x0 ||
      Math.min(l.ax, l.bx) > box.x1 ||
      Math.max(l.ay, l.by) < box.y0 ||
      Math.min(l.ay, l.by) > box.y1
    ) {
      continue;
    }
    const { opacity, strokeWidth } = edgeEmphasis(l, edgeFocus);
    if (opacity <= 0.01) continue;
    const alpha = Math.round(opacity * 50) / 50;
    const key = `${l.stroke}|${alpha}|${strokeWidth}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { stroke: l.stroke, alpha, width: strokeWidth, segs: [] };
      buckets.set(key, bucket);
    }
    bucket.segs.push(l.ax, l.ay, l.bx, l.by);
  }
  ctx.lineCap = "round";
  for (const b of buckets.values()) {
    // Under a device pixel wide (a 1.1 line at zoom 0.3 is 0.33px), the GPU canvas draws a
    // hairline that breaks into dots; SVG draws it as coverage. One pixel at that coverage.
    const wide = b.width * px;
    ctx.globalAlpha = wide < 1 ? b.alpha * wide : b.alpha;
    ctx.strokeStyle = b.stroke;
    ctx.lineWidth = wide < 1 ? 1 / px : b.width;
    ctx.beginPath();
    for (let i = 0; i < b.segs.length; i += 4) {
      ctx.moveTo(b.segs[i], b.segs[i + 1]);
      ctx.lineTo(b.segs[i + 2], b.segs[i + 3]);
    }
    ctx.stroke();
  }

  // At the DOM star's size: its disc and halo, scaled by the zoom relief as its wrapper is.
  for (const id of stars) {
    const n = contactById.get(id);
    if (!n) continue;
    const d = n.data as GraphNodeData;
    const emphasis = starEmphasis(id, focus);
    const visual = starVisual(d, emphasis.selected, emphasis.spotlight);
    const { x, y } = n.position;
    ctx.globalAlpha = emphasis.opacity;
    if (visual.isComet) {
      // Comets stay DOM stars (see `mountTarget`); this only covers one until it mounts.
      const r = (visual.size + 2) / 2;
      ctx.fillStyle = "#ff6b4a";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const sprite = domStarSprite(visual);
    if (!sprite) continue;
    const relief = zoomRelief(visual.disc, k);
    const size = sprite.halo * relief;
    ctx.drawImage(sprite.canvas, x - size / 2, y - size / 2, size, size);
    if (d.overdue) {
      // `ring-1 ring-[#c4a35a]/80` on the disc: a 1px ring outside it, scaled with it.
      ctx.globalAlpha = emphasis.opacity * 0.8;
      ctx.strokeStyle = "#c4a35a";
      ctx.lineWidth = relief;
      ctx.beginPath();
      ctx.arc(x, y, ((visual.disc + 1) * relief) / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** World units on the canvas; returns backing pixels per world unit. */
function setWorldTransform(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, box: WorldBox) {
  const s = canvas.width / (box.x1 - box.x0);
  ctx.setTransform(s, 0, 0, s, -box.x0 * s, -box.y0 * s);
  return s;
}

function drawFull(canvas: HTMLCanvasElement, scene: Scene, k: number): Drawn | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { box, ids, skip } = scene;
  const cssW = (box.x1 - box.x0) * k;
  const cssH = (box.y1 - box.y0) * k;
  const scale = Math.min(deviceRatio(), MAX_BACKING_PX / Math.max(cssW, cssH, 1));
  const bw = Math.max(1, Math.ceil(cssW * scale));
  const bh = Math.max(1, Math.ceil(cssH * scale));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const px = setWorldTransform(ctx, canvas, box);
  const absent = new Set<string>();
  const stars: string[] = [];
  for (const id of ids) {
    if (skip.has(id)) absent.add(id);
    else stars.push(id);
  }
  // A line both of whose stars are DOM is React Flow's to draw.
  const lines = scene.lines.filter((l) => !(skip.has(l.source) && skip.has(l.target)));
  paint(ctx, scene, k, px, lines, stars);
  return { scene, k, absent, stale: false };
}

/**
 * The window's stars that are not DOM nodes, on one canvas beneath React Flow.
 *
 * Between the summary view and the close-up, a large sky's window holds hundreds to thousands
 * of stars, and as DOM nodes each one that crossed the screen edge during a pan cost a React
 * commit, a mount, a measure and a relayer. Here they are drawn once per window placement,
 * with the sprites the phone renderer uses (`sky-canvas/`), and the camera moves the canvas
 * with a CSS transform, so a pan costs one style write a frame. Only the stars someone asked
 * for — named, hovered, selected, a search hit, a peek — stay DOM, on top.
 *
 * It sits UNDER `.react-flow__renderer`, never inside the viewport: a composited canvas among
 * the stars made Chrome give each star painted above it a layer of its own (the bench README's
 * "one composited layer per star"). Beneath the renderer it costs one more layer, not one per star.
 *
 * Redrawn when the window or the emphasis changes, when the DOM set changes at rest, and when
 * the camera stops at a zoom other than the one drawn; in between a zoom scales the drawing, as
 * it does the dust. While the camera moves, a star leaving the DOM is added to the drawing
 * (a hole would show) and one joining it stays drawn under itself until the camera stops: a
 * zoom through this band changes which stars are named every few frames, and redrawing the
 * whole window each time cost more than the DOM did.
 */
export function WindowStarCanvas({
  window: box,
  ids,
  contactById,
  skip,
  focus,
  edges,
  focusCluster,
}: {
  window: WorldBox | null;
  /** Everyone in the window. */
  ids: readonly string[] | null;
  contactById: ReadonlyMap<string, Contact>;
  /** Drawn as DOM stars, so not here. */
  skip: ReadonlySet<string>;
  focus: SkyFocusState;
  edges: readonly Edge[];
  focusCluster: string | null;
}) {
  const storeApi = useStoreApi();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawnRef = useRef<Drawn | null>(null);
  /** The latest props: a redraw when the camera stops must draw these, not the last full draw's. */
  const sceneRef = useRef<Scene | null>(null);
  const lines = useMemo(() => linesOf(edges, contactById), [edges, contactById]);

  // Before paint, so a star leaving the DOM is on the canvas in the frame it leaves.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!box || !ids) {
      canvas.style.visibility = "hidden";
      drawnRef.current = null;
      sceneRef.current = null;
      return;
    }
    const scene: Scene = { box, ids, contactById, skip, focus, lines, focusCluster };
    sceneRef.current = scene;
    const was = drawnRef.current;
    const onlySkipChanged =
      was !== null &&
      was.scene.box === box &&
      was.scene.ids === ids &&
      was.scene.contactById === contactById &&
      was.scene.focus === focus &&
      was.scene.lines === lines &&
      was.scene.focusCluster === focusCluster;
    if (onlySkipChanged && isCameraMoving()) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const left: string[] = [];
      for (const id of was.absent) if (!skip.has(id)) left.push(id);
      for (const id of skip) if (!was.absent.has(id)) was.stale = true;
      if (left.length > 0) {
        const gone = new Set(left);
        // Lines that were React Flow's (both ends DOM) and now have an end here.
        const handed = lines.filter(
          (l) =>
            (gone.has(l.source) || gone.has(l.target)) &&
            was.absent.has(l.source) &&
            was.absent.has(l.target)
        );
        const px = setWorldTransform(ctx, canvas, box);
        paint(ctx, scene, was.k, px, handed, left);
        for (const id of left) was.absent.delete(id);
      }
      return;
    }
    const k = storeApi.getState().transform[2];
    drawnRef.current = drawFull(canvas, scene, k);
    place(canvas, drawnRef.current, storeApi.getState().transform);
    canvas.style.visibility = "visible";
  }, [box, ids, skip, focus, lines, focusCluster, contactById, storeApi]);

  useEffect(() => {
    let last = storeApi.getState().transform;
    const offStore = storeApi.subscribe((s) => {
      if (s.transform === last) return;
      last = s.transform;
      const canvas = canvasRef.current;
      if (canvas) place(canvas, drawnRef.current, s.transform);
    });
    // A zoom only scales the drawing, and a move may leave stars under their DOM selves.
    const offMoving = subscribeCameraMoving(() => {
      const canvas = canvasRef.current;
      const drawn = drawnRef.current;
      const scene = sceneRef.current;
      if (isCameraMoving() || !canvas || !drawn || !scene) return;
      const transform = storeApi.getState().transform;
      if (!drawn.stale && Math.abs(transform[2] / drawn.k - 1) <= 0.01) return;
      drawnRef.current = drawFull(canvas, scene, transform[2]);
      place(canvas, drawnRef.current, transform);
    });
    return () => {
      offStore();
      offMoving();
    };
  }, [storeApi]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="constellation-window-stars pointer-events-none absolute left-0 top-0 z-[1]"
      style={{ transformOrigin: "0 0", visibility: "hidden" }}
    />
  );
}

/** Put the canvas where the camera puts its world origin: a transform, so compositor work. */
function place(canvas: HTMLCanvasElement, drawn: Drawn | null, transform: [number, number, number]) {
  if (!drawn) return;
  const [tx, ty, k] = transform;
  const { box } = drawn.scene;
  canvas.style.transform = `translate(${tx + box.x0 * k}px, ${ty + box.y0 * k}px) scale(${k / drawn.k})`;
}
