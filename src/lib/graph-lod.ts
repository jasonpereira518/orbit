/**
 * Level of detail for the constellation.
 *
 * The rule is "do not render what cannot be read". A star label is 11px of text, so at the
 * fit view of a large network — the camera sits near 0.06 on a 2,000-contact sky — it lands
 * on screen well under a pixel tall. Those labels were the single most expensive thing on
 * the page.
 *
 * Measured on a 2,024-contact network, five zoom steps in and five out, as total long-task
 * time for the gesture:
 *
 *   baseline                     13,752ms   worst task 1,483ms
 *   labels hidden                 8,594ms
 *   nebulae hidden               10,170ms
 *   both hidden                   4,569ms
 *   shipped (this LOD)            9,300ms   worst task   ~800ms
 *
 * Two things in that table are worth keeping. The labels and the nebulae are independent
 * costs that add up, and the labels are the larger half — which contradicts the measurement
 * taken on a 24-star sky when the nebulae were given `contain: paint`, where hiding them
 * accounted for essentially all of the cost. Both results were true of the network they
 * were measured on; neither generalises on its own.
 *
 * The nebulae are deliberately left alone. They are what the view is FOR when it is zoomed
 * out, so the 26% they cost is a thing the page buys rather than waste.
 */

/**
 * Camera scale below which star labels are not rendered.
 *
 * 0.35 puts the cut at roughly 3.9px of rendered text — comfortably unreadable, with enough
 * margin above it that nothing legible is ever dropped. Verified in a browser: at 0.24 none
 * of the 305 labels in view are displayed, and at 0.72 all 52 are.
 */
export const LABEL_LOD_ZOOM = 0.35;

export type LodBand = "far" | "near";

/**
 * Which band a camera scale falls in.
 *
 * Published as a `data-lod` attribute rather than another `--graph-*` custom property,
 * because CSS can use a custom property as a length but cannot branch a rule on its value.
 * Written only when the band changes, so a zoom costs one attribute write at the crossing
 * rather than one per step.
 */
export function lodBandFor(scale: number): LodBand {
  // A non-finite scale means the camera is mid-initialisation; treat it as far, which is
  // where every view starts and which renders strictly less.
  if (!Number.isFinite(scale)) return "far";
  return scale < LABEL_LOD_ZOOM ? "far" : "near";
}

/**
 * The class the CSS rule keys on.
 *
 * Exported so the rule and the element cannot be renamed apart: a mismatch here does not
 * break anything visibly, it just silently stops the optimisation and nobody notices until
 * someone measures again. `scripts/smoke-graph-lod.ts` holds the two together.
 */
export const STAR_LABEL_CLASS = "constellation-star-label";
