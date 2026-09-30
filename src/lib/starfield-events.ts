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

/**
 * A completed share of the waitlist link: a thread drawn from this viewport point up into
 * the sky, ending in a hollow star that waits for the friend. Interactive skies only.
 */
export const STARFIELD_THREAD_EVENT = "orbit:starfield-thread";
export type StarfieldThreadDetail = { x: number; y: number };

export function threadStarfield(x: number, y: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StarfieldThreadDetail>(STARFIELD_THREAD_EVENT, { detail: { x, y } })
  );
}

/** Friends joined: light the `count` oldest hollow thread stars. */
export const STARFIELD_LIGHT_EVENT = "orbit:starfield-light";
export type StarfieldLightDetail = { count: number };

export function lightThreadStars(count: number) {
  if (typeof window === "undefined" || count <= 0) return;
  window.dispatchEvent(
    new CustomEvent<StarfieldLightDetail>(STARFIELD_LIGHT_EVENT, { detail: { count } })
  );
}

/** The other direction: the interactive sky found and drew a named constellation. */
export const STARFIELD_FIGURE_EVENT = "orbit:starfield-figure";
export type StarfieldFigureDetail = { name: string };

export function announceStarfieldFigure(name: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StarfieldFigureDetail>(STARFIELD_FIGURE_EVENT, { detail: { name } })
  );
}
