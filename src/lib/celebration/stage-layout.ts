/**
 * The one geometry both celebration renderers share. The canvas draws the
 * star, ring sweep, and guide arcs from these numbers; the DOM seats the
 * headline, cards, and finale logo on the same ones. Both call
 * `stageLayout(window.innerWidth, window.innerHeight)` — the function is
 * pure, so agreement is guaranteed. A few pixels of drift here reads as the
 * ring having slipped off the logo.
 */

export const NARROW_BREAKPOINT = 640;

/** `OrbitLogo size="hero"` is 96px; the ignition sweep runs just outside it. */
export const HERO_LOGO_PX = 96;
export const RING_RADIUS = 54;

export type CardSlot = { x: number; y: number; fromLeft: boolean };

export type StageLayout = {
  narrow: boolean;
  width: number;
  height: number;
  /** Star / finale-logo centre. */
  cx: number;
  cy: number;
  /** Proto-star core radius. */
  coreR: number;
  ringRadius: number;
  headlineTop: number;
  cardWidth: number;
  /**
   * Desktop: absolute centre of card `i` of `n`, flanking the star in two
   * columns. Narrow layouts render a stacked in-flow list instead and use
   * these only as canvas anchors.
   */
  cardSlot: (i: number, n: number) => CardSlot;
};

function clamp(min: number, v: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function stageLayout(width: number, height: number): StageLayout {
  const narrow = width < NARROW_BREAKPOINT;
  const cx = width / 2;
  // Narrow screens push the star up and tighten every gap: the stacked perk
  // list below the headline must still clear the bottom-pinned button on a
  // 667px-tall phone.
  const cy = height * (narrow ? 0.28 : 0.4);
  const coreR = narrow
    ? clamp(44, width * 0.16, 56)
    : clamp(56, Math.min(width * 0.1, height * 0.11), 92);
  const headlineTop = cy + coreR + (narrow ? 40 : 96);
  const cardWidth = Math.min(300, width * 0.3);
  const columnX = Math.min(width * 0.34, 380);

  const cardSlot = (i: number, n: number): CardSlot => {
    const fromLeft = i % 2 === 0;
    if (narrow) {
      // Anchors only — narrow cards render as an in-flow stacked list.
      return { x: cx, y: headlineTop + 44 + i * 40, fromLeft };
    }
    const rows = Math.ceil(n / 2);
    const row = Math.floor(i / 2);
    // 72px rows: a perk that wraps to two lines still clears its neighbours.
    return {
      x: cx + (fromLeft ? -columnX : columnX),
      y: cy + (row - (rows - 1) / 2) * 72,
      fromLeft,
    };
  };

  return {
    narrow,
    width,
    height,
    cx,
    cy,
    coreR,
    ringRadius: RING_RADIUS,
    headlineTop,
    cardWidth,
    cardSlot,
  };
}

/**
 * Desktop card flight: a curved orbital approach, not a straight tween.
 * Three points sampled along an ellipse around the star — the DOM animates
 * its transform through them as keyframes, the canvas ghosts the same curve
 * as a guide arc. One definition, or the ghost visibly misses the card.
 */
export type CardFlight = {
  sx: number;
  sy: number;
  mx: number;
  my: number;
  ex: number;
  ey: number;
};

export function cardFlight(layout: StageLayout, i: number, n: number): CardFlight {
  const slot = layout.cardSlot(i, n);
  const dx = slot.x - layout.cx;
  const dy = slot.y - layout.cy;
  const targetAngle = Math.atan2(dy, dx);
  const dist = Math.hypot(dx, dy);
  // Left-column cards sweep in clockwise, right-column counter-clockwise, so
  // both sides read as matter falling into orbit rather than crossing it.
  const dir = slot.fromLeft ? 1 : -1;
  const point = (angle: number, d: number) => ({
    x: layout.cx + Math.cos(angle) * d,
    y: layout.cy + Math.sin(angle) * d,
  });
  const s = point(targetAngle + dir * 0.9, dist * 1.5);
  const m = point(targetAngle + dir * 0.45, dist * 1.18);
  return { sx: s.x, sy: s.y, mx: m.x, my: m.y, ex: slot.x, ey: slot.y };
}
