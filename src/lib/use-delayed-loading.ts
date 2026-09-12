"use client";

import { useEffect, useState } from "react";

/**
 * Debounces a loading flag so a skeleton only appears once `loading` has stayed
 * true for `delayMs`. A fetch that resolves sooner than that never shows one —
 * for a client-side `isLoading` state (unlike route-level Suspense, which only
 * paints its fallback once the server actually streams it), nothing otherwise
 * stops a same-frame response from flashing a skeleton for a single frame.
 */
export function useDelayedLoading(loading: boolean, delayMs = 150): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setShow(true), delayMs);
    // Runs when `loading` flips back to false (or on unmount), resetting `show`
    // so the next loading cycle waits out the delay again instead of reusing
    // whatever it settled on last time.
    return () => {
      clearTimeout(timer);
      setShow(false);
    };
  }, [loading, delayMs]);

  return loading && show;
}
