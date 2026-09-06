/**
 * The one-way channel from the interest-list form to the starfield.
 *
 * A DOM event rather than an import: the starfield is a `next/dynamic` chunk with
 * `ssr: false`, and the form must not pull that chunk into its own bundle just to say
 * "someone signed up". It also keeps the two decoupled — a page without an interactive
 * starfield dispatches into the void, harmlessly. Same shape as
 * `components/contacts/interaction-flight.ts`.
 *
 * No React, no `next/*` imports: this file is safe to load from anywhere.
 */
export const STARFIELD_PULSE_EVENT = "orbit:starfield-pulse";

/** Viewport CSS px — the starfield canvas is `position: fixed`, so
 * `getBoundingClientRect()` coordinates map onto it directly. */
export type StarfieldPulseDetail = { x: number; y: number };

/** Fire a burst in the starfield centred on a viewport point. No-op on the server. */
export function pulseStarfield(x: number, y: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StarfieldPulseDetail>(STARFIELD_PULSE_EVENT, {
      detail: { x, y },
    })
  );
}
