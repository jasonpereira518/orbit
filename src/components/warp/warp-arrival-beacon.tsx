"use client";

import { useEffect } from "react";
import { useWarp } from "@/components/warp/warp-provider";

/**
 * Tells the stage that /pricing has actually painted.
 *
 * The ascent is a fixed length but the route is not: /pricing resolves a
 * session and two DB reads, so it can land well after the climb finishes. Until
 * this mounts the stage holds in cruise, which is what keeps PricingPageSkeleton
 * from flashing — the sky is simply still going by.
 *
 * A no-op on a direct load, where the stage was never running.
 */
export function WarpArrivalBeacon() {
  const { arrive } = useWarp();
  useEffect(() => {
    arrive();
  }, [arrive]);
  return null;
}
