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

/** The held beat ends here; the first perk is written in. */
export const CASCADE_START = 3650;

/** Per-perk spacing — each one is written in as its own moment. */
export const PERK_STAGGER_MS = 240;

/** How long one perk takes to settle once its beat lands. */
export const PERK_SETTLE_MS = 550;

export function perkAt(i: number) {
  return CASCADE_START + i * PERK_STAGGER_MS;
}

export function cascadeEnd(perkCount: number) {
  return perkAt(Math.max(0, perkCount - 1)) + PERK_SETTLE_MS;
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

/** Dismissal fade, veil to gone. */
export const EXIT_MS = 320;

/**
 * The handoff: the mark flies from the middle of the stage to the app's own
 * logo and takes its place. Longer than the veil fade on purpose — the veil
 * is gone by ~320ms and the mark keeps travelling over the live app, which
 * is what makes it read as the same object arriving rather than as an
 * overlay closing.
 */
export const HANDOFF_MS = 760;

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
