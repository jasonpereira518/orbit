/**
 * The chrono journey: Settings -> /upgrade, told as a long exposure.
 * Beat tables and the pure per-frame math. See the design spec for why each
 * window is where it is.
 */

/** When the stage covers the frame and the route swap becomes invisible. */
export const CHRONO_OPAQUE_MS = 380;
/** End of the deterministic outbound run, before any cruise hold. */
export const CHRONO_OUTBOUND_MS = 1450;
/** Deceleration: arcs collapse back into stars. The payoff shot. */
export const CHRONO_ARRIVING_MS = 620;
/** The rewind home, start to settled. */
export const CHRONO_INBOUND_MS = 1500;
