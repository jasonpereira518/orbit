/**
 * The one geometry both celebration renderers share. The canvas draws the
 * star and the ring sweep from these numbers; the DOM seats the headline
 * column and the finale mark on the same ones. Both call
 * `stageLayout(window.innerWidth, window.innerHeight)` — the function is
 * pure, so agreement is guaranteed. A few pixels of drift here reads as the
 * ring having slipped off the logo.
 */

export const NARROW_BREAKPOINT = 640;

/** `OrbitLogo size="hero"` is 96px; the ignition sweep runs just outside it. */
export const HERO_LOGO_PX = 96;
export const RING_RADIUS = 54;

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
  /**
   * Top of the in-flow column: headline, then the perk manifest, then the
   * welcome line. Everything below the star stacks from here rather than
   * being positioned individually — one flow means a wrapping perk can never
   * collide with the line under it.
   */
  headlineTop: number;
  /** Width cap for that column. */
  columnWidth: number;
};

function clamp(min: number, v: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function stageLayout(width: number, height: number): StageLayout {
  const narrow = width < NARROW_BREAKPOINT;
  const cx = width / 2;
  // The star sits high: everything under it — headline, six perks, welcome
  // line — has to clear the bottom-pinned button on a 700px-tall window.
  const cy = height * (narrow ? 0.26 : 0.32);
  const coreR = narrow
    ? clamp(40, width * 0.15, 54)
    : clamp(52, Math.min(width * 0.09, height * 0.1), 84);
  const headlineTop = cy + coreR + (narrow ? 36 : 68);
  const columnWidth = narrow ? width - 48 : Math.min(width * 0.8, 720);

  return {
    narrow,
    width,
    height,
    cx,
    cy,
    coreR,
    ringRadius: RING_RADIUS,
    headlineTop,
    columnWidth,
  };
}

/**
 * The app's own logo, as a flight target for the finale handoff.
 *
 * Both the sidebar (desktop) and the mobile header mark carry
 * `data-app-logo`; only one of them is ever laid out, so the visible one is
 * the one with a real box. Returns null when neither is — the caller then
 * dismisses with a plain fade rather than flying the mark into a corner.
 */
export function findAppLogoTarget(): { cx: number; cy: number; size: number } | null {
  const marks = document.querySelectorAll<HTMLElement>("[data-app-logo]");
  for (const mark of marks) {
    const rect = mark.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      size: rect.width,
    };
  }
  return null;
}
