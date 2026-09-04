/**
 * The constellation intro's state, outside React.
 *
 * Three parties have to agree about one animation and none of them can hold the state:
 *
 * - `network-graph.tsx` is a lazily-imported chunk. Whether it has *evaluated* is the one
 *   honest answer to "was the chunk cold", and only the module itself can report that.
 * - `GraphCanvasInner` knows when the chart is genuinely visible, but it is remounted on
 *   every change to the contact id set, so anything it owns is destroyed several times a
 *   session.
 * - `ConstellationIntro` renders the animation and lives above the Suspense boundary, so it
 *   cannot see either of the other two.
 *
 * Hence a module-scope bus: plain functions, one listener set, no React and no imports beyond
 * a `visibilitychange` handler. Keeping it dependency-free is load-bearing — this module is
 * imported by the lazy graph chunk *and* by the route bundle, so anything heavy pulled in here
 * lands in the shared chunk and works against the very cold-start cost the intro exists to
 * cover.
 *
 * The design rule that makes the whole thing safe: **a ready signal can only END a run, never
 * start one.** Only `beginIntro` starts anything, and it is idempotent. That is what stops the
 * per-batch remounts of a full refresh from replaying the animation.
 */
import {
  INTRO_ARRIVING_MS,
  INTRO_LATE_MS,
  INTRO_MIN_BEAT_MS,
} from "@/lib/graph/intro-choreography";

export type IntroStatus = "idle" | "running" | "arriving" | "done";

/** Why the intro started. Surfaced as a `data-intro-reason` attribute so it is inspectable. */
export type IntroReason = "cold-chunk" | "layout-cost" | "late" | "forced";

export type IntroRun = {
  status: IntroStatus;
  reason: IntroReason | null;
  /** `performance.now()` when the run began. Every beat derives from elapsed time. */
  startedAt: number;
  /** When the collapse began — set once the chart is ready AND the minimum beat is served. */
  arrivingAt: number | null;
};

const IDLE: IntroRun = {
  status: "idle",
  reason: null,
  startedAt: 0,
  arrivingAt: null,
};

let run: IntroRun = IDLE;
let hostRegistered = false;
let chunkLoaded = false;
let ready = false;
let beatTimer: ReturnType<typeof setTimeout> | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenAt: number | null = null;
let visibilityBound = false;
let lateTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<(next: IntroRun) => void>();

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function publish() {
  for (const fn of listeners) fn(run);
}

export function subscribe(fn: (next: IntroRun) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getIntroRun(): IntroRun {
  return run;
}

/**
 * Called at module scope from inside the lazy graph chunk.
 *
 * Module scope, not an effect: it must be true the instant the module evaluates, because the
 * question it answers is "has this document already paid for this chunk".
 */
export function markGraphChunkLoaded() {
  chunkLoaded = true;
}

export function isGraphChunkLoaded() {
  return chunkLoaded;
}

/**
 * The intro host is on screen and able to render an animation.
 *
 * Guards against a `beginIntro` from somewhere with nowhere to draw — notably the dashboard's
 * compact preview, which renders the same graph module but has no intro above it.
 */
export function registerIntroHost() {
  hostRegistered = true;
  bindVisibility();
  startLateFallback();
  return () => {
    hostRegistered = false;
    resetIntro();
  };
}

/**
 * The second trigger: cover a wait that the size predictor could not see coming.
 *
 * A small network on a slow connection is a long wait that `predictSlowIntro` declines, because
 * nothing about the payload says "slow". This catches it. It is set far enough out that a fast
 * load can never reach it, so it never costs the instant path anything.
 */
function startLateFallback() {
  if (lateTimer !== null) return;
  lateTimer = setTimeout(() => {
    lateTimer = null;
    // Ready already, or a run is in flight — either way there is nothing to rescue.
    if (ready || run.status !== "idle") return;
    beginIntro("late");
  }, INTRO_LATE_MS);
}

function clearLateFallback() {
  if (lateTimer === null) return;
  clearTimeout(lateTimer);
  lateTimer = null;
}

/**
 * A backgrounded tab must not age the animation.
 *
 * Without this a tab hidden for three minutes returns with `elapsed = 180000`: every reserve
 * burst spent and the exposure parked at the end of its arc, which reads as a different
 * animation than the one that was playing. Shifting `startedAt` forward by the hidden span
 * resumes exactly where it paused.
 *
 * `arrivingAt` shifts with it for the same reason. The minimum beat deliberately does NOT —
 * see `beginIntro`.
 */
function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = now();
      return;
    }
    if (hiddenAt === null) return;
    const gap = now() - hiddenAt;
    hiddenAt = null;
    if (run.status !== "running" && run.status !== "arriving") return;
    run = {
      ...run,
      startedAt: run.startedAt + gap,
      arrivingAt: run.arrivingAt === null ? null : run.arrivingAt + gap,
    };
    publish();
  });
}

/**
 * Start the intro. Idempotent, and the ONLY way a run begins.
 *
 * Returns whether this call owns the run, so a caller can record that it has already decided.
 */
export function beginIntro(reason: IntroReason): boolean {
  if (!hostRegistered) return false;
  if (run.status !== "idle") return false;

  run = { status: "running", reason, startedAt: now(), arrivingAt: null };
  publish();

  // The chart may already be ready — a late-trigger run starts precisely because it was not,
  // but a forced one might be. Serve the beat either way.
  if (ready) scheduleArrival();
  return true;
}

/**
 * The chart is genuinely visible.
 *
 * Fires from `viewportReady`, which flips on every `GraphCanvasInner` remount — so this is
 * called many times per session, and must be inert unless a run is actually in flight.
 */
export function markGraphViewportReady() {
  ready = true;
  // Before anything else: a chart that settles at 1190ms must not trip a fallback at 1200ms and
  // then be held for the full minimum beat. Cancelling here is what stops the safety net from
  // making a nearly-finished load longer than it was.
  clearLateFallback();
  if (run.status !== "running") return;
  scheduleArrival();
}

/** Has the chart reported itself visible at least once this document? */
export function isGraphViewportReady() {
  return ready;
}

function scheduleArrival() {
  if (beatTimer !== null) return;
  // The floor is on unshifted wall clock on purpose: someone who tabbed away and came back to
  // a finished chart should get it immediately, not sit through a beat they did not watch.
  const served = now() - run.startedAt;
  const remaining = Math.max(0, INTRO_MIN_BEAT_MS - served);
  beatTimer = setTimeout(() => {
    beatTimer = null;
    if (run.status !== "running") return;
    run = { ...run, status: "arriving", arrivingAt: now() };
    publish();
    endTimer = setTimeout(() => {
      endTimer = null;
      run = { ...run, status: "done" };
      publish();
    }, INTRO_ARRIVING_MS);
  }, remaining);
}

export function resetIntro() {
  clearLateFallback();
  if (beatTimer !== null) clearTimeout(beatTimer);
  if (endTimer !== null) clearTimeout(endTimer);
  beatTimer = null;
  endTimer = null;
  hiddenAt = null;
  ready = false;
  run = IDLE;
  publish();
}

/** Test seam — the module keeps process-wide state, so a smoke run must be able to clear it. */
export function __resetIntroForTests() {
  hostRegistered = false;
  chunkLoaded = false;
  resetIntro();
}
