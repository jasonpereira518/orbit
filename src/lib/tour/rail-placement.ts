/**
 * Where the desktop coach rail may sit without hiding the control it is talking about.
 *
 * The card floats (a rail that pushed content would break every viewport-based breakpoint
 * between 768 and 1279px), so it can only dodge. It tries bottom-left (beside the sidebar,
 * the one uncontested corner) and bottom-right, takes the side that overlaps the anchor
 * least, and if even that side would sit on the anchor's centre — the point a person, and
 * Playwright, actually click — it reports so and the rail collapses to a one-line pill.
 */
export type Box = { left: number; top: number; width: number; height: number };

export type RailPlacement = {
  /** Bottom-right instead of bottom-left. */
  flipped: boolean;
  /** The chosen spot still covers the anchor's centre: collapse. */
  coversCenter: boolean;
};

export const RAIL_CARD_WIDTH = 320;
export const RAIL_CARD_HEIGHT = 340;
export const RAIL_EDGE = 20;

function overlapArea(a: Box, b: Box) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(box: Box, x: number, y: number) {
  return x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
}

export function placeRail(
  anchor: Box | null,
  viewport: { width: number; height: number },
  /** The x the left placement starts at: the sidebar's right edge plus the gutter. */
  leftStart: number,
  /** The EXPANDED card's measured size; the constants are only the pre-measure guess. */
  card: { width: number; height: number } = { width: RAIL_CARD_WIDTH, height: RAIL_CARD_HEIGHT },
): RailPlacement {
  if (!anchor) return { flipped: false, coversCenter: false };
  const top = viewport.height - RAIL_EDGE - card.height;
  const leftBox: Box = { left: leftStart, top, width: card.width, height: card.height };
  const rightBox: Box = {
    left: viewport.width - RAIL_EDGE - card.width,
    top,
    width: card.width,
    height: card.height,
  };
  const leftOverlap = overlapArea(leftBox, anchor);
  const rightOverlap = overlapArea(rightBox, anchor);
  const flipped = rightOverlap < leftOverlap;
  const chosen = flipped ? rightBox : leftBox;
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  return { flipped, coversCenter: contains(chosen, cx, cy) };
}
