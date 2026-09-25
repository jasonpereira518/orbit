"use client";

import { useSlot } from "@/components/graph/constellation-modules";

// Apart from constellation-modules.ts because only the chart shell (a lazy chunk) renders a
// renderer; the page ships just the loader.
/**
 * The renderer for this viewport, as `{ Chart }` (render `<renderer.Chart />`), or null until
 * its chunk has loaded. `Chart` is a module export, so its identity is stable across renders.
 */
export function useSkyRenderer(smallSky: boolean) {
  // Both hooks run so their order is fixed, but only the chosen renderer is ever requested: a
  // phone must not download React Flow, nor a laptop the canvas renderer.
  const flow = useSlot("flow", !smallSky);
  const mobile = useSlot("mobile", smallSky);
  if (smallSky) return mobile ? { Chart: mobile.GraphCanvasMobile } : null;
  return flow ? { Chart: flow.GraphCanvasFlow } : null;
}
