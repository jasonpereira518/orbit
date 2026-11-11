/**
 * The contract between the constellation's chrome and whichever renderer draws the sky.
 *
 * `NetworkGraph` owns search, filters, scope, refresh and the inspect panel; the chart
 * below it only draws and reports taps. Both `GraphCanvasFlow` (React Flow, DOM nodes)
 * and `GraphCanvasMobile` (one canvas) take exactly this, so the branch between them is
 * a single ternary and neither can quietly grow a prop the other lacks.
 */
import type { GraphPayload } from "@/lib/graph-wire";
import type { InspectSelection } from "@/components/graph/contact-inspect-panel";

export type { GraphContact, GraphCluster, GraphPayload } from "@/lib/graph-wire";

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
  selection: InspectSelection;
  hoveredId: string | null;
  onSelect: (selection: InspectSelection) => void;
  onHover: (id: string | null) => void;
  onFocusCluster: (clusterId: string) => void;
  compact?: boolean;
  /** Whether this payload is the engaged-only scope (vs. the full network). */
  constellationFilterOn: boolean;
  onShowAll: () => void;
  loadingAll: boolean;
  /** A custom sky with nobody in it: the page says so itself, so the chart keeps its own empty copy to itself. */
  emptySky?: boolean;
};

/** A custom constellation shown in place of the whole network; `reasons` is why each member (by contact id) is in it. */
export type GraphConstellation = { id: string; name: string; reasons: Record<string, string> };
