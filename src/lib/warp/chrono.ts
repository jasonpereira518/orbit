/**
 * The chrono journey: Settings -> /upgrade, told as a long exposure.
 * Beat tables and the pure per-frame math. See the design spec for why each
 * window is where it is.
 */

/**
 * When the stage covers the frame and the route swap becomes invisible.
 *
 * This one constant is load-bearing at THREE separate sync points, not one —
 * retuning it means checking all three:
 *   1. `CHRONO_OUT.shutter[1]` is defined in terms of it below, so the
 *      departure cover always finishes exactly here. If it didn't, the route
 *      swap would happen while the stage is still translucent: a white flash.
 *   2. `coverage()` in chrono-stage.tsx uses it as the start of the arriving
 *      window's hold-then-handoff ramp — the opacity stays pinned to fully
 *      covered until the collapse below has had time to finish.
 *   3. `chronoFrame`'s `"arriving"` branch uses it as the collapse's own
 *      duration, so the spin-down and shutter-close motion is guaranteed to
 *      finish before `coverage()` starts revealing the real page underneath.
 * Point 1 is now structural (a derived value can't drift). Points 2 and 3 are
 * still trusting call sites to import the constant rather than a literal —
 * grep for `CHRONO_OPAQUE_MS` after touching either file.
 */
export const CHRONO_OPAQUE_MS = 560;
/** End of the deterministic outbound run, before any cruise hold. */
export const CHRONO_OUTBOUND_MS = 1950;
/** Deceleration: arcs collapse back into stars. The payoff shot. */
export const CHRONO_ARRIVING_MS = 860;
/** The rewind home, start to settled. */
export const CHRONO_INBOUND_MS = 1650;

import {
  CRUISE_CAP_MS,
  easeHouse,
  easeIn,
  lerp,
  span,
} from "@/lib/warp/choreography";

/** Outbound beats, ms from launch. */
export const CHRONO_OUT = {
  /** The room goes dark and the stage covers the frame. Derived from
   *  CHRONO_OPAQUE_MS rather than a duplicated literal — see the comment
   *  there for why the two must never diverge. */
  shutter: [0, CHRONO_OPAQUE_MS],
  /** Time accelerates: the spin ramps up and the shutter opens. */
  spin: [420, 1700],
  /** The orbit grows. */
  growth: [560, 1850],
} as const;

/** Inbound beats, ms from the moment Back is pressed. */
export const CHRONO_IN = {
  /** The panels rise off the page. Short, and its own beat: flying straight
   *  sideways from rest reads as a slide, whereas a rise first reads as
   *  something releasing before it goes.
   *
   *  This is the window for the whole STAGGERED SET, not for one panel: every
   *  slot's rise is offset by the same amount its flight is, so the first slot
   *  to leave rises 0-220ms and the last 120-340ms. One panel's rise is the
   *  window minus that spread — `liftScheduleForSlot` does the arithmetic. A
   *  window declared as one panel's 220ms would close 120ms before the set has
   *  actually finished rising: a beat table that stops short of the beat. */
  lift: [0, 340],
  /** The panels fly horizontally clean out of the frame, each to whichever
   *  side of the centre line it is already nearer. Overlaps the lift on
   *  purpose — the rise is still finishing as the flight begins, so the two
   *  read as one gesture and not as two moves in sequence. */
  part: [170, 890],
  /** The canvas fades up behind them, once they are all but gone. Late by
   *  design: a stage that is opaque from frame one hides the exit entirely,
   *  and the exit is the shot. */
  cover: [690, 1000],
  /** Late, unlike the rocket's frame-one push: the page leaving is the shot,
   *  so the swap waits until the cover above has finished. */
  push: 1000,
  /** Time runs backwards. */
  rewind: [430, 1220],
  /** Stars go out in bursts; the growth un-happens. */
  extinguish: [500, 1290],
  /** Arcs collapse back to points. */
  collapse: [1220, 1460],
  /** The room lights come back up. */
  landing: [1430, 1650],
} as const;

/**
 * When the stage covers the frame on the way home, ms from Back.
 *
 * Two failures bracket this window, one on each side.
 *
 * Too early and the cover veils the exit: the panels now fly OUTWARD across
 * the full width of the frame, so a stage that is already opaque — or even
 * halfway up — while they are still crossing it hides the one thing the late
 * `push` exists to buy time for. Hence a start well after `part` begins.
 *
 * Too late and the route swap shows through a translucent canvas as a flash of
 * the settings page. Hence an end clamped to `push`: derived rather than
 * written twice, so retuning either beat cannot open a gap between them.
 */
export const CHRONO_IN_COVER = [
  CHRONO_IN.cover[0],
  Math.min(CHRONO_IN.cover[1], CHRONO_IN.push),
] as const;

/**
 * The page resolving out of the exposure, in ms.
 *
 * These are panel timings, and they live here rather than in
 * `upgrade-transition.tsx` because they have to interlock with the reveal —
 * the window where `coverage()` lifts the stage off the page, which runs from
 * CHRONO_OPAQUE_MS to CHRONO_ARRIVING_MS after deceleration begins. The whole
 * point of this arrival is that the sharpening happens INSIDE that window: a
 * page that finishes resolving before the veil lifts is "sky cleared, then
 * page faded in", which is the thing this journey exists not to be. That
 * invariant is only checkable if both halves are in one table, so they are.
 */
export const CHRONO_RESOLVE = {
  /** After deceleration begins, when the FIRST panel starts sharpening.
   *  Deliberately a little before the reveal opens, so it is already mid-blur
   *  when the veil lifts instead of starting from scratch in clear sky. */
  lead: CHRONO_OPAQUE_MS - 100,
  /** Between panels. Shorter than the assembly's: these are condensing out of
   *  one exposure, not being placed one at a time. */
  stagger: 45,
  /** One panel, smeared to sharp. */
  duration: 260,
} as const;

/**
 * The celestial pole, as viewport fractions. On-screen and high to one side:
 * the concentric sweep around a visible pole is the image people decode as
 * "hours passed". The innermost radii are thinned by the stage so this never
 * becomes a bullseye competing with the arriving page.
 */
export const POLE = { x: 0.22, y: 0.16 } as const;

/**
 * The shutter. How much of the trail layer each frame erases: 1 leaves no
 * trail at all, low values leave long arcs. Trail length is entirely this
 * number, which is why acceleration and deceleration cost one lerp each.
 */
export const ALPHA_STILL = 0.55;
export const ALPHA_FAST = 0.045;

/** Peak angular velocity, radians per second. */
export const OMEGA_PEAK = 1.9;

/**
 * Where the seven ignition bursts land inside the growth window, as fractions.
 * Deliberately uneven — an even cadence reads as a progress bar rather than as
 * a network gaining people. Pinned by the smoke script.
 */
export const IGNITION_FRACTIONS = [0, 0.13, 0.31, 0.4, 0.62, 0.79, 1] as const;

/** During a cruise hold, one further burst every this many ms, so a slow route
 *  still reads as growth instead of as a loop. */
export const CRUISE_BURST_MS = 420;

/**
 * How many further bursts a hold can fire before the reserve runs out.
 *
 * A counter that keeps incrementing past the last star that can answer it is
 * not growth, it is arithmetic: the stage seeds exactly this many reserve
 * burst levels, and `chronoFrame` must not promise more than that.
 *
 * Derived from the longest hold that can actually happen — `CRUISE_CAP_MS` is
 * measured from launch, so the hold itself cannot outlast
 * CRUISE_CAP_MS - CHRONO_OUTBOUND_MS. Floor rather than ceiling on purpose: a
 * level beyond that is one no hold can ever reach, and the stars seeded into
 * it would sit in the field forever without lighting. A hold that overshoots
 * (a main thread too busy to run the cap's timer on time) is absorbed by the
 * clamp in `cruiseBurstsBy` instead.
 */
export const CRUISE_BURSTS = Math.floor(
  (CRUISE_CAP_MS - CHRONO_OUTBOUND_MS) / CRUISE_BURST_MS,
);

/**
 * How much extra field the stage holds back for those bursts, as a fraction of
 * the base star count.
 *
 * The seven scripted bursts spend ~12% of the field each; at that rate a
 * full-length hold would roughly double the sky and overfill the frame right
 * where the payment form is about to land. A fifth of the field spread across
 * the whole reserve is a steady trickle — visible new stars every 420ms —
 * that still leaves the arrival composition recognisably the one that was
 * designed. Reserve stars are drawn from the whole radius range rather than
 * continuing the outward march: they are the sky filling in during a wait,
 * not part of the seven-burst spread.
 */
export const CRUISE_RESERVE_FRACTION = 0.2;

/**
 * Which ignition burst lights a star at this radius rank — 0 nearest the pole,
 * 1 farthest. Growth spreads OUTWARD: a few spots near the pole, then the sky
 * filling out to the frame edges, rather than stars pricking on at random all
 * over at once.
 */
export function burstForRadiusRank(rank: number) {
  const i = Math.floor(rank * IGNITION_FRACTIONS.length);
  return Math.min(IGNITION_FRACTIONS.length - 1, Math.max(0, i));
}

export type ChronoPhase = "outbound" | "cruise" | "arriving" | "inbound";

export type ChronoFrame = {
  /** Radians per second. Negative on the way home. */
  omega: number;
  /** The shutter; see ALPHA_STILL. */
  alpha: number;
  /** How many ignition bursts have fired. */
  bursts: number;
  /** Fraction of the grown field still lit. 1 outbound, falling to 0 on the
   *  way home as the growth un-happens. */
  alive: number;
};

/**
 * How many bursts a hold of `elapsed` total run time has added on top of the
 * scripted seven. Clamped to the reserve the stage actually seeded.
 */
function cruiseBurstsBy(elapsed: number, maxBursts = CRUISE_BURSTS) {
  const held = Math.max(0, elapsed - CHRONO_OUTBOUND_MS);
  return Math.min(maxBursts, Math.floor(held / CRUISE_BURST_MS));
}

function burstsBy(elapsed: number) {
  const [from, to] = CHRONO_OUT.growth;
  let n = 0;
  for (const f of IGNITION_FRACTIONS) {
    if (elapsed >= lerp(from, to, f)) n += 1;
  }
  return n;
}

/**
 * Every beat as a pure function of elapsed time.
 *
 * `elapsed` is ms since the run began; `sinceArriving` is ms since
 * deceleration started, and is only read in the "arriving" phase. Nothing here
 * touches the DOM, which is what makes the whole arc testable.
 */
export function chronoFrame(
  phase: ChronoPhase,
  elapsed: number,
  sinceArriving: number,
  /**
   * Ceiling on reserve bursts, for consumers that hold longer than a route transition.
   *
   * `CRUISE_BURSTS` is derived from `CRUISE_CAP_MS`, the 4s ceiling the warp provider enforces
   * on a journey. The constellation intro has no such ceiling — a cold chunk on a bad
   * connection legitimately runs longer — and past the reserve the sky stops growing, which is
   * the loop the reserve exists to prevent. Defaulted, so `/upgrade` is untouched; the default
   * is asserted in `scripts/smoke-warp-chrono.ts`.
   */
  maxCruiseBursts: number = CRUISE_BURSTS
): ChronoFrame {
  if (phase === "arriving") {
    // Collapse fills the first 560ms of the arriving window (the shutter
    // length — CHRONO_OPAQUE_MS); the rest is the cross-fade into the real
    // starfield.
    const p = easeHouse(span(sinceArriving, [0, CHRONO_OPAQUE_MS]));
    return {
      omega: OMEGA_PEAK * (1 - p),
      alpha: lerp(ALPHA_FAST, 1, p),
      // Frozen at whatever the hold had reached: `elapsed - sinceArriving` is
      // the elapsed time at the instant deceleration began. Reporting a bare
      // seven here would snuff out every star a cruise hold had just lit, at
      // exactly the moment the sky is being handed to the page.
      bursts:
        IGNITION_FRACTIONS.length +
        cruiseBurstsBy(elapsed - sinceArriving, maxCruiseBursts),
      alive: 1,
    };
  }

  if (phase === "inbound") {
    const rise = easeIn(span(elapsed, CHRONO_IN.rewind));
    const fall = easeHouse(span(elapsed, CHRONO_IN.collapse));
    const opened = lerp(ALPHA_STILL, ALPHA_FAST, rise);
    return {
      // Negative: time runs the other way. `fall` brings it back to rest.
      omega: -OMEGA_PEAK * rise * (1 - fall),
      alpha: lerp(opened, 1, fall),
      bursts: IGNITION_FRACTIONS.length,
      alive: 1 - span(elapsed, CHRONO_IN.extinguish),
    };
  }

  if (phase === "cruise") {
    return {
      omega: OMEGA_PEAK,
      alpha: ALPHA_FAST,
      bursts: IGNITION_FRACTIONS.length + cruiseBurstsBy(elapsed, maxCruiseBursts),
      alive: 1,
    };
  }

  // Outbound. Accelerating, so the spin eases IN — it reads as time running
  // away rather than as a dial being turned.
  const t = easeIn(span(elapsed, CHRONO_OUT.spin));
  return {
    omega: OMEGA_PEAK * t,
    alpha: lerp(ALPHA_STILL, ALPHA_FAST, t),
    bursts: burstsBy(elapsed),
    alive: 1,
  };
}

/**
 * How near a panel's own centre has to be to the frame's centre before it
 * counts as having no side to leave by, in px.
 *
 * Two pixels rather than zero because a full-width section is centred by
 * layout, not by arithmetic: sub-pixel rounding, a scrollbar-driven odd
 * viewport width, a container with an odd margin, all put its centre a
 * fraction off the line. Wide enough to catch every one of those, narrow
 * enough that nothing genuinely to one side is ever swallowed — the two plan
 * cards sit hundreds of pixels out.
 */
export const PART_CENTRED_EPSILON = 2;

/**
 * Which way the panel in assembly slot `order` flies on the way home: -1 for
 * the left edge of the frame, +1 for the right.
 *
 * Measured, not assumed. "Away from the centre of the screen" is only
 * literally true if it is answered against the layout that actually happened,
 * and the whole point of the beat is that the two plan cards part like
 * curtains — Pro to the left, Lifetime to the right — because that is where
 * they already are.
 *
 * A panel whose centre IS the frame's centre has no nearer side. /upgrade
 * currently has three such panels that actually fly: the header (order 0),
 * the billing toggle (order 2) and the trust row (order 5) — the heading
 * (order 1) used to be a fourth, but it now exits with `exit="fade"` and
 * dissolves in place instead of reaching this fallback at all. Those three
 * fall back to a split derived from the slot, which is arbitrary but
 * deterministic and, crucially, not all the same way — full-width bands
 * sliding off in convoy would read as one sheet being pulled, which is the
 * opposite of parting.
 *
 * The formula itself is not a principled derivation — it is one arbitrary
 * assignment that happens to alternate for the flying set as it stands today,
 * `{0, 2, 5}`: `floor(0/2)=0` (even) -> -1, `floor(2/2)=1` (odd) -> +1,
 * `floor(5/2)=2` (even) -> -1, giving -1, +1, -1. A plain `order % 2` would
 * not: it gives -1, -1, +1 for that same set, sending the header and the
 * toggle off the same side back to back — exactly the convoy this fallback
 * exists to avoid. Nobody chose `floor(order / 2) % 2` for any reason beyond
 * that it alternates against the current set; if the set of full-width flying
 * slots ever changes — a panel's `exit` prop changes, or a new full-width
 * slot is added — re-verify alternation by hand rather than assuming this
 * formula still works. It is not a general solution.
 */
export function partDirection(
  panelCentreX: number,
  viewportCentreX: number,
  order: number,
): -1 | 1 {
  const offset = panelCentreX - viewportCentreX;
  if (Math.abs(offset) <= PART_CENTRED_EPSILON)
    return Math.floor(order / 2) % 2 === 0 ? -1 : 1;
  return offset < 0 ? -1 : 1;
}

/**
 * How far a parting panel travels, in px.
 *
 * One full viewport width, which clears the frame whatever the panel's own
 * width is: a panel that starts inside the viewport has its far edge no more
 * than one viewport width from its near edge, so translating by that width
 * always puts the whole box past the edge it is heading for. A distance tuned
 * to the panel's own width instead would leave the widest sections — the
 * full-bleed header, at exactly one viewport width — clipping at the boundary.
 */
export function partDistance(viewportWidth: number) {
  return Math.max(0, viewportWidth);
}

/**
 * How long one panel's flight off the frame lasts, in ms.
 *
 * A fixed duration with the stagger derived from what the `part` window has
 * left over, rather than a fixed stagger with the window free to overrun.
 * The first shape of this exit borrowed the assembly's 50ms exit stagger,
 * which was tuned for a different move entirely — pieces lifting a few pixels
 * in place, where the total run IS the beat and nothing downstream depends on
 * when it ends. This window has a hard end: the cover starts rising at 690ms
 * and is opaque at 1000ms. At the beats as they stand a 50ms stagger would put
 * the last slot's flight at 420-1020ms — still crossing the frame 20ms after
 * the cover has sealed over it — so the top sections would never visually
 * complete and the beat table would claim a window the code did not honour. A
 * beat table that does not describe the motion is worse than no beat table.
 */
export const PART_FLIGHT_MS = 600;

/**
 * How much later the last panel leaves than the first, in ms.
 *
 * Everything the `part` window has left over once one flight is accounted for.
 * Both exit beats share it, which is what keeps a slot's rise and its flight
 * in step: they start at the same offset into their own windows.
 */
export const PART_SPREAD_MS = Math.max(
  0,
  CHRONO_IN.part[1] - CHRONO_IN.part[0] - PART_FLIGHT_MS,
);

/** The offset into either exit window at which slot `order` begins, in ms.
 *  Reverse order: the last panel to arrive is the first to leave. */
function exitOffsetForSlot(order: number, maxOrder: number) {
  const stagger = maxOrder > 0 ? PART_SPREAD_MS / maxOrder : 0;
  return (maxOrder - order) * stagger;
}

/**
 * When the panel in assembly slot `order` starts its flight off the frame, and
 * how long that flight lasts, in ms from the start of the return arc.
 *
 * Reverse order, as the assembly's exit already does: the last panel to arrive
 * is the first to leave. The spread is whatever `part` has left after the
 * flight itself — 120ms across six slots on /upgrade, so 24ms apart. Near
 * simultaneous, and deliberately so: two plan cards parting like curtains part
 * together, and a cascade would turn a single gesture into a queue.
 */
export function partScheduleForSlot(order: number, maxOrder: number) {
  return {
    startMs: CHRONO_IN.part[0] + exitOffsetForSlot(order, maxOrder),
    durationMs: PART_FLIGHT_MS,
  };
}

/**
 * When the panel in assembly slot `order` starts its rise, and how long that
 * rise lasts, in ms from the start of the return arc.
 *
 * Same offset as its flight, so the two beats stay in step for every slot and
 * the rise is always still finishing as the flight begins. The duration is the
 * declared `lift` window minus the spread the stagger costs — never negative,
 * for the same reason `PART_SPREAD_MS` is floored.
 */
export function liftScheduleForSlot(order: number, maxOrder: number) {
  const [from, to] = CHRONO_IN.lift;
  return {
    startMs: from + exitOffsetForSlot(order, maxOrder),
    durationMs: Math.max(0, to - from - PART_SPREAD_MS),
  };
}

/**
 * The direction a panel in assembly slot `order` was smeared by the exposure:
 * the unit tangent of the arc it sits on, i.e. perpendicular to its radius
 * from the pole.
 *
 * Derived from the slot rather than measured from the DOM. Panels stack down
 * the page from a pole that is up and to the left, so the radius angle sweeps
 * predictably; a layout read per panel would buy an accuracy nobody can see
 * and would have to happen before first paint to avoid a flash.
 *
 * ARRIVAL only. The way home no longer smears — panels lift and fly out of the
 * frame instead — so nothing on the exit path reads this. See `partDirection`.
 */
export function tangentForSlot(order: number, maxOrder: number) {
  const t = maxOrder > 0 ? order / maxOrder : 0;
  // Radius angle from the pole to the panel, sweeping as slots descend.
  const radius = lerp(-0.35, 0.96, t);
  const tangent = radius + Math.PI / 2;
  return { x: Math.cos(tangent), y: Math.sin(tangent) };
}
