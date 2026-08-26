/**
 * Everything you pass on the way up.
 *
 * Pure 2D-canvas painters: no React, no state, no time. Each takes a context
 * and a placement and draws one body. All the choreography — where these are,
 * how big, how faded — lives in `warp-stage.tsx`, so this file can be read as
 * "what does a satellite look like" without also being the flight plan.
 *
 * Positions inside a body are normalised to its own radius, so every one of
 * these scales from a thumbnail to a full frame without re-tuning.
 */

const TAU = Math.PI * 2;

/* ── Earth ─────────────────────────────────────────────────────────────── */

/**
 * Deterministic PRNG (mulberry32).
 *
 * Earth is generated, not drawn, and it should be the SAME Earth for
 * everyone every time — a planet that reshuffles its continents on each
 * launch is a bug you only notice on the second trip. Seeded, so the
 * randomness is a shape generator rather than a variable.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Grid = { n: number; v: Float32Array };

function makeGrid(rand: () => number, n: number): Grid {
  const v = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) v[i] = rand();
  return { n, v };
}

/** Value noise with smoothstep interpolation, wrapping at the grid edges. */
function sampleGrid({ n, v }: Grid, x: number, y: number) {
  const fx = x * n;
  const fy = y * n;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const x0 = ((ix % n) + n) % n;
  const y0 = ((iy % n) + n) % n;
  const x1 = (x0 + 1) % n;
  const y1 = (y0 + 1) % n;
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = v[y0 * n + x0] + (v[y0 * n + x1] - v[y0 * n + x0]) * sx;
  const bot = v[y1 * n + x0] + (v[y1 * n + x1] - v[y1 * n + x0]) * sx;
  return top + (bot - top) * sy;
}

/** Four octaves of value noise, normalised to 0..1. */
function fbm(grids: Grid[], x: number, y: number) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (const g of grids) {
    sum += sampleGrid(g, x, y) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Linear blend between two packed rgb triples. */
function mix(a: number[], b: number[], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const DEEP = [10, 34, 68];
const SHELF = [27, 79, 140];
const SHALLOW = [52, 121, 178];
const COAST = [196, 182, 130];
const LOWLAND = [61, 118, 71];
const UPLAND = [104, 122, 66];
const PEAK = [150, 142, 124];
const ICE = [238, 245, 251];

/** Above this the noise is land. Tuned by eye for roughly a third land, which
 * is what makes a planet read as ocean-covered rather than as a rock. */
const SEA_LEVEL = 0.52;

/**
 * Builds Earth's surface once, into an offscreen square.
 *
 * Generated from value noise rather than drawn from a shape table: hand-placed
 * ellipses read as lily pads at any size above a thumbnail, and the whole point
 * of this planet is that you approach it close enough to see a coastline.
 *
 * Cost is ~200k pixels x two fbm samples, which lands around 50ms once, at
 * launch. That is affordable precisely here — the craft's fall is a compositor
 * driven CSS animation, so a brief main-thread stall doesn't touch it, and the
 * reveal vignette still has the canvas almost fully masked out this early.
 */
export function makeEarthTexture(size = 448): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;

  const rand = rng(20260826);
  const land = [4, 8, 16, 32].map((n) => makeGrid(rand, n));
  const weather = [3, 6, 12, 24].map((n) => makeGrid(rand, n));

  const img = g.createImageData(size, size);
  const px = img.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Distance from the equator, 0 at the middle and 1 at either pole.
    const lat = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const e = fbm(land, u, v);
      let col: number[];

      if (e > SEA_LEVEL) {
        const h = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
        col =
          h < 0.08
            ? mix(COAST, LOWLAND, h / 0.08)
            : h < 0.55
              ? mix(LOWLAND, UPLAND, (h - 0.08) / 0.47)
              : mix(UPLAND, PEAK, (h - 0.55) / 0.45);
      } else {
        const d = e / SEA_LEVEL;
        col = d > 0.86 ? mix(SHELF, SHALLOW, (d - 0.86) / 0.14) : mix(DEEP, SHELF, d / 0.86);
      }

      // Ice caps. Kept tight: a wide cap swallows the top third of the disc
      // and the planet stops reading as blue.
      if (lat > 0.84) col = mix(col, ICE, Math.min(1, (lat - 0.84) / 0.12));

      // Weather on top of everything, thickest in the mid-latitudes.
      const cl = fbm(weather, u * 1.6, v * 1.6);
      if (cl > 0.55) {
        const band = 0.55 + 0.45 * Math.sin(lat * Math.PI);
        col = mix(col, [255, 255, 255], Math.min(0.92, (cl - 0.55) * 3.1 * band));
      }

      const i = (y * size + x) * 4;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }

  g.putImageData(img, 0, 0);
  return c;
}

/**
 * The planet you are leaving.
 *
 * Drawn as a disc rather than a dome even when most of it is off-frame: at
 * the start of the climb `r` is several screens wide, so only a shallow arc
 * of the limb is visible and the curvature grows on its own as it shrinks.
 * That is the whole "pulling away from a planet" read, and it comes for free
 * from the geometry instead of needing a separate horizon drawing.
 */
export function drawEarth(
  ctx: CanvasRenderingContext2D,
  tex: HTMLCanvasElement | null,
  o: { cx: number; cy: number; r: number; alpha: number; rim: number },
) {
  if (o.alpha <= 0.002 || o.r <= 0) return;
  ctx.save();
  ctx.globalAlpha = o.alpha;

  // Atmosphere, outside the limb. Additive so it glows off the black rather
  // than sitting on it as a grey halo.
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const air = ctx.createRadialGradient(o.cx, o.cy, o.r * 0.965, o.cx, o.cy, o.r * 1.1);
  air.addColorStop(0, `rgba(120, 190, 255, ${0.65 * o.rim})`);
  air.addColorStop(0.3, `rgba(96, 168, 245, ${0.34 * o.rim})`);
  air.addColorStop(1, "rgba(96, 168, 245, 0)");
  ctx.fillStyle = air;
  ctx.beginPath();
  ctx.arc(o.cx, o.cy, o.r * 1.1, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(o.cx, o.cy, o.r, 0, TAU);
  ctx.clip();

  const d = o.r * 2;
  if (tex) {
    ctx.drawImage(tex, o.cx - o.r, o.cy - o.r, d, d);
  } else {
    ctx.fillStyle = "#1b4f8c";
    ctx.fillRect(o.cx - o.r, o.cy - o.r, d, d);
  }

  // Terminator: night creeping in from the lower right. Anchored off-centre
  // so the lit side agrees with the ocean's highlight in the texture.
  const night = ctx.createRadialGradient(
    o.cx - o.r * 0.4,
    o.cy - o.r * 0.44,
    o.r * 0.06,
    o.cx - o.r * 0.06,
    o.cy - o.r * 0.06,
    o.r * 1.02,
  );
  night.addColorStop(0, "rgba(0, 0, 0, 0)");
  night.addColorStop(0.5, "rgba(2, 6, 18, 0.05)");
  night.addColorStop(0.76, "rgba(2, 6, 18, 0.26)");
  night.addColorStop(0.92, "rgba(1, 4, 12, 0.58)");
  night.addColorStop(1, "rgba(1, 3, 10, 0.78)");
  ctx.fillStyle = night;
  ctx.fillRect(o.cx - o.r, o.cy - o.r, d, d);

  ctx.restore();
  ctx.restore();
}

/* ── Satellites ────────────────────────────────────────────────────────── */

/**
 * A satellite, drifting past. Body, two panelled wings, a dish, and a glint
 * off the foil when its rotation catches the sun.
 */
export function drawSatellite(
  ctx: CanvasRenderingContext2D,
  o: { x: number; y: number; s: number; rot: number; alpha: number },
) {
  if (o.alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot);
  const s = o.s;

  // Wings. Foreshortened by the tumble so they read as flat panels in space
  // rather than as two sticks glued to a box.
  const spread = Math.cos(o.rot * 0.8);
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.translate(dir * 13 * s, 0);
    ctx.scale(Math.max(0.12, Math.abs(spread)), 1);
    ctx.fillStyle = "rgba(46, 74, 132, 0.95)";
    ctx.fillRect(-8 * s, -5 * s, 16 * s, 10 * s);
    ctx.strokeStyle = "rgba(150, 190, 240, 0.5)";
    ctx.lineWidth = Math.max(0.4, 0.6 * s);
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-8 * s + (16 * s * i) / 3, -5 * s);
      ctx.lineTo(-8 * s + (16 * s * i) / 3, 5 * s);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Boom between the wings.
  ctx.strokeStyle = "rgba(190, 200, 215, 0.8)";
  ctx.lineWidth = Math.max(0.5, 1.1 * s);
  ctx.beginPath();
  ctx.moveTo(-13 * s, 0);
  ctx.lineTo(13 * s, 0);
  ctx.stroke();

  // Body, in gold foil.
  const body = ctx.createLinearGradient(-5 * s, -6 * s, 5 * s, 6 * s);
  body.addColorStop(0, "#e6d3a3");
  body.addColorStop(0.5, "#c9ab6d");
  body.addColorStop(1, "#8d7442");
  ctx.fillStyle = body;
  ctx.fillRect(-5 * s, -6 * s, 10 * s, 12 * s);

  // Dish.
  ctx.fillStyle = "rgba(226, 232, 240, 0.92)";
  ctx.beginPath();
  ctx.ellipse(0, -8.5 * s, 3.4 * s, 2 * s, 0, 0, TAU);
  ctx.fill();

  const glint = Math.max(0, Math.sin(o.rot * 1.7));
  if (glint > 0.55) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const g = ctx.createRadialGradient(2 * s, -2 * s, 0, 2 * s, -2 * s, 9 * s);
    g.addColorStop(0, `rgba(255, 255, 246, ${(glint - 0.55) * 1.6})`);
    g.addColorStop(1, "rgba(255, 255, 246, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(2 * s, -2 * s, 9 * s, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/* ── Rocket ────────────────────────────────────────────────────────────── */

/**
 * Another launch, racing ahead of us.
 *
 * Drawn nose-up with the plume below, because it is climbing the same way we
 * are — it shrinks rather than falls, which is what sells "it is ahead of us"
 * instead of "it is dropping past us".
 */
export function drawRocket(
  ctx: CanvasRenderingContext2D,
  o: { x: number; y: number; s: number; alpha: number; flicker: number },
) {
  if (o.alpha <= 0.002) return;
  const s = o.s;
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.translate(o.x, o.y);

  // Plume first, so the fins overlap it.
  const len = (34 + o.flicker * 16) * s;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const fire = ctx.createLinearGradient(0, 9 * s, 0, 9 * s + len);
  fire.addColorStop(0, "rgba(255, 252, 238, 0.95)");
  fire.addColorStop(0.16, "rgba(255, 214, 132, 0.85)");
  fire.addColorStop(0.5, "rgba(244, 146, 58, 0.45)");
  fire.addColorStop(1, "rgba(214, 106, 52, 0)");
  ctx.fillStyle = fire;
  ctx.beginPath();
  ctx.moveTo(-4 * s, 9 * s);
  ctx.quadraticCurveTo(0, 9 * s + len * 1.05, 4 * s, 9 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Exhaust trail, fading behind.
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    ctx.fillStyle = `rgba(198, 206, 214, ${0.14 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(0, 9 * s + len * (0.9 + t * 1.6), (3 + i * 2.2) * s, 0, TAU);
    ctx.fill();
  }

  // Fins.
  ctx.fillStyle = "#b9c2cc";
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(dir * 3.4 * s, 2 * s);
    ctx.lineTo(dir * 8 * s, 10 * s);
    ctx.lineTo(dir * 3.4 * s, 10 * s);
    ctx.closePath();
    ctx.fill();
  }

  // Body.
  const hull = ctx.createLinearGradient(-3.6 * s, 0, 3.6 * s, 0);
  hull.addColorStop(0, "#8d97a3");
  hull.addColorStop(0.35, "#eef2f6");
  hull.addColorStop(1, "#9aa4b0");
  ctx.fillStyle = hull;
  ctx.fillRect(-3.6 * s, -10 * s, 7.2 * s, 20 * s);

  // Nose cone.
  ctx.fillStyle = "#d8534a";
  ctx.beginPath();
  ctx.moveTo(0, -18 * s);
  ctx.lineTo(3.6 * s, -9 * s);
  ctx.lineTo(-3.6 * s, -9 * s);
  ctx.closePath();
  ctx.fill();

  // Porthole.
  ctx.fillStyle = "rgba(46, 74, 110, 0.95)";
  ctx.beginPath();
  ctx.arc(0, -4 * s, 1.7 * s, 0, TAU);
  ctx.fill();

  ctx.restore();
}

/* ── Planets ───────────────────────────────────────────────────────────── */

export type PlanetDef = {
  /** Sunlit side. */
  lit: string;
  /** Shadowed side, and the base the bands sit on. */
  dark: string;
  /** Horizontal cloud bands, as [offset from centre, half-height, colour]. */
  bands?: [number, number, string][];
  ring?: { inner: number; outer: number; tilt: number; color: string };
};

/** A small, deliberately non-solar-system cast. These are set dressing for a
 * climb out of one gravity well, not an orrery — they only need to read as
 * "other worlds, far away" in the second and a half they are on screen. */
export const PLANET_KINDS: Record<string, PlanetDef> = {
  ringed: {
    lit: "#e6cf9e",
    dark: "#8a7448",
    bands: [
      [-0.34, 0.09, "rgba(150, 124, 74, 0.4)"],
      [0.06, 0.13, "rgba(247, 231, 190, 0.32)"],
      [0.44, 0.1, "rgba(140, 116, 70, 0.36)"],
    ],
    ring: { inner: 1.35, outer: 2.05, tilt: 0.34, color: "216, 198, 156" },
  },
  jovian: {
    lit: "#d99a6c",
    dark: "#7a4a34",
    bands: [
      [-0.42, 0.08, "rgba(120, 70, 48, 0.45)"],
      [-0.1, 0.11, "rgba(240, 200, 168, 0.3)"],
      [0.28, 0.09, "rgba(126, 74, 50, 0.42)"],
      [0.58, 0.07, "rgba(238, 196, 160, 0.24)"],
    ],
  },
  ice: {
    lit: "#9fd4e4",
    dark: "#2f6a86",
  },
  rust: {
    lit: "#c9714a",
    dark: "#6d3320",
  },
  moon: {
    lit: "#d3d6da",
    dark: "#6a6e75",
  },
};

/** A distant world. Rings are split around the body so the back half is
 * occluded — the one detail that stops a ringed planet reading as a sticker. */
export function drawPlanet(
  ctx: CanvasRenderingContext2D,
  o: { x: number; y: number; r: number; alpha: number; def: PlanetDef },
) {
  if (o.alpha <= 0.002 || o.r <= 0.4) return;
  const { def } = o;
  ctx.save();
  ctx.globalAlpha = o.alpha;

  const ringPath = (front: boolean) => {
    if (!def.ring) return;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(-0.22);
    ctx.scale(1, def.ring.tilt);
    ctx.beginPath();
    ctx.arc(0, 0, (o.r * (def.ring.inner + def.ring.outer)) / 2, front ? 0 : Math.PI, front ? Math.PI : TAU);
    ctx.strokeStyle = `rgba(${def.ring.color}, 0.55)`;
    ctx.lineWidth = o.r * (def.ring.outer - def.ring.inner);
    ctx.stroke();
    ctx.restore();
  };

  ringPath(false);

  const body = ctx.createRadialGradient(
    o.x - o.r * 0.38,
    o.y - o.r * 0.4,
    o.r * 0.05,
    o.x,
    o.y,
    o.r * 1.15,
  );
  body.addColorStop(0, def.lit);
  body.addColorStop(0.62, def.dark);
  body.addColorStop(1, "#08111f");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.r, 0, TAU);
  ctx.fill();

  if (def.bands) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, TAU);
    ctx.clip();
    for (const [off, half, color] of def.bands) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(o.x, o.y + o.r * off, o.r * 1.05, o.r * half, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  ringPath(true);
  ctx.restore();
}
