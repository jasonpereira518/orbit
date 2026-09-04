/**
 * Shared geometry for the app's floating glass windows — the notifications panel and the
 * feedback panel.
 *
 * These numbers mirror the `data-[side=floating]` utilities in `src/components/ui/sheet.tsx`
 * (`inset-y-4 right-4`, `w-[calc(100%-2rem)]`, `sm:max-w-sm`). They are duplicated rather
 * than measured because the panel is portalled and positioned by CSS, so its box does not
 * exist at the moment a trigger is pressed — and the transform-origin has to be right on
 * the very first painted frame or the window visibly jumps as it opens. Keep them in step
 * with sheet.tsx.
 *
 * This lived in `notifications-panel.tsx` and was then copied into `feedback-widget.tsx`,
 * each with its own comment warning to keep the two in step. One copy is the point of this
 * module.
 *
 * NO IMPORTS, deliberately. This is reached from client components, and anything that
 * transitively reaches `@/db` fails the build with a `node:fs` chunking error naming
 * neither file — the same discipline `src/lib/feedback-report.ts` documents.
 */

export const PANEL_INSET_PX = 16;
export const PANEL_MAX_W_PX = 384; // sm:max-w-sm = 24rem

/**
 * Where `sm:max-w-sm` starts applying. Below it the window is `w-[calc(100%-2rem)]` and
 * uncapped, so capping the width here regardless — which this did until the feedback panel
 * gained a mobile trigger and made it visible — puts the origin up to 223px off at a 639px
 * viewport, and the window flies in from beside itself.
 */
const SM_BREAKPOINT_PX = 640;

/**
 * Used when there is no trigger on screen to grow out of: the Settings and "More" doors,
 * or a trigger that is CSS-hidden at this breakpoint.
 */
export const PANEL_ORIGIN_FALLBACK = "top right";

export type TriggerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The trigger's midpoint, expressed in the PANEL's own coordinate space.
 *
 * The panel is anchored to the right edge and inset, so a viewport coordinate means
 * nothing to it — subtracting the panel's own left and top edges is what turns "where the
 * button is on screen" into "where inside me to scale from". A trigger above the panel's
 * top inset yields a negative y, which is correct: it scales out of a point above itself.
 *
 * Pure, and takes the viewport width explicitly, so the arithmetic is checkable without a
 * DOM — see `scripts/smoke-feedback-image.ts`.
 */
export function panelOriginFor(rect: TriggerRect, viewportWidth: number): string {
  const flush = viewportWidth - PANEL_INSET_PX * 2;
  const panelWidth =
    viewportWidth >= SM_BREAKPOINT_PX ? Math.min(flush, PANEL_MAX_W_PX) : flush;
  const panelLeft = viewportWidth - PANEL_INSET_PX - panelWidth;
  return `${Math.round(rect.left + rect.width / 2 - panelLeft)}px ${Math.round(
    rect.top + rect.height / 2 - PANEL_INSET_PX
  )}px`;
}

/**
 * Where the window should appear to grow from: the middle of the control that was pressed.
 *
 * A zero-width rect means the trigger is hidden by CSS at this breakpoint — the
 * notifications bell is mounted twice and only one instance is ever visible — so fall
 * through to the corner rather than anchoring to a collapsed box at the origin.
 */
export function originFromTrigger(trigger: HTMLElement | null): string {
  if (!trigger) return PANEL_ORIGIN_FALLBACK;
  const rect = trigger.getBoundingClientRect();
  if (rect.width === 0) return PANEL_ORIGIN_FALLBACK;
  return panelOriginFor(rect, window.innerWidth);
}
