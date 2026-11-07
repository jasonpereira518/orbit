"use client";

import { GraphCanvasFlow } from "@/components/graph/graph-canvas-flow";
import type { GraphChartProps } from "@/components/graph/graph-chart-types";

/**
 * @deprecated Retired legacy canvas renderer. The mobile constellation has been unified
 * with the high-fidelity desktop renderer (GraphCanvasFlow) across all mobile devices
 * and orientations, providing full visual parity (starfield, glowing corona, crisp typography)
 * at 60 FPS.
 */
export function GraphCanvasMobile(props: GraphChartProps) {
  return <GraphCanvasFlow {...props} />;
}
