/**
 * One frame of the constellation.
 *
 * Painter's algorithm over a single 2D context, in the same order the DOM chart stacks
 * its layers. Everything expensive has been pushed out of the frame: the background is
 * one bitmap, stars and nebulae are blitted sprites, and edges are batched into a
 * handful of paths. What is left per frame is bounded by the viewport, not by the size
 * of the network.
 *
 * Deliberately not a React component and not a hook — a pure function of (context,
 * frame) so `scripts/smoke-graph-canvas.ts` can drive it with a recording stub.
 */
import {
  clusterEmphasis,
  edgeEmphasis,
  starEmphasis,
  type SkyFocusState,
} from "@/lib/graph/sky-emphasis";
import { starVisual, zoomRelief } from "@/lib/graph/star-style";
import {
  visibleWorldRect,
  worldToScreen,
  type Camera,
} from "@/lib/graph/sky-camera";
import { queryRect } from "@/lib/graph/hit-test";
import { nebulaSprite, starSprite, sunSprite } from "./sky-sprites";
import type { SkyIndex, StarEntry } from "./sky-index";

/**
 * At most this many names per frame.
 *
 * Labels are the second way this view used to die: 3,000 `fillText` calls a frame, each
 * needing shaping and measurement. The cap is applied in descending orbit score, so when
 * the sky is too crowded to name everyone, the names you keep are the people closest to
 * you.
 */
export const LABEL_CAP = 60;

/** Below this the sky is stars only — which is also where the default framing lands. */
export const LABEL_MIN_ZOOM = 0.35;
/** The role/company line costs a second `fillText`, so it waits until you're closer. */
export const SUBTITLE_MIN_ZOOM = 0.7;

/** Matches the DOM label box, `max-w-[104px]`. */
export const LABEL_MAX_WIDTH = 104;

export type SkyFrame = {
  index: SkyIndex;
  camera: Camera;
  width: number;
  height: number;
  focus: SkyFocusState;
  /** The cluster being framed, if any — affects edge emphasis only. */
  focusCluster: string | null;
  /** Cluster name driving the haze fade, from hover/selection//company filter. */
  focusCompany: string | null;
  companyFilter: string;
  /** True when the sun is the current selection. */
  sunSelected: boolean;
  background: HTMLCanvasElement | null;
};

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Measured text widths, keyed by the font in force.
 *
 * `measureText` before a webfont resolves returns fallback metrics, and caching those
 * would leave every label mis-truncated for the life of the page — so the key carries
 * the font string and `clearTextCache` is called on `document.fonts.ready`.
 */
const textCache = new Map<string, { text: string; width: number }>();

export function clearTextCache() {
  textCache.clear();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const key = `${ctx.font}|${maxWidth}|${text}`;
  const cached = textCache.get(key);
  if (cached) return cached;

  let out = text;
  let width = ctx.measureText(out).width;
  if (width > maxWidth) {
    // Trim from the end rather than binary-searching: labels are short, and this runs
    // once per label for the life of the layout.
    while (out.length > 1 && width > maxWidth) {
      out = out.slice(0, -1);
      width = ctx.measureText(`${out}…`).width;
    }
    out = `${out}…`;
  }
  const result = { text: out, width };
  textCache.set(key, result);
  return result;
}

/**
 * Text separation without `shadowBlur`, which is pathologically slow on iOS and would
 * cost more than every star put together.
 */
function drawLabelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number
) {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

export function drawSky(ctx: CanvasRenderingContext2D, frame: SkyFrame) {
  const { index, camera, width, height, focus } = frame;

  ctx.clearRect(0, 0, width, height);

  // 1–2. Milky way + fixed starfield, baked into one bitmap on resize.
  if (frame.background) {
    ctx.drawImage(frame.background, 0, 0, width, height);
  }

  const world = visibleWorldRect(camera, width, height);

  // 3. Orbit rings — pure background texture.
  if (index.ringRadii.length > 0) {
    const origin = worldToScreen({ x: 0, y: 0 }, camera);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    index.ringRadii.forEach((r, i) => {
      ctx.setLineDash(i % 2 === 0 ? [2, 16] : [1, 12]);
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, r * camera.k, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  // 4. Nebulae. One blit each, no blur anywhere.
  for (const n of index.nebulae) {
    if (
      n.x + n.radius < world.minX ||
      n.x - n.radius > world.maxX ||
      n.y + n.radius < world.minY ||
      n.y - n.radius > world.maxY
    ) {
      continue;
    }
    const sprite = nebulaSprite(n.color, n.company);
    if (!sprite) continue;
    const alpha = clusterEmphasis(
      n.company,
      frame.focusCompany,
      frame.companyFilter,
      focus.searchDimActive
    );
    const p = worldToScreen({ x: n.x, y: n.y }, camera);
    // The DOM box is `radius * 4` across; keep the same footprint.
    const size = n.radius * 4 * camera.k;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite.canvas, p.x - size / 2, p.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;

  // 5. Figure edges, bucketed by appearance so the whole sky is a handful of paths.
  const buckets = new Map<string, { stroke: string; alpha: number; wide: number; segs: number[] }>();
  for (const e of index.edges) {
    // Cheap segment-vs-viewport reject on the bounding box of the line.
    if (
      Math.max(e.ax, e.bx) < world.minX ||
      Math.min(e.ax, e.bx) > world.maxX ||
      Math.max(e.ay, e.by) < world.minY ||
      Math.min(e.ay, e.by) > world.maxY
    ) {
      continue;
    }
    const { opacity, strokeWidth } = edgeEmphasis(e, {
      ...focus,
      focusCluster: frame.focusCluster,
    });
    if (opacity <= 0.01) continue;

    const alpha = Math.round(opacity * 20) / 20;
    const wide = Math.min(2, Math.max(0.5, strokeWidth * camera.k));
    const key = `${e.stroke}|${alpha}|${wide.toFixed(2)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { stroke: e.stroke, alpha, wide, segs: [] };
      buckets.set(key, bucket);
    }
    const a = worldToScreen({ x: e.ax, y: e.ay }, camera);
    const b = worldToScreen({ x: e.bx, y: e.by }, camera);
    bucket.segs.push(a.x, a.y, b.x, b.y);
  }
  for (const bucket of buckets.values()) {
    ctx.globalAlpha = bucket.alpha;
    ctx.strokeStyle = bucket.stroke;
    ctx.lineWidth = bucket.wide;
    ctx.beginPath();
    for (let i = 0; i < bucket.segs.length; i += 4) {
      ctx.moveTo(bucket.segs[i], bucket.segs[i + 1]);
      ctx.lineTo(bucket.segs[i + 2], bucket.segs[i + 3]);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 6. Stars. The grid cull is what keeps this proportional to the viewport.
  const visibleIds = new Set(
    queryRect(index.grid, world)
      .filter((t) => t.kind === "contact")
      .map((t) => t.id)
    );
  const drawn: StarEntry[] = [];

  for (const star of index.stars) {
    if (!visibleIds.has(star.id)) continue;
    drawn.push(star);

    const emphasis = starEmphasis(star.id, focus);
    const visual = starVisual(
      { ...star.data, spotlight: emphasis.spotlight },
      emphasis.selected
    );
    const sprite = starSprite({
      fill: visual.fill,
      core: visual.core,
      spotlightBoost: visual.spotlightBoost,
      alphaScale: visual.alphaScale,
    });
    if (!sprite) continue;

    const p = worldToScreen({ x: star.x, y: star.y }, camera);
    const disc =
      visual.disc * camera.k * zoomRelief(visual.disc, camera.k) * (emphasis.selected ? 1.25 : 1);
    const size = disc * sprite.scale;

    ctx.globalAlpha = emphasis.opacity;
    ctx.drawImage(sprite.canvas, p.x - size / 2, p.y - size / 2, size, size);

    if (star.data.overdue) {
      ctx.globalAlpha = emphasis.opacity * 0.8;
      ctx.strokeStyle = "#c4a35a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, disc / 2 + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // A comet keeps its trail; it just does not drift. The tail points anti-solar,
    // which is what `orbitAngle` already encodes.
    if (visual.isComet) {
      const angle = (star.data.orbitAngle ?? 0) + Math.PI;
      const length = disc * 3.2;
      const tail = ctx.createLinearGradient(
        p.x,
        p.y,
        p.x + Math.cos(angle) * length,
        p.y + Math.sin(angle) * length
      );
      tail.addColorStop(0, "rgba(255,180,160,0.55)");
      tail.addColorStop(1, "rgba(255,138,112,0)");
      ctx.globalAlpha = emphasis.opacity;
      ctx.strokeStyle = tail;
      ctx.lineWidth = Math.max(1, disc * 0.5);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(angle) * length, p.y + Math.sin(angle) * length);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // 7. The sun.
  if (index.sun) {
    const sprite = sunSprite();
    if (sprite) {
      const p = worldToScreen({ x: index.sun.x, y: index.sun.y }, camera);
      const core = (frame.sunSelected ? 26 : 22) * camera.k;
      const size = core * sprite.scale;
      ctx.drawImage(sprite.canvas, p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  // 8–9. Text. One font per bucket, and a hard budget.
  const placed: Rect[] = [];

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(3,5,10,0.65)";
  ctx.lineWidth = 3;

  // Cluster names first: they are the map's coarse legend and must win any collision
  // against an individual star's label.
  if (camera.k >= LABEL_MIN_ZOOM * 0.5) {
    ctx.font = "600 11px system-ui, sans-serif";
    for (const label of index.clusterLabels) {
      if (
        label.x < world.minX ||
        label.x > world.maxX ||
        label.y < world.minY ||
        label.y > world.maxY
      ) {
        continue;
      }
      const p = worldToScreen({ x: label.x, y: label.y }, camera);
      const fitted = fitText(ctx, label.label, LABEL_MAX_WIDTH);
      const rect = { x: p.x - fitted.width / 2, y: p.y, w: fitted.width, h: 14 };
      placed.push(rect);
      ctx.globalAlpha = clusterEmphasis(
        label.label,
        frame.focusCompany,
        frame.companyFilter,
        focus.searchDimActive
      );
      ctx.fillStyle = label.color;
      drawLabelText(ctx, fitted.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  if (index.sun) {
    const p = worldToScreen({ x: index.sun.x, y: index.sun.y }, camera);
    ctx.font = "500 11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    const y = p.y + 16 * camera.k + 6;
    drawLabelText(ctx, index.sun.data.label, p.x, y);
    placed.push({ x: p.x - 40, y, w: 80, h: 14 });
  }

  /**
   * Who gets a name.
   *
   * Anything the reader explicitly asked about — the selection, the hovered star, every
   * search hit — is labelled at any zoom. Nothing a person went looking for is ever
   * left silent because the camera happened to be pulled back.
   */
  const alwaysLabelled = new Set<string>();
  if (focus.selectedContactId) alwaysLabelled.add(focus.selectedContactId);
  if (focus.hoveredId) alwaysLabelled.add(focus.hoveredId);
  for (const id of focus.searchHitIds) alwaysLabelled.add(id);

  const drawnIds = new Set(drawn.map((s) => s.id));
  const candidates: StarEntry[] = [];
  for (const id of alwaysLabelled) {
    const entry = index.starsById.get(id);
    if (entry && drawnIds.has(id)) candidates.push(entry);
  }
  if (camera.k >= LABEL_MIN_ZOOM) {
    for (const star of index.labelOrder) {
      if (candidates.length >= LABEL_CAP) break;
      if (!drawnIds.has(star.id) || alwaysLabelled.has(star.id)) continue;
      candidates.push(star);
    }
  }

  const showSubtitles = camera.k >= SUBTITLE_MIN_ZOOM;
  ctx.font = "500 11px system-ui, sans-serif";

  for (const star of candidates) {
    const emphasis = starEmphasis(star.id, focus);
    const visual = starVisual(
      { ...star.data, spotlight: emphasis.spotlight },
      emphasis.selected
    );
    const p = worldToScreen({ x: star.x, y: star.y }, camera);
    const y = p.y + (visual.disc * camera.k) / 2 + 4;

    const fitted = fitText(ctx, star.data.label, LABEL_MAX_WIDTH);
    const rect = { x: p.x - fitted.width / 2, y, w: fitted.width, h: 13 };
    // Score-descending order means the more important label already holds the space.
    if (!alwaysLabelled.has(star.id) && placed.some((r) => overlaps(rect, r))) continue;
    placed.push(rect);

    ctx.globalAlpha = emphasis.opacity;
    ctx.fillStyle = visual.isComet
      ? "#ffb4a0"
      : emphasis.spotlight
        ? "#ffffff"
        : "rgba(255,255,255,0.95)";
    drawLabelText(ctx, fitted.text, p.x, y);

    if (showSubtitles && visual.subtitle) {
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillStyle = visual.isComet ? "rgba(255,138,112,0.7)" : "rgba(255,255,255,0.45)";
      drawLabelText(ctx, fitText(ctx, visual.subtitle, LABEL_MAX_WIDTH).text, p.x, y + 12);
      ctx.font = "500 11px system-ui, sans-serif";
    }
  }
  ctx.globalAlpha = 1;

  // 10. The selection ring, last so nothing paints over it.
  const selectedId = focus.selectedContactId;
  if (selectedId) {
    const star = index.starsById.get(selectedId);
    if (star) {
      const visual = starVisual(star.data, true);
      const p = worldToScreen({ x: star.x, y: star.y }, camera);
      const r = Math.max(9, (visual.disc * camera.k) / 2 + 6);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return { starsDrawn: drawn.length, labelsDrawn: candidates.length };
}
