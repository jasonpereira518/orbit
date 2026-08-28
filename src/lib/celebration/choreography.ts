/**
 * Timing for the plan-purchase celebration — "a new star ignites".
 *
 * Same contract as `src/lib/warp/choreography.ts`: every beat is a named
 * constant here, and the stage and canvas derive their frames from elapsed
 * time against these numbers rather than from React state.
 *
 * The arc: matter gathers into an accretion disc, the disc collapses into a
 * held breath of silence, the star ignites (the slam), the spoils cascade in
 * on orbital arcs, and the star finally contracts into the Orbit mark while
 * its plan ring lights. Rest is open-ended; dismissal is the only exit.
 */

/** Veil: the stage fades up from the app beneath it. */
export const ENTER_FADE_MS = 300;

/** Accretion: tinted deep space, matter spiralling into the proto-star. */
export const ACCRETE: readonly [number, number] = [0, 2600];

/**
 * Collapse: the disc implodes, the kicker is consumed by the core, and the
 * audio cuts to dead silence. The held breath is what makes the slam land.
 */
export const COLLAPSE: readonly [number, number] = [2600, 2900];

/** Ignition: flash, shockwaves, ejecta, shake — the slam. */
export const IGNITE = 2900;

/** Whole-stage shake from the ignition; skip stays locked until it decays. */
export const SHAKE_MS = 380;

/** The headline slams in just after the flash peak, revealed by it. */
export const HEADLINE_AT = 2960;

/** The held beat ends here; the first perk card launches. */
export const CASCADE_START = 3650;

/** Per-card launch spacing — each perk lands as its own moment. */
export const CARD_STAGGER_MS = 240;

/** One card's flight from launch to seated. */
export const CARD_FLIGHT_MS = 550;

export function cardAt(i: number) {
  return CASCADE_START + i * CARD_STAGGER_MS;
}

export function cascadeEnd(perkCount: number) {
  return cardAt(Math.max(0, perkCount - 1)) + CARD_FLIGHT_MS;
}

/** Breather between the last card seating and the star contracting. */
export const FINALE_GAP = 200;

/** The star begins becoming the mark. */
export function finaleAt(perkCount: number) {
  return cascadeEnd(perkCount) + FINALE_GAP;
}

/** The ring-ignition sweep around the mark, starting at `finaleAt`. */
export const RING_SWEEP_MS = 650;

/** The DOM logo fades in over the contracted star. */
export function logoAt(perkCount: number) {
  return finaleAt(perkCount) + 150;
}

/** Welcome line, once the ring is most of the way around. */
export function welcomeAt(perkCount: number) {
  return finaleAt(perkCount) + 400;
}

/** Resting state: ambient drift, breathing halo, dismiss button. */
export function restAt(perkCount: number) {
  return finaleAt(perkCount) + RING_SWEEP_MS + 250;
}

/**
 * Clicks and Escape are swallowed before this. The buildup and the slam are
 * the whole payoff; once the name has landed, the viewer owns the pace.
 */
export const SKIPPABLE_FROM = IGNITE + SHAKE_MS;

/** Reduced motion collapses the whole arc to a plain fade, warp parity. */
export const REDUCED_MS = 200;

/** Dismissal fade, stage to gone. */
export const EXIT_MS = 320;

/**
 * The locally-remembered plan the watcher compares against. Deliberately not
 * user-scoped: on account switch the first mount silently rewrites it (as a
 * "downgrade" or "first visit"), so a stale higher tier can only ever cost a
 * missed celebration, never a false one.
 */
export const LAST_SEEN_PLAN_KEY = "orbit:last-seen-plan";

/**
 * The React-visible beats. "Collapse" is time-derived inside "accrete" by the
 * canvas; the DOM only cares about these five.
 */
export type CelebrationPhase = "accrete" | "ignite" | "cascade" | "finale" | "rest";
