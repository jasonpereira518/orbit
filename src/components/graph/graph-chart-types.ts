/**
 * The contract between the constellation's chrome and whichever renderer draws the sky.
 *
 * `NetworkGraph` owns search, filters, scope, refresh and the inspect panel; the chart
 * below it only draws and reports taps. Both `GraphCanvasFlow` (React Flow, DOM nodes)
 * and `GraphCanvasMobile` (one canvas) take exactly this, so the branch between them is
 * a single ternary and neither can quietly grow a prop the other lacks.
 */
import type { getGraphData } from "@/actions/graph";
import type { InspectSelection } from "@/components/graph/contact-inspect-panel";
import type { PositionMap } from "@/lib/graph-positions";

export type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;
export type GraphContact = GraphPayload["contacts"][number];
export type GraphCluster = GraphPayload["clusters"][number];

export type GraphChartProps = {
  data: GraphPayload;
  company: string;
  school: string;
  keyword: string;
  minScore: string;
  search: string;
  searchHitIds: Set<string>;
  focusCluster: string | null;
  zoomToken: number;
  homeToken: number;
  peekPersonId: string | null;
  peekToken: number;
  positionOverrides: PositionMap;
  onPositionOverridesChange: (next: PositionMap) => void;
  selection: InspectSelection;
  hoveredId: string | null;
  onSelect: (selection: InspectSelection) => void;
  onHover: (id: string | null) => void;
  onFocusCluster: (clusterId: string) => void;
  resetToken: number;
  compact?: boolean;
  /** Whether this payload is the engaged-only scope (vs. the full network). */
  constellationFilterOn: boolean;
  onShowAll: () => void;
  loadingAll: boolean;
};
