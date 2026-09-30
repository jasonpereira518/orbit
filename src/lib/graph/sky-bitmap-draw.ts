/**
 * Drawing the sky's bitmaps — the cluster washes, the star dust and the galaxy backdrop — onto
 * any 2D context.
 *
 * Pure (no DOM, no React), so the same code draws on the page's canvas and on an
 * `OffscreenCanvas` in `sky-bitmap.worker.ts`. See `useSkyBitmap` in graph-nodes.tsx for why
 * there are two places to draw it.
 */
import type {
  NebulaWashCluster,
  NebulaWashData,
  StarDustData,
  StarDustPoint,
} from "@/components/graph/graph-nodes";
import type { GalaxyBackdropData } from "@/lib/graph/galaxy-dust";
import { CORE_TINT } from "@/lib/constellation-parts";
import { NEBULA_LOBE_EDGE, NEBULA_LOBE_MID, nebulaLobes } from "@/lib/graph/nebula-lobes";
import { zoomRelief as starZoomRelief } from "@/lib/graph/star-style";
import { withAlpha } from "@/lib/school-color";

/** One bitmap to draw: what, at which quantised zoom and pixel ratio, capped at how many px. */
export type SkyBitmapJob =
  | { kind: "wash"; data: NebulaWashData; zoom: number; dpr: number; maxBackingPx: number }
  | { kind: "dust"; data: StarDustData; zoom: number; dpr: number; maxBackingPx: number }
  | { kind: "galaxy"; data: GalaxyBackdropData; zoom: number; dpr: number; maxBackingPx: number };

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The backing store for a job: world units at the camera's zoom, never over the cap. */
export function skyBitmapSize(job: SkyBitmapJob) {
  const { data, zoom, dpr, maxBackingPx } = job;
  const scale = Math.min(
    Math.max(zoom, 0.01) * dpr,
    maxBackingPx / Math.max(data.width, data.height)
  );
  return {
    scale,
    width: Math.max(1, Math.ceil(data.width * scale)),
    height: Math.max(1, Math.ceil(data.height * scale)),
  };
}

/** Draw `job` on a context whose canvas is already `skyBitmapSize(job)`. */
export function drawSkyBitmap(ctx: Ctx, job: SkyBitmapJob) {
  const { data } = job;
  const { scale } = skyBitmapSize(job);
  ctx.setTransform(scale, 0, 0, scale, -data.minX * scale, -data.minY * scale);
  ctx.clearRect(data.minX, data.minY, data.width, data.height);
  if (job.kind === "wash") drawWash(ctx, job.data, scale);
  else if (job.kind === "dust") drawDust(ctx, job.data, job.zoom);
  else drawGalaxyBackdrop(ctx, job.data, scale);
  ctx.globalAlpha = 1;
}

/**
 * A part's wash is lighter than the cluster's, so the parts read as pools within one cloud.
 * Shared with the phone canvas (`draw-sky.ts`).
 */
export const PART_WASH_ALPHA = 0.7;

/** A school's annulus reaches this many times the ring's own radius. */
export const RING_OUTER = 1.3;
/**
 * The annulus's colour stops, as [offset, alpha] from the centre to `RING_OUTER`: faint inside,
 * peaking on the ring itself, clear at the edge. Shared with the phone's `ringSprite`.
 */
export const RING_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.05],
  [0.3, 0.06],
  [1 / RING_OUTER, 0.12], // the outer ring itself
  [1, 0],
];

function drawLobes(
  ctx: Ctx,
  scale: number,
  seed: string,
  color: string,
  cx: number,
  cy: number,
  radius: number,
  alphaScale: number
) {
  for (const lobe of nebulaLobes(seed, radius)) {
    // Under half a backing pixel there is nothing to draw, and a zero-radius gradient throws.
    if (lobe.rx * scale < 0.5 || lobe.ry * scale < 0.5) continue;
    const a = lobe.alpha * alphaScale;
    const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, lobe.rx);
    fill.addColorStop(0, withAlpha(color, a));
    fill.addColorStop(NEBULA_LOBE_MID, withAlpha(color, a * 0.45));
    // The cluster's own colour at zero alpha, not `transparent`: that keyword is
    // transparent BLACK, so a fade to it drags the hue toward black on the way out
    // instead of simply thinning. The dashboard preview builds the same stops.
    fill.addColorStop(NEBULA_LOBE_EDGE, withAlpha(color, 0));
    fill.addColorStop(1, withAlpha(color, 0));
    ctx.save();
    // An ellipse rx by ry, as `radial-gradient(ellipse rx ry at …)` drew it: a circle of
    // radius rx, squashed vertically. The gradient is built in this squashed space, so it
    // stretches with the shape exactly as the CSS one did.
    ctx.translate(cx + lobe.x, cy + lobe.y);
    ctx.scale(1, lobe.ry / lobe.rx);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, lobe.rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** A school: a soft annulus that peaks on the outer ring, so the stars sit in a halo of their own colour. */
function drawRing(ctx: Ctx, scale: number, cluster: NebulaWashCluster) {
  const part = cluster.parts?.[0];
  const ringR = part?.radius ?? cluster.radius * 0.5;
  const cx = part?.x ?? cluster.x;
  const cy = part?.y ?? cluster.y;
  const outer = ringR * RING_OUTER;
  if (outer * scale < 0.5) return;
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  for (const [at, alpha] of RING_STOPS) fill.addColorStop(at, withAlpha(cluster.color, alpha));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
}

function drawWash(ctx: Ctx, data: NebulaWashData, scale: number) {
  for (const cluster of data.clusters) {
    const form = cluster.form ?? "figure";
    // A role cluster spans companies and a binary is two or three stars: neither has a cloud of
    // its own, so neither is washed.
    if (form === "open" || form === "binary") continue;
    // The cluster's dim is applied to all its pieces together, as the element's `opacity`
    // applied it to the five backgrounds together. Instant rather than the 200ms fade the
    // boxes had: a canvas redraws, it does not transition. The stars above made the same
    // trade for the same reason.
    ctx.globalAlpha = cluster.opacity;
    if (form === "ring") {
      drawRing(ctx, scale, cluster);
      continue;
    }
    drawLobes(ctx, scale, cluster.seed, cluster.color, cluster.x, cluster.y, cluster.radius, 1);
    if (form === "petal") {
      for (const part of cluster.parts ?? []) {
        drawLobes(
          ctx,
          scale,
          `${cluster.seed}#${part.key}`,
          part.role === "core" ? CORE_TINT : cluster.color,
          part.x,
          part.y,
          part.radius * 0.9,
          PART_WASH_ALPHA
        );
      }
    }
  }
}

function drawDust(ctx: Ctx, data: StarDustData, zoom: number) {
  // At least a pixel and a half on screen, or a dim dot vanishes into the backing store.
  const minRadius = 0.75 / Math.max(zoom, 0.01);
  // One path and one fill per colour and strength rather than per dot: a sky has a handful of
  // those and thousands of dots, and a search redraws all of them on each keystroke.
  const batches = new Map<string, StarDustPoint[]>();
  for (const p of data.points) {
    const key = `${p.color}|${p.alpha.toFixed(2)}`;
    const batch = batches.get(key);
    if (batch) batch.push(p);
    else batches.set(key, [p]);
  }
  for (const batch of batches.values()) {
    ctx.globalAlpha = batch[0].alpha;
    ctx.fillStyle = batch[0].color;
    ctx.beginPath();
    for (const p of batch) {
      const r = Math.max(minRadius, (p.disc * starZoomRelief(p.disc, zoom)) / 2);
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

/**
 * Dots per path before it is filled. One path and one fill for a whole alpha band is
 * super-linear in Skia (2.5s for 16k dots at 10,000 contacts); measured with @napi-rs/canvas at
 * 10,000 contacts the whole backdrop draws in ~120ms at 150 dots, ~70ms at 50 and ~48ms at 25 or
 * fewer, so 25.
 */
export const DUST_CHUNK = 25;

/** Dust dots whose radius is under this many BACKING px are filled as squares, not arcs. */
export const SMALL_DOT_PX = 1.5;
const SQRT_PI = Math.sqrt(Math.PI);

/**
 * The galaxy behind everything: a cool disk haze, a warm bulge, dark lanes across the strongest
 * relatedness chains, and dust along all of them. Every gradient fades to its OWN colour at zero
 * alpha (never `transparent`, which is black), as the washes do.
 */
export function drawGalaxyBackdrop(ctx: Ctx, data: GalaxyBackdropData, scale: number) {
  if (data.diskRadius > 0) {
    const disk = ctx.createRadialGradient(0, 0, 0, 0, 0, data.diskRadius);
    disk.addColorStop(0, "rgba(150,175,255,0.085)");
    disk.addColorStop(0.5, "rgba(130,160,255,0.05)");
    disk.addColorStop(1, "rgba(130,160,255,0)");
    ctx.fillStyle = disk;
    ctx.beginPath();
    ctx.arc(0, 0, data.diskRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  const bulgeR = data.coreRadius * 1.8;
  const bulge = ctx.createRadialGradient(0, 0, 0, 0, 0, bulgeR);
  bulge.addColorStop(0, "rgba(255,240,205,0.34)");
  bulge.addColorStop(0.3, "rgba(245,200,106,0.16)");
  bulge.addColorStop(1, "rgba(245,200,106,0)");
  ctx.fillStyle = bulge;
  ctx.beginPath();
  ctx.arc(0, 0, bulgeR, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const lane of data.dust.lanes) {
    ctx.strokeStyle = `rgba(3,5,10,${lane.alpha.toFixed(3)})`;
    ctx.lineWidth = lane.width;
    ctx.beginPath();
    lane.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  // Dust in six alpha bands, filled in chunks of `DUST_CHUNK` dots: thousands of dots, in
  // small fills. At least three quarters of a BACKING pixel, so a dim dot never vanishes; taken
  // from the backing scale rather than the camera zoom, so the picture depends on nothing that
  // changes once the backing-store cap binds.
  const minRadius = 0.75 / Math.max(scale, 0.0001);
  // Under a pixel and a half of radius an arc and a square rasterise to the same anti-aliased
  // smudge, and a rect is far cheaper to path and fill. The square has the disc's AREA (side
  // r·√π), so the smudge carries the same light it did as a circle.
  const rectBelow = SMALL_DOT_PX / Math.max(scale, 0.0001);
  const bands: number[][] = [[], [], [], [], [], []];
  data.dust.alpha.forEach((a, i) => bands[Math.min(5, Math.floor(a / 0.04))].push(i));
  bands.forEach((indices, band) => {
    if (indices.length === 0) return;
    ctx.globalAlpha = 0.04 * band + 0.02;
    ctx.fillStyle = "rgb(190,208,255)";
    for (let start = 0; start < indices.length; start += DUST_CHUNK) {
      ctx.beginPath();
      for (const i of indices.slice(start, start + DUST_CHUNK)) {
        const r = Math.max(minRadius, data.dust.radius[i]);
        if (r < rectBelow) {
          const side = r * SQRT_PI;
          ctx.rect(data.dust.x[i] - side / 2, data.dust.y[i] - side / 2, side, side);
          continue;
        }
        ctx.moveTo(data.dust.x[i] + r, data.dust.y[i]);
        ctx.arc(data.dust.x[i], data.dust.y[i], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  });
}
