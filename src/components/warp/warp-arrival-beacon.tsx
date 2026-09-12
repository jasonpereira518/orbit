"use client";

import { useEffect } from "react";
import { useWarp } from "@/components/warp/warp-provider";

/**
 * Tells the stage that the destination has actually painted.
 *
 * Both journeys depend on this, and neither names the other:
 *   - liftoff — /pricing resolves a session and two DB reads, so it can land
 *     well after the fixed-length climb finishes. Holding in cruise is what
 *     keeps PricingPageSkeleton from flashing; the sky is simply still going by.
 *   - chrono — /upgrade awaits a session resolve plus three reads, so a hold is
 *     the normal case rather than the slow one. The exposure keeps accumulating
 *     and igniting through it, which is why a wait still reads as growth.
 *
 * Every page that mounts this must therefore also be a journey destination in
 * `lib/warp/journeys.ts`, or the beacon fires for a run that is not headed
 * here. A no-op on a direct load, where no stage was ever running.
 */
export function WarpArrivalBeacon() {
  const { arrive } = useWarp();
  useEffect(() => {
    arrive();
  }, [arrive]);
  return null;
}
