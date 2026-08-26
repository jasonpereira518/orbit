/**
 * The one sky.
 *
 * Shared by the landing/pricing starfield (`components/landing/starfield.tsx`)
 * and the lift-off stage (`components/warp/warp-stage.tsx`). The stage's last
 * frame cross-fades into the real starfield's first, so the two MUST agree on
 * every colour — a half-shade of drift shows up as a visible seam at exactly
 * the moment the user is looking at the sky. Change a value here, never in a
 * consumer.
 */

/** Star body colours, as `r, g, b` triplets ready for `rgba(${X}, a)`. */
export const STAR_WHITE = "232, 243, 241";
export const STAR_GOLD = "242, 193, 78";

/** Base deep-space gradient, centred slightly above the middle of the frame. */
export const SPACE_GRADIENT = [
  { at: 0, color: "#0f1630" },
  { at: 0.42, color: "#0a1024" },
  { at: 0.72, color: "#060915" },
  { at: 1, color: "#03050c" },
] as const;

/** Terminal colour of the space gradient — also what `body:has(.landing-root)`
 * paints on overscroll. The atmosphere ramp below has to land exactly here. */
export const DEEP_SPACE = "#03050c";

/**
 * Soft gas clouds, painted once into the background layer. Positions and radii
 * are fractions of the viewport so they hold their composition at any size;
 * both radii scale by WIDTH so a nebula keeps its aspect instead of stretching
 * on short windows. Alphas are deliberately low — these should register as
 * depth, not as scenery.
 */
export const NEBULAE = [
  // Violet, upper left — the largest, sits behind the hero copy.
  { x: 0.16, y: 0.24, rx: 0.46, ry: 0.3, rot: -0.35, rgb: "104, 96, 214", a: 0.1 },
  // Blue, lower right — balances the solar system's side of the frame.
  { x: 0.84, y: 0.72, rx: 0.42, ry: 0.26, rot: 0.42, rgb: "58, 104, 198", a: 0.09 },
  // Faint cyan low centre, mostly off-frame — keeps the bottom from going flat.
  { x: 0.52, y: 1.02, rx: 0.34, ry: 0.2, rot: 0.1, rgb: "46, 122, 158", a: 0.055 },
] as const;

/**
 * The climb, ground to vacuum. Sampled top-of-atmosphere downward: index 0 is
 * what you see once you're out, the last entry is the haze you launched from.
 *
 * The stage scrolls a window over this ramp rather than cross-fading discrete
 * layers, which is what keeps the sky continuous instead of stepped.
 */
export const ATMOSPHERE = [
  DEEP_SPACE, // vacuum
  "#060b1c", // edge of space
  "#132a55", // high stratosphere
  "#2f5f9e", // deep blue
  "#7fb2dc", // day sky
  "#dfeaf5", // ground haze
] as const;

/** Warm limb glow on the horizon during the climb, and the heat shield on the
 * way down. Same gold as the app's tier accent, so re-entry reads as Orbit's. */
export const HORIZON_GOLD = "242, 193, 78";
/** Heat-shield colour at peak friction — dull orange-red, never a fire emoji. */
export const REENTRY_BURN = "214, 106, 52";

/**
 * Paints the deep-space base gradient plus nebulae onto a 2D context sized
 * `width` x `height` (in CSS px; the caller owns the DPR transform).
 *
 * Both the starfield and the stage call this, which is the point: it is the
 * single definition of what "space" looks like in this product.
 */
export function paintSpace(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const g = ctx.createRadialGradient(
    width * 0.5,
    height * 0.42,
    0,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.9,
  );
  for (const s of SPACE_GRADIENT) g.addColorStop(s.at, s.color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Nebulae composite with "screen" so they only ever lighten — over a
  // near-black base that keeps them glowing rather than milky, and means
  // overlaps blend instead of banding.
  for (const n of NEBULAE) {
    const rx = width * n.rx;
    const ry = width * n.ry;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.translate(width * n.x, height * n.y);
    ctx.rotate(n.rot);
    ctx.scale(1, ry / rx);
    const neb = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    neb.addColorStop(0, `rgba(${n.rgb}, ${n.a})`);
    neb.addColorStop(0.4, `rgba(${n.rgb}, ${n.a * 0.42})`);
    neb.addColorStop(0.72, `rgba(${n.rgb}, ${n.a * 0.12})`);
    neb.addColorStop(1, `rgba(${n.rgb}, 0)`);
    ctx.fillStyle = neb;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Deepen the top-left corner toward black — "multiply" only darkens, so it
  // grounds that corner without dulling the nebula glow or recoloring anything
  // further into the frame.
  const corner = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(width, height) * 0.65);
  corner.addColorStop(0, "rgba(0, 0, 0, 0.6)");
  corner.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = corner;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * The same climb, launched at night — used when the app is in dark mode.
 *
 * Without this, a dark-mode dashboard would wash out to a bright blue day sky
 * the instant you pressed the button, which reads as a bug rather than as a
 * launch. Same six altitude bands, same terminal colour; only the lit half of
 * the ramp changes.
 */
export const ATMOSPHERE_NIGHT = [
  DEEP_SPACE, // vacuum
  "#060b1c", // edge of space
  "#0d1b34", // high stratosphere
  "#152740", // deep night blue
  "#1b2c44", // low haze, lit from below
  "#1e2a38", // ground
] as const;

/** #rrggbb -> [r, g, b]. Every colour in this module is plain hex so the ramp
 * can be interpolated numerically; keep it that way. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h.padEnd(6, "0").slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Samples an altitude ramp at `u`, where 0 is the first entry (vacuum) and 1
 * is the last (ground). Out-of-range values clamp to the ends, so a window
 * that runs off either edge of the ramp simply flattens instead of wrapping.
 */
export function sampleRamp(ramp: readonly string[], u: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, u)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(t));
  const f = t - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}
