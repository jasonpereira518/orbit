/**
 * The two journeys the warp provider can fly, and the gate that remembers
 * which one delivered you.
 *
 *   liftoff — the app to /pricing. A rocket. Slow out, fast home.
 *   chrono  — Settings to /upgrade. A time warp forward, told as long-exposure
 *             star trails. You rewind home the way you came, but nowhere near
 *             as far: at least 2810ms out — 1950ms of deterministic run, any
 *             cruise hold on top of that, then 860ms of deceleration —
 *             against 1150ms back. Coming home is a departure someone has
 *             already decided on, and the beats below are not symmetric.
 *             `outboundMs` and `inboundMs` are not comparable on their own;
 *             see their doc comments.
 *
 * Deliberately free of React and next/* imports: the smoke script loads this
 * module directly under tsx, and a `next/dynamic` in here would take the whole
 * framework with it. The stage COMPONENTS are looked up in the provider; this
 * file only names the journeys.
 */
import {
  ARRIVAL_MS,
  ASCENT_MS,
  ASCENT_OPAQUE_MS,
  REENTRY,
  REENTRY_MS,
} from "@/lib/warp/choreography";
import {
  CHRONO_ARRIVING_MS,
  CHRONO_IN,
  CHRONO_INBOUND_MS,
  CHRONO_OPAQUE_MS,
  CHRONO_OUTBOUND_MS,
} from "@/lib/warp/chrono";

export type JourneyId = "liftoff" | "chrono";

export type JourneyBeats = {
  /** Deterministic outbound run, ms from launch, before any cruise hold. */
  outboundMs: number;
  /** When the stage covers the frame and the route swap becomes invisible. */
  opaqueMs: number;
  /** Deceleration, once the destination has actually painted. */
  arrivingMs: number;
  /** The whole return arc, start to settled. */
  inboundMs: number;
  /** When router.back() fires on the way home. 0 = immediately. */
  inboundPushMs: number;
  /** When the phase flips to "landing" — the touchdown beat. */
  inboundLandingMs: number;
};

export type Journey = {
  id: JourneyId;
  destination: string;
  beats: JourneyBeats;
};

export const JOURNEYS: Record<JourneyId, Journey> = {
  liftoff: {
    id: "liftoff",
    destination: "/pricing",
    beats: {
      outboundMs: ASCENT_MS,
      opaqueMs: ASCENT_OPAQUE_MS,
      arrivingMs: ARRIVAL_MS,
      inboundMs: REENTRY_MS,
      // liftoff — navigates immediately: unlike the ascent there is nothing on
      // screen worth preserving, and the app must be mounted before the judder.
      inboundPushMs: 0,
      inboundLandingMs: REENTRY.judder[0],
    },
  },
  chrono: {
    id: "chrono",
    destination: "/upgrade",
    beats: {
      outboundMs: CHRONO_OUTBOUND_MS,
      opaqueMs: CHRONO_OPAQUE_MS,
      arrivingMs: CHRONO_ARRIVING_MS,
      inboundMs: CHRONO_INBOUND_MS,
      // chrono — the page leaving is the shot: the panels lift and fly out to
      // either side of the frame, so the swap waits until the stage has come
      // back up behind them.
      inboundPushMs: CHRONO_IN.push,
      inboundLandingMs: CHRONO_IN.landing[0],
    },
  },
};

/** What `launch()` writes to sessionStorage. */
export function encodeArrival(id: JourneyId, destination: string) {
  return `${id}:${destination}`;
}

/**
 * Which journey delivered this visitor to `pathname`, or null.
 *
 * Both halves have to agree. A rocket ride stores "liftoff:/pricing"; stepping
 * on to /upgrade from there no longer matches, so Back stays a plain
 * navigation instead of falling to Earth on the wrong page.
 *
 * Anything unrecognised — a bare path written before this shipped, an unknown
 * id, an empty string — degrades to null. A missing nicety is always cheaper
 * than a wrong journey.
 */
export function decodeArrival(
  stored: string | null,
  pathname: string
): JourneyId | null {
  if (!stored) return null;
  const sep = stored.indexOf(":");
  if (sep === -1) return null;
  const id = stored.slice(0, sep);
  if (stored.slice(sep + 1) !== pathname) return null;
  return id === "liftoff" || id === "chrono" ? id : null;
}
