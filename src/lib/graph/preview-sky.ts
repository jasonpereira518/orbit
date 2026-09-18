/**
 * The dashboard's constellation preview, reduced to what it draws.
 *
 * Pure, and run on the server. The preview used to ship up to 150 full contact records (summaries,
 * key facts, emails) to the browser and mount the whole interactive chart — React Flow, its
 * toolbars and starfield — in a 300px card nobody can pan. Now the server lays the sky out once
 * and sends only what the picture is made of, as flat numbers against small palettes. The browser
 * expands that back into the chart's own layout shape (`preview-sky-shape.ts`) and hands it to
 * the chart's canvas renderer (`sky-canvas/draw-sky.ts`), so the card is the constellation tab's
 * sky rather than an approximation of it.
 *
 * Nobody's id, name, role or contact details are in it, and the card draws no names at all. The
 * only words are the cluster names, and they are there as seeds: each cluster's wash takes its
 * shape from its name, so the card's clouds match the tab's.
 */
import {
  buildHybridGraphLayout,
  type GraphContactInput,
  type GraphNodeData,
  type NebulaData,
  type OrbitRingsData,
} from "@/lib/graph-layout";
import {
  STAR_COMET,
  STAR_OVERDUE,
  STAR_SCATTER,
  type PreviewLineStyle,
  type PreviewSky,
} from "@/lib/graph/preview-sky-shape";

export type { PreviewSky } from "@/lib/graph/preview-sky-shape";

const round = (v: number) => Math.round(v * 10) / 10;

/** Distinct values in first-seen order, and each value's index into them. */
function palette<T>(key: (value: T) => string = String) {
  const index = new Map<string, number>();
  const values: T[] = [];
  return {
    values,
    of(value: T) {
      const k = key(value);
      let i = index.get(k);
      if (i === undefined) {
        i = values.length;
        values.push(value);
        index.set(k, i);
      }
      return i;
    },
  };
}

export function buildPreviewSky(contacts: GraphContactInput[], userName: string): PreviewSky {
  const layout = buildHybridGraphLayout(contacts, userName);
  const colors = palette<string>();
  const names = palette<string>();
  const lineStyles = palette<PreviewLineStyle>((s) => s.join("|"));
  const starIndex = new Map<string, number>();
  const stars: number[] = [];
  const washes: number[] = [];
  let rings: number[] = [];

  for (const n of layout.nodes) {
    const x = round(n.position.x);
    const y = round(n.position.y);
    if (n.type === "contact") {
      const d = n.data as GraphNodeData;
      starIndex.set(n.id, starIndex.size);
      const flags =
        (d.figureRole === "scatter" ? STAR_SCATTER : 0) |
        (d.comet ? STAR_COMET : 0) |
        (d.overdue ? STAR_OVERDUE : 0);
      stars.push(
        x,
        y,
        d.score ?? 2,
        d.clusterColor ? colors.of(d.clusterColor) : -1,
        flags,
        // Only a comet's tail reads its angle.
        d.comet ? Math.round((d.orbitAngle ?? 0) * 100) : 0
      );
    } else if (n.type === "nebula") {
      const d = n.data as NebulaData;
      washes.push(x, y, round(d.radius), colors.of(d.color), names.of(d.company));
    } else if (n.type === "orbitRings") {
      rings = [...(n.data as OrbitRingsData).radii];
    }
  }

  // The figures' lines only: the sun's rays are decoration the canvas renderer never draws.
  const lines: number[] = [];
  for (const e of layout.edges) {
    const kind = e.data?.kind;
    if (kind !== "constellation" && kind !== "knows") continue;
    const a = starIndex.get(e.source);
    const b = starIndex.get(e.target);
    if (a === undefined || b === undefined) continue;
    lines.push(
      a,
      b,
      lineStyles.of([
        kind,
        String(e.style?.stroke ?? "rgba(255,255,255,0.35)"),
        Number(e.style?.opacity ?? 0.5),
        Number(e.style?.strokeWidth ?? 1),
      ])
    );
  }

  return {
    stars,
    colors: colors.values,
    names: names.values,
    washes,
    lines,
    lineStyles: lineStyles.values,
    rings,
    count: starIndex.size,
  };
}
