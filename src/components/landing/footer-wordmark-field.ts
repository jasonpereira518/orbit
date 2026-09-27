// Geometry and timing for the footer wordmark's star field. Pure, so the smoke suite can
// pin it without a browser; footer-wordmark.tsx does the drawing.

// Fraunces at weight 800, measured once per 1000px of font size with canvas measureText
// in the page's own font. INK_* is where the glyphs' ink starts and ends relative to the
// text origin, so the field hugs the letters rather than their side bearings.
export const FONT_SIZE = 1000;
export const WEIGHT = 800;
export const INK_LEFT = 32.45;
export const INK_WIDTH = 2679.3;

// The crop, in the same units. The baseline sits below the bottom edge, so the ascenders
// show in full and the bowls stop partway down: it still reads as "Orbit" while the
// page's last edge cuts through the name.
export const BASELINE = 770;
export const VIEW_H = 580;

/** CSS px between dot centres. Fixed, so a dot is the same size on every screen, down to a
 * floor that keeps a phone's letters more than a handful of rows tall. */
export function pitchFor(width: number): number {
  return Math.min(7, Math.max(4.5, width / 164));
}

/** Dot radius as a share of the pitch. */
export const DOT_SHARE = 0.22;

/** How far from the pointer's path a dot still catches the trail, in CSS px. */
export const TRAIL_RADIUS = 13;
/** A flare's nominal lifetime; each dot's own is scattered around it. */
export const FLARE_MS = 1200;
/** Rise time, so a flare swells in rather than popping on. */
const ATTACK_MS = 60;
/** How deep the twinkle's flicker cuts into a fading dot. */
const FLICKER = 0.35;

export type Dot = {
  x: number;
  y: number;
  /** 0 at the field's top edge, 1 at its bottom: drives the base colour. */
  row01: number;
  /** When it last caught the trail (ms, performance.now clock). */
  lit: number;
  peak: number;
  life: number;
  phase: number;
};

/**
 * One dot per grid cell whose centre falls inside a letter. Whole dots only, so the
 * letters' edges are made of dots rather than dots sliced by the outline.
 */
export function buildGrid(
  width: number,
  height: number,
  pitch: number,
  inside: (x: number, y: number) => boolean
): Dot[] {
  const cols = Math.floor(width / pitch);
  const rows = Math.floor(height / pitch);
  if (cols < 1 || rows < 1) return [];
  // Centred across, so the leftover margin is split evenly between the two edges.
  const x0 = (width - (cols - 1) * pitch) / 2;
  const y0 = pitch / 2;
  const dots: Dot[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * pitch;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * pitch;
      if (!inside(x, y)) continue;
      dots.push({ x, y, row01: y / height, lit: -Infinity, peak: 0, life: 0, phase: 0 });
    }
  }
  return dots;
}

/**
 * The dots within `radius` of the segment a→b, each with a strength that falls off from 1
 * on the path to 0 at the radius. Measured to the whole segment, not its ends, so a fast
 * swipe that moves 200px between two pointer events still lights everything it crossed.
 */
export function dotsNearSegment(
  dots: readonly Dot[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): Array<[index: number, strength: number]> {
  const out: Array<[number, number]> = [];
  const minX = Math.min(ax, bx) - radius;
  const maxX = Math.max(ax, bx) + radius;
  const minY = Math.min(ay, by) - radius;
  const maxY = Math.max(ay, by) + radius;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    if (d.x < minX || d.x > maxX || d.y < minY || d.y > maxY) continue;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((d.x - ax) * dx + (d.y - ay) * dy) / len2));
    const ex = d.x - (ax + t * dx);
    const ey = d.y - (ay + t * dy);
    const dist = Math.sqrt(ex * ex + ey * ey);
    if (dist < radius) out.push([i, 1 - dist / radius]);
  }
  return out;
}

/**
 * A flare's envelope, 0..1: a short rise, then a fade that lands on 0 at `life`. The fade
 * is only just past linear: a squared fade had dimmed a flare to its resting brightness
 * within a few hundred milliseconds, so the trail was gone before it read as one.
 */
export function flare(elapsed: number, life: number): number {
  if (!(elapsed >= 0) || elapsed >= life) return 0;
  const attack = Math.min(ATTACK_MS, life / 4);
  if (elapsed < attack) return elapsed / attack;
  const t = (elapsed - attack) / (life - attack);
  return Math.pow(1 - t, 1.3);
}

/** The envelope with a flicker on top, so a fading trail twinkles instead of dimming evenly. */
export function twinkle(elapsed: number, life: number, phase: number): number {
  const env = flare(elapsed, life);
  if (env === 0) return 0;
  return env * (1 - FLICKER * (0.5 + 0.5 * Math.sin(elapsed * 0.02 + phase)));
}

type Rgba = [r: number, g: number, b: number, a: number];
// Starlight fading up out of the dark, warming to the footer glow's gold.
const STOPS: Array<[at: number, color: Rgba]> = [
  [0, [232, 243, 241, 0]],
  [0.4, [232, 243, 241, 0.4]],
  [1, [242, 193, 78, 1]],
];

/** The resting colour of a dot `row01` of the way down the field. */
export function baseColor(row01: number): Rgba {
  const y = Math.max(0, Math.min(1, row01));
  for (let s = 1; s < STOPS.length; s++) {
    const [at, to] = STOPS[s];
    if (y > at) continue;
    const [from01, from] = STOPS[s - 1];
    const k = (y - from01) / (at - from01);
    return from.map((v, i) => v + (to[i] - v) * k) as Rgba;
  }
  return STOPS[STOPS.length - 1][1];
}
