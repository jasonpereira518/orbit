/**
 * When the constellation gets a warp intro, and how long each beat runs.
 *
 * Same contract as `src/lib/warp/choreography.ts` and `src/lib/celebration/choreography.ts`:
 * every beat is a named constant here and the stage derives its frames from elapsed time
 * against these numbers, never from React state. Nothing in this file touches the DOM, which
 * is what makes the decision testable in the `pure` smoke tier.
 *
 * The rule the whole feature turns on: **this can only ever ADD an animation to a load that
 * was already slow. It must never add a frame to a fast one.** Everything below is arranged so
 * the fast path returns `false` from `predictSlowIntro` and nothing else runs at all — no
 * timer, no stage chunk fetched, no gate on the chart's own reveal.
 */
import {
  CHRONO_ARRIVING_MS,
  CHRONO_OPAQUE_MS,
  CHRONO_OUTBOUND_MS,
  CRUISE_BURST_MS,
  CRUISE_RESERVE_FRACTION,
  OMEGA_PEAK,
  chronoFrame,
  type ChronoFrame,
  type ChronoPhase,
} from "@/lib/warp/chrono";
import { easeFade, span } from "@/lib/warp/choreography";
import type { IntroStatus } from "@/lib/graph/intro-signal";
import { DUR_MS } from "@/lib/motion";

/**
 * Once the warp has started it plays for at least this long.
 *
 * A floor on a run that has ALREADY begun — never a gate on beginning one. Without it a load
 * that resolves just after the trigger shows a few frames of animation and snaps away, which
 * reads as a glitch rather than as an intro. `DUR_MS.celestial` rather than a fresh literal:
 * this is the app's slowest motion token and the intro is its slowest motion.
 */
export const INTRO_MIN_BEAT_MS = DUR_MS.celestial;

/**
 * The collapse is quicker here than on `/upgrade`.
 *
 * There it has to cover a route swap; here it only has to hand a canvas to the canvas
 * underneath it, and 860ms of deceleration on a page the user is waiting for reads as padding.
 * Applied by scaling the arriving clock, so `chronoFrame`'s shape — and every property
 * `smoke-warp-chrono.ts` pins about it — is preserved exactly.
 */
export const INTRO_ARRIVING_MS = 560;
export const INTRO_ARRIVING_SCALE = CHRONO_ARRIVING_MS / INTRO_ARRIVING_MS;

/**
 * How long the intro stays FULLY opaque after the collapse begins.
 *
 * This is an interlock, not a taste decision. `<ReactFlow>` runs its own
 * `transition: "opacity 220ms ease"` when `viewportReady` flips (see `network-graph.tsx`), and
 * that fade has to finish behind full cover — otherwise the user sees the chart fade in, then
 * the warp fade out, two transitions where there should be one. Must stay >= 220.
 */
export const INTRO_OPAQUE_MS = CHRONO_OPAQUE_MS / INTRO_ARRIVING_SCALE;

/**
 * How long a hold can run before the sky stops growing.
 *
 * `/upgrade` caps a journey at 4s, so `CRUISE_BURSTS` runs out after that and the field stops
 * lighting new stars — which is exactly the loop the reserve exists to prevent. A cold chunk on
 * a bad connection legitimately runs longer than 4s, so the intro carries its own, larger
 * ceiling and seeds a correspondingly larger reserve.
 */
export const INTRO_CRUISE_CAP_MS = 9000;
export const INTRO_CRUISE_BURSTS = Math.floor(
  (INTRO_CRUISE_CAP_MS - CHRONO_OUTBOUND_MS) / CRUISE_BURST_MS
);

/**
 * Share of the field held back to ignite during a hold.
 *
 * Higher than the warp's `CRUISE_RESERVE_FRACTION` because there are more reserve levels to
 * spend it across — with too small a reserve the last levels light nothing and the sky stalls
 * anyway, which is the failure this is meant to avoid.
 */
export const INTRO_RESERVE_FRACTION = Math.max(CRUISE_RESERVE_FRACTION, 0.32);

/**
 * Contacts at or above which React Flow's mount and framing is a visible stall.
 *
 * A proxy for DOM work, not for layout math: `buildHybridGraphLayout` was measured at 36ms for
 * 3,046 nodes, so the geometry is cheap — what costs is React Flow mounting that many nodes and
 * `DefaultViewFitter` framing them.
 *
 * PROVISIONAL. Set by measuring mount-to-`onSettled` across seeded networks and taking the
 * count where it crosses ~400ms; see the plan's verification section. Treat the current value
 * as a starting guess, not a finding.
 */
export const INTRO_CONTACT_FLOOR = 600;

/** Below this many cores, assume everything costs about twice as much. */
export const INTRO_LOW_CORE_THRESHOLD = 4;
export const INTRO_LOW_CORE_MULTIPLIER = 2;

/**
 * The late fallback: start the intro if the chart still is not ready after this long.
 *
 * The size predictor cannot see a slow connection, so a small network on bad wifi would wait a
 * long time with no treatment at all. This catches that. Deliberately far beyond any fast
 * load — a warm one settles in roughly 120-150ms, an order of magnitude clear — so it is a
 * safety net rather than a threshold, and it can never fire on the path this feature exists to
 * keep instant.
 */
export const INTRO_LATE_MS = 1200;

export type IntroPrediction = {
  warp: boolean;
  reason: "cold-chunk" | "layout-cost" | null;
};

/**
 * Will the phase we are about to enter be slow enough to be worth covering?
 *
 * Asked BEFORE the phase begins, which is the whole point of predicting rather than timing:
 * the animation starts at the top of the stall instead of part-way through it.
 */
export function predictSlowIntro(input: {
  reduced: boolean;
  chunkLoaded: boolean;
  /** null = the payload has not arrived yet, which is not the same as "no contacts". */
  contactCount: number | null;
  cores: number | null;
}): IntroPrediction {
  // First, and deliberately ahead of every other signal: someone who has asked for less motion
  // gets none, not a gentler version. The existing `ConstellationLoading` panel already says
  // what is happening and announces it politely, so declining here removes nothing.
  if (input.reduced) return { warp: false, reason: null };

  // The chunk has never evaluated in this document. Because `next/dynamic` is `ssr: false`
  // here, its request cannot even start until the payload has streamed and the lazy wrapper
  // has hydrated — so a cold chunk is reliably a real wait.
  if (!input.chunkLoaded) return { warp: true, reason: "cold-chunk" };

  // Warm chunk and no payload yet is the "asked too early" case. Not slow, and emphatically
  // not "unknown, assume slow" — that would warp every fast load.
  if (input.contactCount === null) return { warp: false, reason: null };

  const cores = input.cores ?? 8;
  const factor =
    cores <= INTRO_LOW_CORE_THRESHOLD ? INTRO_LOW_CORE_MULTIPLIER : 1;
  return input.contactCount * factor >= INTRO_CONTACT_FLOOR
    ? { warp: true, reason: "layout-cost" }
    : { warp: false, reason: null };
}

/**
 * How much earlier the intro's ramp begins than the route transition's.
 *
 * `/upgrade` spends its first 420ms darkening the room before anything moves, which is a beat
 * this has no room for: the intro's own floor is 700ms, so a load that resolves near it would
 * show a still field, a moment of drift, and then the collapse. Running the ramp clock ahead
 * gives the field something to do from the first frame without touching the shared curve.
 */
export const INTRO_SPIN_LEAD_MS = 320;

/**
 * Which beat of the shared envelope the intro is on.
 *
 * `"cruise"` is the one that matters and it used to be unreachable: the stage mapped anything
 * not arriving to `"outbound"`, where `span` clamps and `burstsBy` tops out at the scripted
 * seven — so during a long hold the reserve waves never arrived and the field stopped growing,
 * which is the exact loop the reserve exists to prevent. The smoke was asserting the growth
 * against `introFrame("cruise", …)`, a phase nothing ever passed. Hence this lives here, where
 * the smoke can hold it to the same mapping the stage uses.
 *
 * The handover is continuous by construction: at `CHRONO_OUTBOUND_MS` the outbound ramp has
 * long since clamped to peak and all seven scripted bursts have fired, which is precisely
 * where cruise starts counting.
 */
export function introPhase(status: IntroStatus, elapsed: number): ChronoPhase {
  if (status === "arriving" || status === "done") return "arriving";
  return elapsed >= CHRONO_OUTBOUND_MS ? "cruise" : "outbound";
}

/**
 * `chronoFrame` with the intro's earlier ramp, faster collapse and longer hold.
 *
 * Shifting and scaling the input clocks is monotone, so every property the chrono smoke pins —
 * monotonic omega and shutter across outbound, return to rest in arriving, uneven bursts,
 * bursts carried from cruise into arriving — survives unchanged.
 */
export function introFrame(
  phase: ChronoPhase,
  elapsed: number,
  sinceArriving: number
): ChronoFrame {
  return chronoFrame(
    phase,
    // Only the ramp is led. Cruise counts reserve waves off real elapsed time, and leading that
    // clock would spend the reserve early against a ceiling derived from real milliseconds.
    phase === "outbound" ? elapsed + INTRO_SPIN_LEAD_MS : elapsed,
    sinceArriving * INTRO_ARRIVING_SCALE,
    INTRO_CRUISE_BURSTS
  );
}

/**
 * How far the field travels at full throttle, in depth units per second.
 *
 * A star spans the whole depth from the far plane to the camera in `1 / this` seconds, so at
 * 1.8 a full traverse is roughly 0.55s: fast enough that the frame is all streaks, slow enough
 * that individual stars are still legible as they go by rather than being one flat blur.
 */
export const INTRO_WARP_SPEED = 1.8;

/**
 * Extra shaping on top of the shared envelope's own acceleration, so the jump reads as a jump.
 *
 * `chronoFrame` already eases in on a cube, which is right for a camera gaining speed but too
 * even for this: the field spends the ramp visibly getting faster, and never has the moment of
 * committing. Raising it again spends most of the ramp on a slow drift — enough motion to show
 * the field is alive, not enough to be going anywhere — and then puts nearly all of the
 * acceleration in the last few hundred ms, which is the shape of a ship holding position and
 * then jumping.
 *
 * It shapes the collapse too, in the same direction and for the same reason: dropping out of
 * lightspeed is a hard stop, not a coast. Both ends are fixed points (0 and 1 survive any
 * power), so the interlocks either side of it are untouched.
 */
export const INTRO_RAMP_POWER = 1.5;

/**
 * How much of the throttle rises linearly, underneath the shaped ramp.
 *
 * The power alone is too clean: raised on top of the envelope's own cube it puts the first half
 * of the ramp at around one part in ten thousand, which is not a slow field, it is a stopped
 * one — and a stopped field followed by a surge reads as a cut rather than as an acceleration.
 * A few percent of steady drift underneath gives motion slow enough to still be waiting and
 * fast enough to see, so the surge has something to accelerate away FROM.
 */
export const INTRO_DRIFT_SHARE = 0.06;

/**
 * The cube root, because the envelope handed us a cube.
 *
 * A drift term has to be linear in elapsed time or it is not a drift, it is a third accelerating
 * curve stacked on the other two — and `omega` arrives already eased in on `t³`, so a term
 * linear in THAT is still cubed in time. The first attempt at this shipped exactly that mistake
 * and put the early ramp at 9 parts in a million, which the smoke caught by asserting the drift
 * is visible rather than merely non-zero. Undoing the cube first makes the term rise evenly.
 */
export const INTRO_DRIFT_EXPONENT = 1 / 3;

/**
 * The throttle, 0 (stopped) to 1 (full), from a frame of the shared chrono envelope.
 *
 * `chronoFrame` was written for a field rotating about a pole, so its speed term is named
 * `omega` and carries radians per second. The envelope it describes — a standstill, an eased
 * acceleration, a hold at peak, then a decelerating return to rest — is exactly the profile of
 * a jump to lightspeed and back, so the constellation intro reads it as a normalised throttle
 * and applies it along the line of travel instead of around a pole. Reinterpreting the number
 * rather than forking the curve means every property `smoke-warp-chrono.ts` pins about it —
 * monotonic through the ramp, back to rest on arrival — still describes what is on screen.
 *
 * Clamped at zero because `omega` goes negative in `"inbound"`, the rewind phase. The intro
 * never enters it; travelling backwards out of the chart you are waiting for would be a
 * different animation, and a stray negative should stop the field rather than reverse it.
 *
 * Then reshaped, so the jump reads as a jump — see `INTRO_RAMP_POWER` and `INTRO_DRIFT_SHARE`.
 * Both terms vanish at 0 and sum to 1 at full, so the standstill the run opens on and the dead
 * stop it hands the chart over from are exact, not nearly.
 */
export function introThrottle(frame: ChronoFrame): number {
  const t = Math.max(0, Math.min(1, frame.omega / OMEGA_PEAK));
  return (
    INTRO_DRIFT_SHARE * t ** INTRO_DRIFT_EXPONENT +
    (1 - INTRO_DRIFT_SHARE) * t ** INTRO_RAMP_POWER
  );
}

/**
 * How much of the canvas box the intro covers, 0 to 1.
 *
 * Opaque from the moment the shutter opens until `INTRO_OPAQUE_MS` into the collapse, then a
 * cross-fade into the chart underneath — which by then has finished its own 220ms fade behind
 * this cover. `easeFade` for the hand-off because it has zero slope at both ends; a linear
 * ramp shows a seam at the moment it starts and stops.
 */
export function introCoverage(
  phase: ChronoPhase,
  elapsed: number,
  sinceArriving: number
): number {
  if (phase === "arriving") {
    return 1 - easeFade(span(sinceArriving, [INTRO_OPAQUE_MS, INTRO_ARRIVING_MS]));
  }
  // Fading UP over the shutter window rather than appearing solid: the panel underneath is
  // already on screen, and a hard cut to an opaque canvas over it is a bigger jolt than the
  // wait itself.
  return span(elapsed, [0, CHRONO_OPAQUE_MS]);
}
