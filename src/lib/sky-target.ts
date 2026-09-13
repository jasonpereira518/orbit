/**
 * Is the thing under the cursor sky, or is it the page?
 *
 * The starfield's constellation search only starts over background. The gravity
 * well works everywhere — it is the sky reacting to a cursor, and it reads fine
 * under text — but a named figure drawn across the signup card or an FAQ row is
 * not a figure found in the sky. It is a gold diagram laid over the copy, with
 * the name landing in the middle of somebody's paragraph.
 *
 * WHAT COUNTS AS CONTENT is a list of things that put ink on the screen. What is
 * deliberately NOT on it is the layout: html, body, div, section, main, header,
 * footer, nav, ul, ol, form. Those are boxes, and the blank space inside them —
 * the gap between two sections, the margin beside the column, the air above a
 * heading — is sky, which is most of where a cursor comes to rest on a marketing
 * page. Gating on the column instead of on the ink would switch the feature off
 * across the whole middle of the page.
 *
 * `.landing-glass` makes every glass surface opaque as a whole, blank margins
 * included: the join card and the FAQ cards are elements, not sky with text on
 * it. `[data-sky-content]` is the same opt-in for anything that is not glass.
 * `OrbitRingsBackdrop` is an <svg> behind the hero but `pointer-events-none`, so
 * it is never the element under the cursor.
 *
 * The argument is the narrowest DOM shape this needs rather than `Element`,
 * which is what lets the smoke run it over a linkedom document with no browser.
 * No React, no `next/*`, no canvas: safe to load from anywhere.
 */
export const SKY_CONTENT_SELECTOR =
  "a, button, input, textarea, select, label, h1, h2, h3, h4, h5, h6, p, li, " +
  "img, svg, picture, video, canvas, details, summary, pre, code, table, " +
  ".landing-glass, [data-sky-content]";

/** The one DOM capability this needs; `Element` satisfies it structurally. */
export type SkyHitTarget = { closest(selector: string): unknown };

/**
 * True when `target` is background: itself and every ancestor is layout.
 *
 * Conservative at both ends. Nothing (no target, or something that is not an
 * element — `window`, `document`, a detached node) is NOT sky: when it cannot be
 * established that the cursor is over background, the sky stays quiet.
 */
export function isSkyTarget(target: SkyHitTarget | null | undefined): boolean {
  if (!target || typeof target.closest !== "function") return false;
  return target.closest(SKY_CONTENT_SELECTOR) === null;
}
