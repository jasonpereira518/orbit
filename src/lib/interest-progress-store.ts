/**
 * The one pass on the page, live. The boarding pass (in the hero) and the referral tracker
 * (a section further down) both show the same person's referral count and place in line,
 * and both have to move when a friend joins — so the tracker's poll writes here and both
 * read from here.
 *
 * It also carries the pass's token across a join in place: the page's server render has no
 * token until a reload, so the hero publishes the new pass and the tracker picks it up.
 *
 * A module-level store read with `useSyncExternalStore`, so a write is one render pass for
 * every reader. Client-only: nothing here runs on the server, where every reader gets its
 * `serverInitial` (the values the page rendered with) instead.
 */
import { useSyncExternalStore } from "react";
import type { WelcomePlanet } from "./welcome-planets";

export type PassProgress = {
  /** The pass's share token, or null when the visitor has no pass. */
  token: string | null;
  referrals: number;
  /** Place in line, or null when there is no pass. */
  position: number | null;
  /** Friends' planets in join order, when known (the poll and the server render carry them). */
  friendPlanets?: readonly WelcomePlanet[];
};

let current: PassProgress | null = null;
const listeners = new Set<() => void>();

/** Replaces the live progress. Skips a write that changes nothing, so readers do not render. */
export function publishProgress(next: PassProgress) {
  if (
    current &&
    current.token === next.token &&
    current.referrals === next.referrals &&
    current.position === next.position &&
    (current.friendPlanets ?? []).join() === (next.friendPlanets ?? []).join()
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The live progress, or `serverInitial` until something is published. `serverInitial` must
 * be referentially stable between renders (build it in `useMemo`), or the store snapshot
 * changes every render and React loops.
 */
export function usePassProgress(serverInitial: PassProgress): PassProgress {
  return useSyncExternalStore(
    subscribe,
    () => current ?? serverInitial,
    () => serverInitial
  );
}
