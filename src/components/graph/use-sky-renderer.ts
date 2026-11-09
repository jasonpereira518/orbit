"use client";

import { useSlot } from "@/components/graph/constellation-modules";

// Apart from constellation-modules.ts because only the chart shell (a lazy chunk) renders a
// renderer; the page ships just the loader.
/**
 * The renderer for this viewport, as `{ Chart }` (render `<renderer.Chart />`), or null until
 * its chunk has loaded. `Chart` is a module export, so its identity is stable across renders.
 */
export function useSkyRenderer(_smallSky?: boolean) {
  const flow = useSlot("flow", true);
  return flow ? { Chart: flow.GraphCanvasFlow } : null;
}
