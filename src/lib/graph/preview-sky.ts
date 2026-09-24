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
  STAR_SCATTER,
  type PreviewLineStyle,
  type PreviewSky,
} from "@/lib/graph/preview-sky-shape";

export type { PreviewSky } from "@/lib/graph/preview-sky-shape";

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * How much of a brand's colour the card keeps.
 *
 * A shade under full. The tab is a place you go to read your network and its clusters are meant
 * to be told apart at a glance; the card is a quiet tile on a dashboard next to plain text, and
 * at full strength its handful of saturated figures shouted over everything around them. Pulled
 * a little toward each colour's own grey — still plainly Carolina blue and Stripe violet, just
 * no longer the loudest thing on the page. The tab is untouched: this is the card's palette.
 */
const PREVIEW_CHROMA = 0.85;

/** Toward a colour's own grey, keeping its brightness (and any alpha it carries). */
function muted(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i.exec(
    color.trim()
  );
  let r: number;
  let g: number;
  let b: number;
  let alpha: string | null = null;
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16);
    g = parseInt(hex[1].slice(2, 4), 16);
    b = parseInt(hex[1].slice(4, 6), 16);
  } else if (rgba) {
    r = Number(rgba[1]);
    g = Number(rgba[2]);
    b = Number(rgba[3]);
    alpha = rgba[4] ?? null;
  } else {
    // A colour this does not understand is left exactly as it is.
    return color;
  }
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const pull = (c: number) => Math.round(grey + (c - grey) * PREVIEW_CHROMA);
  const [mr, mg, mb] = [pull(r), pull(g), pull(b)];
  return alpha === null
    ? `#${[mr, mg, mb].map((c) => c.toString(16).padStart(2, "0")).join("")}`
    : `rgba(${mr}, ${mg}, ${mb}, ${alpha})`;
}

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
  // Every colour the card draws goes through the palette, so muting it here covers the stars,
  // their bloom (mixed from the same tint) and the clusters' washes in one place.
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
      // No overdue flag: its ring is a status marker for the chart, and at card scale it only
      // read as a stray donut on a star.
      const flags = (d.figureRole === "scatter" ? STAR_SCATTER : 0) | (d.comet ? STAR_COMET : 0);
      stars.push(
        x,
        y,
        d.score ?? 2,
        d.clusterColor ? colors.of(muted(d.clusterColor)) : -1,
        flags,
        // Only a comet's tail reads its angle.
        d.comet ? Math.round((d.orbitAngle ?? 0) * 100) : 0
      );
    } else if (n.type === "nebula") {
      const d = n.data as NebulaData;
      washes.push(x, y, round(d.radius), colors.of(muted(d.color)), names.of(d.company));
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
        muted(String(e.style?.stroke ?? "rgba(255,255,255,0.35)")),
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
