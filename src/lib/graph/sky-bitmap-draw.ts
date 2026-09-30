/**
 * Drawing the sky's bitmaps — the cluster washes, the star dust and the galaxy backdrop — onto
 * any 2D context.
 *
 * Pure (no DOM, no React), so the same code draws on the page's canvas and on an
 * `OffscreenCanvas` in `sky-bitmap.worker.ts`. See `useSkyBitmap` in graph-nodes.tsx for why
 * there are two places to draw it.
 */
import type {
  NebulaWashData,
  StarDustData,
  StarDustPoint,
} from "@/components/graph/graph-nodes";
import type { GalaxyBackdropData } from "@/lib/graph/galaxy-dust";
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
  else drawGalaxyBackdrop(ctx, job.data, job.zoom);
  ctx.globalAlpha = 1;
}

function drawWash(ctx: Ctx, data: NebulaWashData, scale: number) {
  for (const cluster of data.clusters) {
    // The cluster's dim is applied to its five lobes together, as the element's `opacity`
    // applied it to the five backgrounds together. Instant rather than the 200ms fade the
    // boxes had: a canvas redraws, it does not transition. The stars above made the same
    // trade for the same reason.
    ctx.globalAlpha = cluster.opacity;
    for (const lobe of nebulaLobes(cluster.seed, cluster.radius)) {
      // Under half a backing pixel there is nothing to draw, and a zero-radius gradient throws.
      if (lobe.rx * scale < 0.5 || lobe.ry * scale < 0.5) continue;
      const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, lobe.rx);
      fill.addColorStop(0, withAlpha(cluster.color, lobe.alpha));
      fill.addColorStop(NEBULA_LOBE_MID, withAlpha(cluster.color, lobe.alpha * 0.45));
      // The cluster's own colour at zero alpha, not `transparent`: that keyword is
      // transparent BLACK, so a fade to it drags the hue toward black on the way out
      // instead of simply thinning. The dashboard preview builds the same stops.
      fill.addColorStop(NEBULA_LOBE_EDGE, withAlpha(cluster.color, 0));
      fill.addColorStop(1, withAlpha(cluster.color, 0));
      ctx.save();
      // An ellipse rx by ry, as `radial-gradient(ellipse rx ry at …)` drew it: a circle of
      // radius rx, squashed vertically. The gradient is built in this squashed space, so it
      // stretches with the shape exactly as the CSS one did.
      ctx.translate(cluster.x + lobe.x, cluster.y + lobe.y);
      ctx.scale(1, lobe.ry / lobe.rx);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, lobe.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
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
 * The galaxy behind everything: a cool disk haze, a warm bulge, dark lanes across the strongest
 * relatedness chains, and dust along all of them. Every gradient fades to its OWN colour at zero
 * alpha (never `transparent`, which is black), as the washes do.
 */
export function drawGalaxyBackdrop(ctx: Ctx, data: GalaxyBackdropData, zoom: number) {
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

  // Dust in six alpha bands, one path and one fill each: thousands of dots, a handful of draws.
  const minRadius = 0.75 / Math.max(zoom, 0.01);
  const bands: number[][] = [[], [], [], [], [], []];
  data.dust.alpha.forEach((a, i) => bands[Math.min(5, Math.floor(a / 0.04))].push(i));
  bands.forEach((indices, band) => {
    if (indices.length === 0) return;
    ctx.globalAlpha = 0.04 * band + 0.02;
    ctx.fillStyle = "rgb(190,208,255)";
    ctx.beginPath();
    for (const i of indices) {
      const r = Math.max(minRadius, data.dust.radius[i]);
      ctx.moveTo(data.dust.x[i] + r, data.dust.y[i]);
      ctx.arc(data.dust.x[i], data.dust.y[i], r, 0, Math.PI * 2);
    }
    ctx.fill();
  });
}
