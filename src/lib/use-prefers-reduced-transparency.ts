"use client";

import { useEffect, useState } from "react";

/**
 * `prefers-reduced-transparency`, read after mount for the same reason as
 * `usePrefersReducedMotion`: `false` on the server and in the first client render, so
 * hydration always matches, and it follows the setting if it changes.
 */
export function usePrefersReducedTransparency() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return reduced;
}
