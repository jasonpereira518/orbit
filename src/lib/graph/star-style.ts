/**
 * The single description of what a star looks like.
 *
 * Pure, and deliberately free of React and of any renderer. `graph-nodes.tsx` builds a
 * DOM star from this and `sky-canvas/` bakes a sprite from the same numbers, so the two
 * renderers draw the same star by construction rather than by two people keeping two
 * files in agreement.
 */
import type { GraphNodeData } from "@/lib/graph-layout";
import { mixWithWhite } from "@/lib/school-color";

/** Star diameter in layout px, from the 1–5 orbit score. */
export function starSize(score: number) {
  return 5 + score * 2.2;
}

/**
 * How far past the star's edge a click still lands.
 *
 * A star is 7–16px in *node* space, which at the default fit view (zoom ≈ 0.11 for a
 * 114-person network) is under two screen pixels — the person is visible and, in
 * practice, unclickable. The pad extends 8px past the star's edge in every direction,
 * which is exactly half of the 18px minimum star separation that
 * `scripts/smoke-graph-layout.ts` guarantees, so no two pads can ever overlap and a
 * click still resolves to the nearest star.
 */
export const STAR_HIT_PAD = 16;

/**
 * The line under a person's name: their role, or their company when we don't
 * know what they do. Never both — one quiet line keeps the sky readable.
 */
export function starSubtitle(data: GraphNodeData) {
  return (data.title || "").trim() || (data.company || "").trim() || null;
}

/**
 * Counteract the camera a little as it pulls back.
 *
 * A star is 7–16 layout px. At the default framing of a 24-person network that is
 * 1–3 screen px, so the map opens on what looks like an empty sky — the one view a
 * first-time visitor is guaranteed to see. Growing the disc as zoom falls keeps the
 * sky legible, and the cap (+STAR_HIT_PAD, half the 18px minimum star separation the
 * layout guarantees) means two stars can never grow into each other.
 */
export function zoomRelief(disc: number, zoom: number) {
  return Math.max(1, Math.min((disc + STAR_HIT_PAD) / disc, 1 / Math.max(zoom, 0.08)));
}

export type StarVisual = {
  isComet: boolean;
  isScatter: boolean;
  /** Faint until hovered/selected/spotlit — the scatter stars' resting state. */
  dimmedScatter: boolean;
  /** Diameter from the score alone, before any dim or spotlight adjustment. */
  size: number;
  /** The diameter actually drawn. */
  disc: number;
  glow: number;
  spotlightBoost: number;
  alphaScale: number;
  /** Outer wash — the colour the glow is tinted with. */
  fill: string;
  /** Inner colour, halfway out of the radial gradient. */
  core: string;
  subtitle: string | null;
};

/**
 * Every number needed to draw one star. Figure stars carry a pastel wash of their
 * cluster's brand colour; scatter stars stay white and quiet until emphasized. Glow is
 * deliberately soft — the sky should read as a chart, not a light show.
 */
export function starVisual(data: GraphNodeData, selected: boolean): StarVisual {
  const score = data.score || 2;
  const size = starSize(score);
  const isScatter = data.figureRole === "scatter";
  const spotlight = Boolean(data.spotlight);
  const dimmedScatter = isScatter && !selected && !spotlight;

  const tint = !isScatter ? data.clusterColor : undefined;
  const baseDisc = dimmedScatter ? Math.max(4, size * 0.6) : size;

  return {
    isComet: Boolean(data.comet),
    isScatter,
    dimmedScatter,
    size,
    disc: baseDisc * (spotlight ? 1.3 : 1),
    glow: Math.max(3, score * 2.2),
    spotlightBoost: spotlight ? 1.9 : 1,
    alphaScale: dimmedScatter ? 0.55 : 1,
    fill: tint ? mixWithWhite(tint, 0.35) : "#ffffff",
    core: tint ? mixWithWhite(tint, 0.85) : "#ffffff",
    subtitle: starSubtitle(data),
  };
}
