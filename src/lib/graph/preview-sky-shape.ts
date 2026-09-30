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

/** `dash` is 0 for a solid line, else the dot length: the pattern is `[dash, dash * 2.5]`. */
export type PreviewLineStyle = [
  kind: EdgeKind,
  stroke: string,
  opacity: number,
  strokeWidth: number,
  dash: number,
];

/** A dotted line's gap, as a multiple of its dot (the chart's role lines are "2 5"). */
export const DASH_GAP = 2.5;

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
  count: number;
};

export const STAR_FIELDS = 6;
export const WASH_FIELDS = 5;
export const LINE_FIELDS = 3;

export const STAR_SCATTER = 1;
export const STAR_COMET = 2;

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
      // The baked preview keeps no anatomy (no galaxy backdrop, part pools or petal names): the
      // washes it does carry are ring and petal clusters' ordinary cloud, so they read as plain
      // figures. Open and binary clusters were dropped when the sky was built.
      form: "figure",
    };
    nodes.push({ id: `w${i / WASH_FIELDS}`, type: "nebula", position: { x, y }, data });
  }

  const edges: LayoutEdge[] = [];
  for (let i = 0; i < sky.lines.length; i += LINE_FIELDS) {
    const [a, b, s] = sky.lines.slice(i, i + LINE_FIELDS);
    const [kind, stroke, opacity, strokeWidth, dash] = sky.lineStyles[s];
    edges.push({
      id: `e${i / LINE_FIELDS}`,
      source: `s${a}`,
      target: `s${b}`,
      type: "straight",
      data: dash ? { kind, dash: [dash, dash * DASH_GAP] } : { kind },
      style: dash
        ? { stroke, opacity, strokeWidth, strokeDasharray: `${dash} ${dash * DASH_GAP}` }
        : { stroke, opacity, strokeWidth },
    });
  }

  return { nodes, edges };
}
