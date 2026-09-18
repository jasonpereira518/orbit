/**
 * The preview's wire format, and its way back into the chart's layout shape.
 *
 * Split from `preview-sky.ts` because this half runs in the browser: it may import only types
 * from the layout, or the whole layout engine would ride along into the dashboard's bundle.
 */
import type {
  EdgeKind,
  GraphNodeData,
  LayoutEdge,
  LayoutNode,
  NebulaData,
} from "@/lib/graph-layout";

export type PreviewLineStyle = [kind: EdgeKind, stroke: string, opacity: number, strokeWidth: number];

export type PreviewSky = {
  /** Flat [x, y, score, colourIndex (-1: untinted), flags, cometAngle×100] per star. */
  stars: number[];
  /** Colours referenced by stars and washes. */
  colors: string[];
  /** Cluster names: never drawn, only the seeds that shape each wash (see `nebulaLobes`). */
  names: string[];
  /** Flat [x, y, radius, colourIndex, nameIndex] per cluster wash. */
  washes: number[];
  /** Flat [starA, starB, styleIndex] per constellation line. */
  lines: number[];
  /** The distinct looks the lines come in. */
  lineStyles: PreviewLineStyle[];
  /** Orbit ring radii, drawn around the sun. */
  rings: number[];
  count: number;
};

export const STAR_FIELDS = 6;
export const WASH_FIELDS = 5;
export const LINE_FIELDS = 3;

export const STAR_SCATTER = 1;
export const STAR_COMET = 2;
export const STAR_OVERDUE = 4;

/**
 * The numbers back into the layout shape the chart's renderer reads. Every star carries only the
 * fields that decide how it looks, and none carries a name.
 */
export function expandPreviewSky(sky: PreviewSky): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = [
    {
      id: "me",
      type: "user",
      position: { x: 0, y: 0 },
      data: { kind: "user", label: "", initials: "" },
    },
  ];
  if (sky.rings.length > 0) {
    nodes.push({
      id: "rings",
      type: "orbitRings",
      position: { x: 0, y: 0 },
      data: { kind: "rings", radii: sky.rings },
    });
  }

  for (let i = 0; i < sky.stars.length; i += STAR_FIELDS) {
    const [x, y, score, c, flags, angle] = sky.stars.slice(i, i + STAR_FIELDS);
    const data: GraphNodeData = {
      kind: "contact",
      label: "",
      initials: "",
      score,
      figureRole: flags & STAR_SCATTER ? "scatter" : "figure",
      clusterColor: c >= 0 ? sky.colors[c] : undefined,
      comet: Boolean(flags & STAR_COMET),
      overdue: Boolean(flags & STAR_OVERDUE),
      orbitAngle: angle / 100,
    };
    nodes.push({ id: `s${i / STAR_FIELDS}`, type: "contact", position: { x, y }, data });
  }

  for (let i = 0; i < sky.washes.length; i += WASH_FIELDS) {
    const [x, y, radius, c, name] = sky.washes.slice(i, i + WASH_FIELDS);
    const data: NebulaData = {
      kind: "nebula",
      company: sky.names[name],
      color: sky.colors[c],
      radius,
    };
    nodes.push({ id: `w${i / WASH_FIELDS}`, type: "nebula", position: { x, y }, data });
  }

  const edges: LayoutEdge[] = [];
  for (let i = 0; i < sky.lines.length; i += LINE_FIELDS) {
    const [a, b, s] = sky.lines.slice(i, i + LINE_FIELDS);
    const [kind, stroke, opacity, strokeWidth] = sky.lineStyles[s];
    edges.push({
      id: `e${i / LINE_FIELDS}`,
      source: `s${a}`,
      target: `s${b}`,
      type: "straight",
      data: { kind },
      style: { stroke, opacity, strokeWidth },
    });
  }

  return { nodes, edges };
}
