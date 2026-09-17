/**
 * The dashboard's constellation preview, reduced to what it draws.
 *
 * Pure, and run on the server. The preview used to ship up to 150 full contact records (summaries,
 * key facts, emails) to the browser and mount the whole interactive chart — React Flow, its
 * toolbars and starfield — in a 300px card nobody can pan. Now the server lays the sky out once
 * and sends only dot positions, sizes and a colour palette, and the browser paints one canvas.
 */
import {
  buildHybridGraphLayout,
  type GraphContactInput,
  type GraphNodeData,
} from "@/lib/graph-layout";
import { starVisual } from "@/lib/graph/star-style";

export type PreviewSky = {
  /** The world rect to frame: the stars' trimmed bounds, always including the sun at 0,0. */
  frame: { minX: number; minY: number; maxX: number; maxY: number };
  /** Flat [x, y, radius, colourIndex, alpha×100] per star, in layout px. */
  stars: number[];
  /** Colours referenced by `stars`. */
  colors: string[];
  /** Flat [x1, y1, x2, y2] per constellation line. */
  lines: number[];
  count: number;
};

const STAR_FIELDS = 5;
/** Outermost share of stars left out of the frame on each side, so a few loners do not shrink it. */
const FRAME_TRIM = 0.04;

function trimmed(values: number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * FRAME_TRIM);
  return [sorted[cut], sorted[sorted.length - 1 - cut]];
}

export function buildPreviewSky(contacts: GraphContactInput[], userName: string): PreviewSky {
  const layout = buildHybridGraphLayout(contacts, userName);
  const colorIndex = new Map<string, number>();
  const colors: string[] = [];
  const stars: number[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const xs: number[] = [0];
  const ys: number[] = [0];

  for (const n of layout.nodes) {
    if (n.type !== "contact") continue;
    const d = n.data as GraphNodeData;
    const visual = starVisual(d, false);
    const color = visual.isComet ? "#ff6b4a" : visual.fill;
    let ci = colorIndex.get(color);
    if (ci === undefined) {
      ci = colors.length;
      colors.push(color);
      colorIndex.set(color, ci);
    }
    const x = Math.round(n.position.x);
    const y = Math.round(n.position.y);
    positions.set(n.id, { x, y });
    xs.push(x);
    ys.push(y);
    stars.push(x, y, Math.round((visual.disc / 2) * 10) / 10, ci, Math.round(visual.alphaScale * 100));
  }

  const lines: number[] = [];
  for (const e of layout.edges) {
    if (e.data?.kind !== "constellation" && e.data?.kind !== "knows") continue;
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    if (a && b) lines.push(a.x, a.y, b.x, b.y);
  }

  const [minX, maxX] = trimmed(xs);
  const [minY, maxY] = trimmed(ys);
  return {
    frame: { minX: Math.min(minX, 0), minY: Math.min(minY, 0), maxX: Math.max(maxX, 0), maxY: Math.max(maxY, 0) },
    stars,
    colors,
    lines,
    count: stars.length / STAR_FIELDS,
  };
}
