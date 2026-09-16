/**
 * The layout, arranged so a frame can find what it needs without walking all of it.
 *
 * Built once per layout change and reused by every draw and every tap: the grid answers
 * "what is on screen" and "what did the finger land on" from the same structure, which
 * is why the renderer's cost tracks the size of the viewport rather than the size of the
 * network.
 */
import type {
  ClusterLabelData,
  GraphNodeData,
  LayoutEdge,
  LayoutNode,
  NebulaData,
} from "@/lib/graph-layout";
import type { PositionMap } from "@/lib/graph-positions";
import { buildSkyGrid, type SkyGrid, type SkyTarget } from "@/lib/graph/hit-test";
import { starVisual } from "@/lib/graph/star-style";

export type StarEntry = {
  id: string;
  x: number;
  y: number;
  data: GraphNodeData;
  /** Descending sort key: who gets a label first when the budget runs out. */
  score: number;
};

export type NebulaEntry = {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  clusterId?: string;
  company: string;
};

export type ClusterLabelEntry = {
  id: string;
  x: number;
  y: number;
  label: string;
  count?: number;
  color: string;
  clusterId?: string;
};

export type EdgeEntry = {
  source: string;
  target: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  stroke: string;
  opacity: number;
  strokeWidth: number;
  kind?: string;
};

export type SkyIndex = {
  stars: StarEntry[];
  /** Star ids in descending score order — the label budget draws from the front. */
  labelOrder: StarEntry[];
  starsById: Map<string, StarEntry>;
  nebulae: NebulaEntry[];
  clusterLabels: ClusterLabelEntry[];
  edges: EdgeEntry[];
  sun: { x: number; y: number; data: GraphNodeData } | null;
  ringRadii: number[];
  grid: SkyGrid;
  /** World bounding box of everything drawn, for the pan clamp. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/**
 * A star arranged on a laptop must sit in the same place on a phone, so overrides are
 * honoured for rendering on both. The canvas never *writes* them — dragging a 2px star
 * is not a gesture a finger can perform, and read-only means the phone can never corrupt
 * a layout it cannot recreate.
 */
function positionOf(node: LayoutNode, overrides: PositionMap) {
  return overrides[node.id] || node.position;
}

export function buildSkyIndex(
  layout: { nodes: LayoutNode[]; edges: LayoutEdge[] },
  overrides: PositionMap
): SkyIndex {
  const stars: StarEntry[] = [];
  const nebulae: NebulaEntry[] = [];
  const clusterLabels: ClusterLabelEntry[] = [];
  const starsById = new Map<string, StarEntry>();
  const positions = new Map<string, { x: number; y: number }>();
  let sun: SkyIndex["sun"] = null;
  let ringRadii: number[] = [];

  for (const node of layout.nodes) {
    const p = positionOf(node, overrides);
    positions.set(node.id, p);

    if (node.type === "orbitRings") {
      ringRadii = [...(node.data as { radii: number[] }).radii];
      continue;
    }
    if (node.type === "user") {
      sun = { x: p.x, y: p.y, data: node.data as GraphNodeData };
      continue;
    }
    if (node.type === "nebula") {
      const d = node.data as NebulaData;
      nebulae.push({
        id: node.id,
        x: p.x,
        y: p.y,
        radius: d.radius || 80,
        color: d.color,
        clusterId: d.clusterId,
        company: d.company,
      });
      continue;
    }
    if (node.type === "clusterLabel") {
      const d = node.data as ClusterLabelData;
      clusterLabels.push({
        id: node.id,
        x: p.x,
        y: p.y,
        label: d.label,
        count: d.count,
        color: d.nebulaColor || "#9fb4ff",
        clusterId: d.clusterId,
      });
      continue;
    }

    const d = node.data as GraphNodeData;
    const entry: StarEntry = { id: node.id, x: p.x, y: p.y, data: d, score: d.score || 2 };
    stars.push(entry);
    starsById.set(node.id, entry);
  }

  const edges: EdgeEntry[] = [];
  for (const e of layout.edges) {
    const kind = e.data?.kind;
    // Peer constellation / knows links only — the sun's rays are pure decoration and
    // the DOM chart injects them separately.
    if (kind !== "constellation" && kind !== "knows") continue;
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    if (!a || !b) continue;
    edges.push({
      source: e.source,
      target: e.target,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      stroke: String(e.style?.stroke ?? "rgba(255,255,255,0.35)"),
      opacity: Number(e.style?.opacity ?? 0.5),
      strokeWidth: Number(e.style?.strokeWidth ?? 1),
      kind,
    });
  }

  // Tap targets. Stars carry their drawn radius; nebulae and cluster labels are here so
  // one grid answers every kind of tap, but the resolution order in `pickSkyTarget`
  // makes sure a star always beats the haze behind it.
  const targets: SkyTarget[] = stars.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    r: starVisual(s.data, false).disc / 2,
    kind: "contact" as const,
  }));
  if (sun) targets.push({ id: "me", x: sun.x, y: sun.y, r: 22, kind: "user" });
  for (const n of nebulae) {
    targets.push({ id: n.id, x: n.x, y: n.y, r: n.radius, kind: "nebula" });
  }
  for (const l of clusterLabels) {
    // Rectangular in spirit; a radius covering the 104px label box is close enough for a
    // finger and keeps one uniform grid rather than two.
    targets.push({ id: l.id, x: l.x, y: l.y, r: 60, kind: "clusterLabel" });
  }

  let minX = -240;
  let minY = -240;
  let maxX = 240;
  let maxY = 240;
  for (const t of targets) {
    if (t.x - t.r < minX) minX = t.x - t.r;
    if (t.y - t.r < minY) minY = t.y - t.r;
    if (t.x + t.r > maxX) maxX = t.x + t.r;
    if (t.y + t.r > maxY) maxY = t.y + t.r;
  }

  const labelOrder = [...stars].sort((a, b) => b.score - a.score);

  return {
    stars,
    labelOrder,
    starsById,
    nebulae,
    clusterLabels,
    edges,
    sun,
    ringRadii,
    grid: buildSkyGrid(targets),
    bounds: { minX, minY, maxX, maxY },
  };
}
