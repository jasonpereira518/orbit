/**
 * Who paints what, in the one box the star chart and its intro share.
 *
 * The intro has to be ABOVE the loading panel it covers and BELOW the chart it hands over to,
 * and those two are the same slot at different times — the Suspense boundary swaps one for the
 * other. That is only expressible as a z-order, and a z-order written twice in two files is one
 * that drifts, so both ends are named here and the smoke asserts the inequality between them.
 *
 * The ground moves with it. The chart's stage used to paint its own, which is fine when it is
 * the only thing in the box and fatal once something is meant to show through it from behind —
 * an opaque background makes "behind the nodes" mean "invisible". So the wrapper owns the
 * ground, the stage goes transparent for as long as a run is in flight, and the colour is one
 * constant rather than the same literal in two places: if the two ever disagreed, the moment
 * the intro ends and the stage takes its background back would be a visible flash.
 */

/** The canvas box's ground. One value, painted by whichever element currently owns it. */
export const STAGE_GROUND = "bg-[#03050a]";

/**
 * The intro, above the loading panel (which is positioned but unlayered) and below the chart.
 *
 * Tailwind scans source for literal class strings, so these have to BE the strings rather than
 * be built from the numbers below — which is also why the numbers are stated separately for the
 * smoke to compare.
 */
export const STAGE_INTRO_LAYER = "z-10";
export const STAGE_CHART_LAYER = "z-20";

/**
 * The same two, as numbers, for the assertion.
 *
 * `z-20` on the chart does a second job worth knowing about: `position: relative` with
 * `z-index: auto` creates no stacking context, so before this the stage's own toolbars — at
 * `z-20` and `z-30` internally — competed directly with the intro's layer instead of being
 * carried by their parent. Giving the stage a real z-index scopes all of them to it.
 */
export const STAGE_INTRO_Z = 10;
export const STAGE_CHART_Z = 20;
