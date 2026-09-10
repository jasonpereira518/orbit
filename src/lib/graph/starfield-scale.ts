/**
 * How big a star is on the constellation, in CSS px.
 *
 * Two different things draw stars over the same box — the graph's own background field
 * (`Starfield` in `network-graph.tsx`, DOM spans) and the warp intro (a canvas) — and one flies
 * over the other during the hand-off. Sizes that were picked separately drifted: the warp's
 * commonest star was finer than the ground's, so the field it was supposed to be travelling
 * through read as being in front of it.
 *
 * They live here rather than in either file because the warp stage must not import anything
 * from `network-graph.tsx`. That module IS the lazy chunk whose download the intro exists to
 * cover; reaching into it for a constant would pull the whole graph into the intro's bundle and
 * defeat the feature. This module is constants and nothing else, so both sides can hold it.
 */

/**
 * The background field's three sizes, as DIAMETERS — the width/height of a DOM span.
 *
 * Roughly three quarters of the field is `common`, a fifth `bright`, and a twentieth
 * `brightest`; the skew is what stops a flat field of identical dots.
 */
export const CONSTELLATION_STAR_PX = {
  common: 0.8,
  bright: 1.4,
  brightest: 2.2,
} as const;

/**
 * How much larger the warp's stars are than the ground they fly over.
 *
 * Slightly, and deliberately only slightly: the intro hands its canvas to the graph's own sky,
 * and the closer the two fields agree the less the hand-off reads as one image being swapped
 * for another. Big enough to sit in front, small enough that nothing changes size when the
 * warp lifts.
 */
export const WARP_STAR_SCALE = 1.35;

/**
 * The warp's star radii at the FAR PLANE, in CSS px.
 *
 * Radii, not diameters, because the canvas draws arcs and strokes; halved from the table above
 * so the two stay tied. Stars swell beyond `max` as they approach the camera — that is
 * perspective, and it is measured from here.
 */
export const WARP_STAR_MIN_R =
  (CONSTELLATION_STAR_PX.common / 2) * WARP_STAR_SCALE;
export const WARP_STAR_MAX_R =
  (CONSTELLATION_STAR_PX.brightest / 2) * WARP_STAR_SCALE;
