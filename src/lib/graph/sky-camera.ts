/**
 * The constellation camera: framing, and the world↔screen transform.
 *
 * Pure and DOM-free, so both renderers share one definition of "where the sky is" and
 * `scripts/smoke-graph-canvas.ts` can assert the whole thing without a browser.
 *
 * The convention matches React Flow's exactly — `screen = world * k + (x, y)` — which
 * is what lets `zoomToFitSunCentered`'s output feed the DOM chart's `setViewport` and
 * the canvas camera unchanged.
 */
import type { NebulaData, buildHybridGraphLayout } from "@/lib/graph-layout";

type PositionMap = import("@/lib/graph-positions").PositionMap;

export type Vec2 = { x: number; y: number };
export type WorldRect = { minX: number; minY: number; maxX: number; maxY: number };
export type Camera = { x: number; y: number; k: number };

/**
 * Zoom bounds. These are passed to `<ReactFlow minZoom maxZoom>` and used by the canvas
 * clamp, so importing them in both places is what stops the two renderers drifting into
 * different zoom ranges.
 */
export const SKY_MIN_ZOOM = 0.05;
export const SKY_MAX_ZOOM = 2.4;

/** Ceiling on the *default* framing, which is tighter than what a pinch may reach. */
export const SKY_FIT_MAX_ZOOM = 1.35;

/** Padding factor so stars aren't flush against the pane edge. */
export const SKY_FIT_PAD = 1.18;

/**
 * A node as the camera needs to see it: enough of React Flow's `Node` to be assignable
 * from one, without importing @xyflow/react into a module the canvas path loads.
 */
export type MeasuredNode = {
  id: string;
  type?: string;
  hidden?: boolean;
  position: Vec2;
  data?: unknown;
  measured?: { width?: number; height?: number };
};

/**
 * Half-extents from the sun at (0, 0). Zoom is derived from how far
 * stars/labels/nebulae extend so everyone fits while you stay centered.
 *
 * `liveNodes` refines the estimate from measured DOM boxes and is the only reason the
 * React Flow path needs a second pass. The canvas draws exactly the constant
 * half-extents below, so it passes an empty array and frames once.
 */
export function computeSunExtents(
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"],
  positionOverrides: PositionMap,
  liveNodes: MeasuredNode[]
): { maxAbsX: number; maxAbsY: number } {
  let maxAbsX = 240;
  let maxAbsY = 240;

  const expand = (x: number, y: number, halfW: number, halfH: number) => {
    maxAbsX = Math.max(maxAbsX, Math.abs(x) + halfW);
    maxAbsY = Math.max(maxAbsY, Math.abs(y) + halfH);
  };

  for (const n of layoutNodes) {
    if (n.type === "contact") {
      expand(n.position.x, n.position.y, 56, 64);
      continue;
    }
    if (n.type === "user") {
      expand(n.position.x, n.position.y, 64, 64);
      continue;
    }
    if (n.type === "clusterLabel") {
      expand(n.position.x, n.position.y, 120, 32);
      continue;
    }
    if (n.type === "nebula") {
      const r = (n.data as NebulaData).radius || 80;
      expand(n.position.x, n.position.y, r, r);
    }
  }

  for (const pos of Object.values(positionOverrides)) {
    expand(pos.x, pos.y, 56, 64);
  }

  for (const n of liveNodes) {
    if (n.hidden) continue;
    if (n.type === "orbitRings") continue;
    const halfW = Math.max(24, (n.measured?.width ?? 48) / 2);
    const halfH = Math.max(24, (n.measured?.height ?? 48) / 2);
    if (n.type === "nebula") {
      const r = (n.data as NebulaData).radius || Math.max(halfW, halfH);
      expand(n.position.x, n.position.y, r, r);
      continue;
    }
    if (
      n.type === "contact" ||
      n.type === "user" ||
      n.type === "clusterLabel" ||
      n.id === "me"
    ) {
      expand(n.position.x, n.position.y, halfW, halfH);
    }
  }

  return { maxAbsX, maxAbsY };
}

export function zoomToFitSunCentered(
  maxAbsX: number,
  maxAbsY: number,
  width: number,
  height: number
): number {
  const zoomX = width / (2 * maxAbsX * SKY_FIT_PAD);
  const zoomY = height / (2 * maxAbsY * SKY_FIT_PAD);
  return Math.min(SKY_FIT_MAX_ZOOM, Math.max(SKY_MIN_ZOOM, Math.min(zoomX, zoomY)));
}

// ---------------------------------------------------------------------------
// The transform. Canvas-side; the DOM chart gets this from React Flow itself.
// ---------------------------------------------------------------------------

export function clampZoom(k: number): number {
  return Math.min(SKY_MAX_ZOOM, Math.max(SKY_MIN_ZOOM, k));
}

export function worldToScreen(p: Vec2, cam: Camera): Vec2 {
  return { x: p.x * cam.k + cam.x, y: p.y * cam.k + cam.y };
}

export function screenToWorld(p: Vec2, cam: Camera): Vec2 {
  return { x: (p.x - cam.x) / cam.k, y: (p.y - cam.y) / cam.k };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { x: cam.x + dx, y: cam.y + dy, k: cam.k };
}

/**
 * Zoom about a fixed screen point.
 *
 * The invariant — the world point under `anchor` does not move — is what makes a pinch
 * feel like the map is held between two fingers. When it is wrong the sky slides away
 * as you pinch, which is the single most obvious way a canvas map feels broken.
 * `scripts/smoke-graph-canvas.ts` asserts it directly.
 */
export function zoomAt(cam: Camera, anchor: Vec2, factor: number): Camera {
  const k = clampZoom(cam.k * factor);
  // Recover the real factor after clamping, or the anchor drifts at the zoom limits.
  const applied = k / cam.k;
  return {
    k,
    x: anchor.x - (anchor.x - cam.x) * applied,
    y: anchor.y - (anchor.y - cam.y) * applied,
  };
}

/** The world rectangle currently visible in a `width`×`height` pane. */
export function visibleWorldRect(cam: Camera, width: number, height: number): WorldRect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, cam);
  const bottomRight = screenToWorld({ x: width, y: height }, cam);
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

export function rectOf(points: Vec2[], pad = 0): WorldRect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Frame a world rectangle — the canvas equivalent of React Flow's `fitBounds`.
 *
 * `padding` is a fraction of the rect's own size, matching the `fitView` calls it
 * replaces. A degenerate rect (a single node) still frames, at `maxZoom`.
 */
export function fitWorldRect(
  rect: WorldRect,
  pane: { width: number; height: number },
  options: { padding?: number; maxZoom?: number; minZoom?: number } = {}
): Camera {
  const padding = options.padding ?? 0.2;
  const maxZoom = options.maxZoom ?? SKY_MAX_ZOOM;
  const minZoom = options.minZoom ?? SKY_MIN_ZOOM;

  const w = Math.max(rect.maxX - rect.minX, 1);
  const h = Math.max(rect.maxY - rect.minY, 1);
  const scale = 1 + padding * 2;

  const k = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(pane.width / (w * scale), pane.height / (h * scale)))
  );

  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  return { k, x: pane.width / 2 - cx * k, y: pane.height / 2 - cy * k };
}

/**
 * The narrowest span the phone framing will fit, in world units — about one cluster's
 * width. It only keeps a one- or two-star sky from dividing by (nearly) zero; the real
 * bound on how close a small network opens is `SKY_FIT_MAX_ZOOM`. A floor as wide as
 * `computeSunExtents`' 240-unit half-extent would pin every small or mid-sized network
 * at the sun-centred fit's zoom, which is exactly the framing this replaces.
 */
const MIN_STAR_SPAN = 160;

/** Share of stars left out at each end of each axis when the phone frames its sky. */
const FRAME_TRIM = 0.05;

/** The [low, high] of `values` after trimming `FRAME_TRIM` off each end. */
function trimmedRange(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor((sorted.length - 1) * FRAME_TRIM);
  const hi = Math.ceil((sorted.length - 1) * (1 - FRAME_TRIM));
  return [sorted[lo]!, sorted[hi]!];
}

/**
 * The phone's default view: the stars themselves, framed in the part of the pane the
 * chart's overlaid controls leave clear.
 *
 * The DOM chart opens sun-centred on `computeSunExtents`, which reserves a React Flow
 * card's box around every contact and a 240-unit-wide box around every cluster name. The
 * canvas draws neither at this zoom — contacts are dots, and names wait for
 * `LABEL_MIN_ZOOM` — and locking the sun to the centre of a lopsided sky left the far side
 * empty. On a phone-width pane that put the whole constellation in the middle third of
 * the chart. Here the stars' own bounds are fitted and centred instead, and the insets are
 * screen pixels rather than world units, so the margin stays the same size at every
 * network size. The sun is always in frame; it is just no longer pinned dead centre.
 *
 * The bounds are trimmed: the outermost `FRAME_TRIM` of stars on each end of each axis
 * don't count. A network's loose, unclustered contacts scatter far wider than its
 * figures, so fitting every last one of them left the constellations themselves a small
 * knot in the middle of a phone. The trimmed stars stay a pan away, and a network too
 * small for the trim to reach a whole star is framed exactly.
 */
export function fitStarsToPane(
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"],
  positionOverrides: PositionMap,
  pane: { width: number; height: number },
  inset: { x: number; top: number; bottom: number }
): Camera {
  const points: Vec2[] = [];
  for (const n of layoutNodes) {
    if (n.type === "contact" || n.type === "user" || n.type === "clusterLabel") {
      points.push(n.position);
    }
  }
  for (const pos of Object.values(positionOverrides)) points.push(pos);

  // The sun always stays in frame, whatever the trim does to the stars around it.
  const [loX, hiX] = points.length > 0 ? trimmedRange(points.map((p) => p.x)) : [0, 0];
  const [loY, hiY] = points.length > 0 ? trimmedRange(points.map((p) => p.y)) : [0, 0];
  const rect = {
    minX: Math.min(loX, 0),
    maxX: Math.max(hiX, 0),
    minY: Math.min(loY, 0),
    maxY: Math.max(hiY, 0),
  };
  const spanX = Math.max(rect.maxX - rect.minX, MIN_STAR_SPAN);
  const spanY = Math.max(rect.maxY - rect.minY, MIN_STAR_SPAN);
  const clearW = Math.max(pane.width - 2 * inset.x, 1);
  const clearH = Math.max(pane.height - inset.top - inset.bottom, 1);

  const k = Math.min(
    SKY_FIT_MAX_ZOOM,
    Math.max(SKY_MIN_ZOOM, Math.min(clearW / spanX, clearH / spanY))
  );
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  return { k, x: pane.width / 2 - cx * k, y: inset.top + clearH / 2 - cy * k };
}

/**
 * Keep the sky reachable without letting it be flung into the void.
 *
 * Deliberately generous: you may push content a viewport and a half off-centre, which
 * is what it takes to study a cluster at the sky's edge, but the layout can never leave
 * the pane entirely and strand you on an empty field with no way back but Home.
 */
export const PAN_SLACK_VIEWPORTS = 1.5;

export function clampPan(
  cam: Camera,
  bounds: WorldRect,
  pane: { width: number; height: number }
): Camera {
  const slackX = pane.width * PAN_SLACK_VIEWPORTS;
  const slackY = pane.height * PAN_SLACK_VIEWPORTS;

  const left = bounds.minX * cam.k;
  const right = bounds.maxX * cam.k;
  const top = bounds.minY * cam.k;
  const bottom = bounds.maxY * cam.k;

  return {
    k: cam.k,
    x: Math.min(slackX - left, Math.max(pane.width - slackX - right, cam.x)),
    y: Math.min(slackY - top, Math.max(pane.height - slackY - bottom, cam.y)),
  };
}

export function camerasEqual(a: Camera, b: Camera, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.k - b.k) < epsilon
  );
}

/** Cubic ease-out — the curve React Flow uses for its own camera tweens. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function lerpCamera(from: Camera, to: Camera, t: number): Camera {
  const e = easeOutCubic(Math.min(1, Math.max(0, t)));
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    // Interpolate zoom geometrically: a linear ramp from 0.1 to 2.0 spends most of its
    // time near the top and reads as a lurch at the end.
    k: from.k * (to.k / from.k) ** e,
  };
}
