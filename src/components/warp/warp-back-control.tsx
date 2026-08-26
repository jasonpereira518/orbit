"use client";

import { BackControl } from "@/components/pricing/back-control";
import { arrivedByWarp, useWarp } from "@/components/warp/warp-provider";

/**
 * /pricing's Back button, with the fall home attached.
 *
 * The warp logic lives here rather than inside `BackControl` because that
 * component is shared with /upgrade and every marketing doc, none of which
 * were reached by lift-off. It stays generic and exposes `onBeforeNavigate`;
 * each page decides what, if anything, happens before the navigation — the
 * same seam /upgrade uses for its slide-then-fade exit.
 *
 * A client component because a Server Component cannot hand a function across
 * the boundary, which is also why /upgrade wraps its header in `PageExitOnBack`.
 */
export function WarpBackControl() {
  const { reenter } = useWarp();

  return (
    <BackControl
      onBeforeNavigate={(navigate) => {
        // Only somebody standing where a lift-off dropped them falls back down.
        // Anyone who arrived from the marketing landing is already in space, and
        // a direct load never launched at all — both get the plain navigation.
        // reenter() owns the call so the fall and the navigation start on the
        // same frame; it declines only if a run is already in flight.
        if (arrivedByWarp() && reenter(navigate)) return;
        navigate();
      }}
    />
  );
}
