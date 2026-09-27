/**
 * Pre-rendered art, so a frame is `drawImage` calls rather than gradient construction.
 *
 * This is the file that makes the canvas cheap. A star in the DOM chart carries an
 * inline radial gradient and a two-layer box-shadow; drawn naively that becomes a
 * `createRadialGradient` per star per frame, and at 1,500 visible stars the allocation
 * and ramp evaluation dominate everything else. But the star population is small and
 * discrete — a handful of score tiers across a handful of cluster colours — so each
 * distinct star is baked once into a small offscreen canvas, glow and all, and every
 * subsequent frame just blits it.
 *
 * Every cache is bounded by the sky's own vocabulary (score tiers × cluster colours ×
 * emphasis states), so none of them needs eviction.
 */
import { withAlpha } from "@/lib/school-color";
import { CONSTELLATION_STAR_PX } from "@/lib/graph/starfield-scale";

/** iOS Safari has a canvas-area ceiling; past it a canvas silently blanks. */
export const DPR_CAP = 2;

export function deviceRatio(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(window.devicePixelRatio || 1, DPR_CAP);
}

type Sprite = { canvas: HTMLCanvasElement; /** Sprite px per unit of star diameter. */ scale: number };

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

/**
 * The sprite is drawn `GLOW_SPAN`× wider than the star itself, because the DOM's outer
 * box-shadow reaches roughly one diameter past the edge. Blitting at the star's own size
 * would clip the glow off and the sky would read as flat dots.
 */
const GLOW_SPAN = 4;
/** Resolution of the baked sprite. Stars are tiny; 64px is already generous. */
const STAR_SPRITE_PX = 64;

export type StarSpriteSpec = {
  /** Outer wash colour — what the glow is tinted with. */
  fill: string;
  /** Inner colour, halfway out of the gradient. */
  core: string;
  spotlightBoost: number;
  alphaScale: number;
};

const starCache = new Map<string, Sprite>();

function starKey(spec: StarSpriteSpec) {
  return `${spec.fill}|${spec.core}|${spec.spotlightBoost}|${spec.alphaScale}`;
}

/**
 * One star, glow baked in.
 *
 * The body reproduces `radial-gradient(circle at 35% 30%, #fff 0%, core 50%, transparent
 * 78%)` from the DOM star; the two glow rings reproduce its box-shadow pair. Because the
 * glow is part of the bitmap, drawing it costs exactly the same as not drawing it.
 */
export function starSprite(spec: StarSpriteSpec): Sprite | null {
  const key = starKey(spec);
  const cached = starCache.get(key);
  if (cached) return cached;

  const made = makeCanvas(STAR_SPRITE_PX);
  if (!made) return null;
  const { canvas, ctx } = made;

  const c = STAR_SPRITE_PX / 2;
  const bodyRadius = STAR_SPRITE_PX / (2 * GLOW_SPAN);

  // Outer glow, then inner glow — the DOM's two box-shadow layers, widest first.
  const outer = ctx.createRadialGradient(c, c, bodyRadius, c, c, c);
  outer.addColorStop(0, withAlpha(spec.fill, 0.1 * spec.alphaScale));
  outer.addColorStop(1, withAlpha(spec.fill, 0));
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, STAR_SPRITE_PX, STAR_SPRITE_PX);

  const inner = ctx.createRadialGradient(c, c, bodyRadius * 0.5, c, c, bodyRadius * 2.2);
  inner.addColorStop(0, withAlpha(spec.fill, 0.32 * spec.spotlightBoost * spec.alphaScale));
  inner.addColorStop(1, withAlpha(spec.fill, 0));
  ctx.fillStyle = inner;
  ctx.fillRect(0, 0, STAR_SPRITE_PX, STAR_SPRITE_PX);

  // The star itself, lit from the upper left exactly as the DOM gradient is.
  const bx = c - bodyRadius * 0.3;
  const by = c - bodyRadius * 0.4;
  const body = ctx.createRadialGradient(bx, by, 0, c, c, bodyRadius);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.5, spec.core);
  body.addColorStop(0.78, withAlpha(spec.core, 0));
  body.addColorStop(1, withAlpha(spec.core, 0));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, bodyRadius, 0, Math.PI * 2);
  ctx.fill();

  const sprite: Sprite = { canvas, scale: GLOW_SPAN };
  starCache.set(key, sprite);
  return sprite;
}

// ---------------------------------------------------------------------------
// The sun
// ---------------------------------------------------------------------------

const SUN_SPRITE_PX = 256;
let sunCache: Sprite | null = null;

/** The sun: a hot core inside two coronas, matching `SunNode`'s layered shadows. */
export function sunSprite(): Sprite | null {
  if (sunCache) return sunCache;
  const made = makeCanvas(SUN_SPRITE_PX);
  if (!made) return null;
  const { canvas, ctx } = made;
  const c = SUN_SPRITE_PX / 2;

  const corona = ctx.createRadialGradient(c, c, 0, c, c, c);
  corona.addColorStop(0, "rgba(255,248,220,0.42)");
  corona.addColorStop(0.35, "rgba(255,200,100,0.18)");
  corona.addColorStop(0.55, "rgba(255,160,60,0.06)");
  corona.addColorStop(0.72, "rgba(255,140,40,0)");
  ctx.fillStyle = corona;
  ctx.fillRect(0, 0, SUN_SPRITE_PX, SUN_SPRITE_PX);

  const coreRadius = SUN_SPRITE_PX / 16;
  const core = ctx.createRadialGradient(
    c - coreRadius * 0.3,
    c - coreRadius * 0.4,
    0,
    c,
    c,
    coreRadius
  );
  core.addColorStop(0, "#ffffff");
  core.addColorStop(0.28, "#fff6d6");
  core.addColorStop(0.65, "#f5c86a");
  core.addColorStop(1, "#e09030");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(c, c, coreRadius, 0, Math.PI * 2);
  ctx.fill();

  // Sprite is 8× the 22px core the DOM draws, so the coronas have room.
  sunCache = { canvas, scale: 8 };
  return sunCache;
}

// ---------------------------------------------------------------------------
// Nebulae
// ---------------------------------------------------------------------------

const NEBULA_SPRITE_PX = 128;
const nebulaCache = new Map<string, Sprite>();

/** Stable 0..1 from a string, so each cluster's wash keeps its shape. */
function nebulaHash(seed: string, salt: number) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}

/**
 * A cluster's haze, as one bitmap.
 *
 * The DOM version stacks conic gradients, `mask-image` and three `filter: blur()` layers
 * whose radius scales with the cluster — by a distance the most expensive thing on the
 * page for a mobile GPU, and the reason a big network took the tab down. The soft lobes
 * here are built from plain radial ramps, which need no blur to look diffuse, and the
 * whole thing is rasterised once per cluster colour.
 */
export function nebulaSprite(color: string, seed: string): Sprite | null {
  const key = `${color}|${seed}`;
  const cached = nebulaCache.get(key);
  if (cached) return cached;

  const made = makeCanvas(NEBULA_SPRITE_PX);
  if (!made) return null;
  const { canvas, ctx } = made;
  const c = NEBULA_SPRITE_PX / 2;

  const base = ctx.createRadialGradient(c, c, 0, c, c, c);
  base.addColorStop(0, withAlpha(color, 0.2));
  base.addColorStop(0.45, withAlpha(color, 0.09));
  base.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, NEBULA_SPRITE_PX, NEBULA_SPRITE_PX);

  // Five offset lobes give the haze a direction so clusters are distinguishable at a
  // glance without any of them looking like a plain disc.
  for (let i = 0; i < 5; i += 1) {
    const angle = nebulaHash(seed, i * 3) * Math.PI * 2;
    const dist = (0.18 + nebulaHash(seed, i * 3 + 1) * 0.3) * c;
    const radius = (0.3 + nebulaHash(seed, i * 3 + 2) * 0.34) * c;
    const alpha = 0.05 + nebulaHash(seed, i * 3 + 5) * 0.07;
    const lx = c + Math.cos(angle) * dist;
    const ly = c + Math.sin(angle) * dist;

    const lobe = ctx.createRadialGradient(lx, ly, 0, lx, ly, radius);
    lobe.addColorStop(0, withAlpha(color, alpha));
    lobe.addColorStop(0.55, withAlpha(color, alpha * 0.45));
    lobe.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = lobe;
    ctx.fillRect(0, 0, NEBULA_SPRITE_PX, NEBULA_SPRITE_PX);
  }

  const sprite: Sprite = { canvas, scale: 1 };
  nebulaCache.set(key, sprite);
  return sprite;
}

// ---------------------------------------------------------------------------
// Background: milky way + the fixed starfield
// ---------------------------------------------------------------------------

/** Matches the DOM starfield's count so the two skies read as the same place. */
const FIELD_STARS = 220;

/**
 * The two static layers, baked into one bitmap on resize.
 *
 * Both are screen-space — the DOM `.constellation-starfield` is `inset-0`, fixed to the
 * pane rather than pinned to the sky, and that is preserved here. Redrawing three large
 * radial gradients plus 220 arcs every frame is the one remaining per-frame gradient
 * cost worth eliminating outright.
 */
export function bakeBackground(
  width: number,
  height: number,
  dpr: number
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const band = (cx: number, cy: number, r: number, alpha: number) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(180,205,255,${alpha})`);
    g.addColorStop(0.5, `rgba(150,180,255,${alpha * 0.4})`);
    g.addColorStop(1, "rgba(120,150,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  };
  band(width * 0.3, height * 0.25, Math.max(width, height) * 0.55, 0.05);
  band(width * 0.72, height * 0.68, Math.max(width, height) * 0.5, 0.04);
  band(width * 0.5, height * 0.5, Math.max(width, height) * 0.75, 0.025);

  // The same deterministic placement and size distribution as the DOM field, so the
  // warp hand-off still lands on a matching sky. See `starfield-scale.ts`.
  for (let i = 0; i < FIELD_STARS; i += 1) {
    const x = ((((i * 47 + 13) * 7) % 1000) / 1000) * width;
    const y = ((((i * 83 + 29) * 11) % 1000) / 1000) * height;
    const size =
      i % 17 === 0
        ? CONSTELLATION_STAR_PX.brightest
        : i % 5 === 0
          ? CONSTELLATION_STAR_PX.bright
          : CONSTELLATION_STAR_PX.common;
    ctx.globalAlpha = 0.25 + (i % 8) * 0.08;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  return canvas;
}

/** Drop every cached bitmap. Called when the document's fonts or theme change. */
export function clearSpriteCaches() {
  starCache.clear();
  nebulaCache.clear();
  sunCache = null;
}
