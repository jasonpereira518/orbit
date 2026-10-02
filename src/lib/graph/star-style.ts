/**
 * The single description of what a star looks like.
 *
 * Pure, and deliberately free of React and of any renderer. `graph-nodes.tsx` builds a
 * DOM star from this and `sky-canvas/` bakes a sprite from the same numbers, so the two
 * renderers draw the same star by construction rather than by two people keeping two
 * files in agreement.
 */
import type { ClusterLabelData, GraphNodeData } from "@/lib/graph-layout";
import { mixWithWhite } from "@/lib/school-color";

/** Star diameter in layout px, from the 1–5 orbit score. */
export function starSize(score: number) {
  return 5 + score * 2.2;
}

/**
 * How far past the star's edge a click still lands.
 *
 * A star is 7–16px in *node* space, which at the default fit view (zoom ≈ 0.11 for a
 * 114-person network) is under two screen pixels — the person is visible and, in
 * practice, unclickable. The pad extends 8px past the star's edge in every direction,
 * which is exactly half of the 18px minimum star separation that
 * `scripts/smoke-graph-layout.ts` guarantees, so no two pads can ever overlap and a
 * click still resolves to the nearest star.
 */
export const STAR_HIT_PAD = 16;

/**
 * The line under a person's name: their role, or their company when we don't
 * know what they do. Never both — one quiet line keeps the sky readable.
 */
export function starSubtitle(data: GraphNodeData) {
  const title = (data.title || "").trim();
  const company = (data.company || "").trim();
  // A role cluster is people who do the same job, so the job tells you nothing: the company does.
  return (data.clusterKind === "role" ? company || title : title || company) || null;
}

/** Petal names show once the camera is close enough to read them and the sky is not summarised. */
export const PETAL_LABEL_MIN_ZOOM = 0.25;

/** Where a petal label sits relative to the cluster name's origin, in layout px. */
export function petalLabelOffset(anchor: { x: number; y: number }, petal: { x: number; y: number }) {
  return { dx: petal.x - anchor.x, dy: petal.y - anchor.y };
}

/**
 * Whether a cluster draws its core and petal names: close enough to read, not the summary view
 * (where the cluster stands in for its people), and only while the cluster's own name won its
 * place in the collision pass — the parts' names are its detail, so they never outlive it.
 */
export function showPetalLabels(o: { zoomReached: boolean; summary: boolean; nameShown: boolean }) {
  return o.zoomReached && !o.summary && o.nameShown;
}

/**
 * The label node's geometry when it carries petal names: the cluster's whole box, with its
 * origin on the name's anchor, so the name sits exactly where it did and React Flow culls the
 * node by the cluster (the captions hang hundreds of px below the name) rather than by the name
 * alone. `undefined` for every other cluster, which keeps the name's own small box.
 */
export function petalNodeGeometry(o: {
  showPetals: boolean;
  box?: { width: number; height: number };
  anchor?: { x: number; y: number };
}) {
  if (!o.showPetals || !o.box || !o.anchor || o.box.width <= 0 || o.box.height <= 0) return undefined;
  return {
    width: o.box.width,
    height: o.box.height,
    originX: o.anchor.x / o.box.width,
    originY: o.anchor.y / o.box.height,
  };
}

/**
 * How far below its anchor a pinned name may slide, in layout px of `y`: the floor of its
 * bottom edge. The box's bottom, or just above the topmost petal name when there is one; never
 * above the anchor itself, so a petal name close under the top star cannot invert the range.
 */
export function pinnedNameFloor(
  box: { height: number },
  anchor: { y: number },
  petalTop: number | null,
  sc: number,
  gap = 4
) {
  if (petalTop === null) return box.height;
  return Math.max(anchor.y, petalTop - gap * sc);
}

/**
 * Counteract the camera a little as it pulls back.
 *
 * A star is 7–16 layout px. At the default framing of a 24-person network that is
 * 1–3 screen px, so the map opens on what looks like an empty sky — the one view a
 * first-time visitor is guaranteed to see. Growing the disc as zoom falls keeps the
 * sky legible, and the cap (+STAR_HIT_PAD, half the 18px minimum star separation the
 * layout guarantees) means two stars can never grow into each other.
 */
export function zoomRelief(disc: number, zoom: number) {
  return Math.max(1, Math.min((disc + STAR_HIT_PAD) / disc, 1 / Math.max(zoom, 0.08)));
}

export type StarVisual = {
  isComet: boolean;
  isScatter: boolean;
  /** Faint until hovered/selected/spotlit — the scatter stars' resting state. */
  dimmedScatter: boolean;
  /** Diameter from the score alone, before any dim or spotlight adjustment. */
  size: number;
  /** The diameter actually drawn. */
  disc: number;
  glow: number;
  spotlightBoost: number;
  alphaScale: number;
  /** Outer wash — the colour the glow is tinted with. */
  fill: string;
  /** Inner colour, halfway out of the radial gradient. */
  core: string;
  subtitle: string | null;
};

/**
 * Every number needed to draw one star. Figure stars carry a pastel wash of their
 * cluster's brand colour; scatter stars stay white and quiet until emphasized. Glow is
 * deliberately soft — the sky should read as a chart, not a light show.
 */
/**
 * A cluster colour's two star tints. Memoized because the canvas renderer asks for them
 * per visible star per frame of a gesture, and each `mixWithWhite` is a handful of
 * throwaway strings. Keys are the sky's cluster palette, so this stays small; the bound is
 * only a backstop.
 */
const tints = new Map<string, { fill: string; core: string }>();
const TINTS_MAX = 1024;

function tintsFor(tint: string) {
  let hit = tints.get(tint);
  if (!hit) {
    if (tints.size >= TINTS_MAX) tints.clear();
    hit = { fill: mixWithWhite(tint, 0.35), core: mixWithWhite(tint, 0.85) };
    tints.set(tint, hit);
  }
  return hit;
}

/**
 * `spotlight` overrides `data.spotlight`, so a renderer applying live search emphasis can
 * pass it without copying the whole node data per star per frame.
 */
export function starVisual(
  data: GraphNodeData,
  selected: boolean,
  spotlightOverride?: boolean
): StarVisual {
  const score = data.score || 2;
  const size = starSize(score);
  const isScatter = data.figureRole === "scatter";
  const spotlight = spotlightOverride ?? Boolean(data.spotlight);
  const dimmedScatter = isScatter && !selected && !spotlight;

  const tint = !isScatter ? data.clusterColor : undefined;
  const baseDisc = dimmedScatter ? Math.max(4, size * 0.6) : size;

  return {
    isComet: Boolean(data.comet),
    isScatter,
    dimmedScatter,
    size,
    disc: baseDisc * (spotlight ? 1.3 : 1),
    glow: Math.max(3, score * 2.2),
    // The full bloom is for a lone hit. When a search lights up a whole company, every hit
    // blooming at once merged the cluster into one white mass and buried the names.
    spotlightBoost: spotlight ? (data.spotlightSolo ? 1.9 : 1.3) : 1,
    alphaScale: dimmedScatter ? 0.55 : 1,
    fill: tint ? tintsFor(tint).fill : "#ffffff",
    core: tint ? tintsFor(tint).core : "#ffffff",
    subtitle: starSubtitle(data),
  };
}

// ---------------------------------------------------------------------------
// Who gets a name (the DOM chart)
// ---------------------------------------------------------------------------

/** A label's box in layout px. */
export type LabelBox = { x0: number; y0: number; x1: number; y1: number };

/** A star's label box as graph-nodes.tsx draws it: `max-w-[104px]`, `mt-2`, 11px + 9px lines. */
const STAR_LABEL_MAX_W = 104;
const STAR_LABEL_GAP = 8;
const STAR_LABEL_NAME_H = 14;
const STAR_LABEL_SUBTITLE_H = 12;
/** Rough glyph advances for the two label lines, to size a box without measuring DOM text. */
const STAR_LABEL_NAME_CHAR_W = 6.1;
const STAR_LABEL_SUBTITLE_CHAR_W = 4.9;

/**
 * A petal or core name's advance per character, in ems of its own font: an uppercase Outfit
 * medium averages about 0.64em, and the caption is tracked a further 0.14em (`tracking-[0.14em]`).
 */
const PETAL_NAME_CHAR_EM = 0.78;

/** The box a star's name and subtitle take under it at a zoom (scaled by `zoomRelief`). */
export function starLabelBox(
  n: { position: { x: number; y: number }; data: unknown },
  zoom: number
): LabelBox {
  const d = n.data as GraphNodeData;
  const { disc } = starVisual(d, false);
  const r = zoomRelief(disc, zoom);
  const subtitle = starSubtitle(d);
  const w =
    Math.min(
      STAR_LABEL_MAX_W,
      Math.max(
        (d.label?.length ?? 0) * STAR_LABEL_NAME_CHAR_W,
        (subtitle?.length ?? 0) * STAR_LABEL_SUBTITLE_CHAR_W
      )
    ) * r;
  const h = (STAR_LABEL_NAME_H + (subtitle ? STAR_LABEL_SUBTITLE_H : 0)) * r;
  const top = n.position.y + (disc / 2 + STAR_LABEL_GAP) * r;
  return { x0: n.position.x - w / 2, x1: n.position.x + w / 2, y0: top, y1: top + h };
}

/**
 * Every core and petal name the cluster label nodes carry, as boxes in layout px, for a caption
 * font of `fontPx` layout px (`petalNameFontPx`). Each hangs top-centre on its anchor, one line
 * (`leading-none`) tall: the label node's position less the name's anchor, plus the caption's.
 */
export function petalNameBoxes(
  labels: Iterable<{ position: { x: number; y: number }; data: unknown }>,
  fontPx: number
): LabelBox[] {
  const boxes: LabelBox[] = [];
  for (const n of labels) {
    const d = n.data as ClusterLabelData;
    if (!d.anchor || !d.petalLabels?.length) continue;
    for (const pl of d.petalLabels) {
      const x = n.position.x - d.anchor.x + pl.anchor.x;
      const y = n.position.y - d.anchor.y + pl.anchor.y;
      const half = (pl.label.length * fontPx * PETAL_NAME_CHAR_EM) / 2;
      boxes.push({ x0: x - half, x1: x + half, y0: y, y1: y + fontPx });
    }
  }
  return boxes;
}

/**
 * Which stars get a name, so no two names overlap.
 *
 * Labels are drawn in layout px and hang under their star, so two names that collide collide at
 * every zoom — a dense cluster (a big employer, say) became an unreadable smear of overlapping
 * names and titles. This places them greedily in priority order — search hits, then orbit score —
 * and a name that would overlap one already placed is left off. Hover or select any star to read
 * its name regardless (those are pinned, and not part of this pass).
 *
 * `reserved` are boxes already spoken for that are drawn whatever this pass decides — the core
 * and petal names (`petalNameBoxes`). They go in after the search hits and before every other
 * star, so a hit is still named but an ordinary star whose name would land on one is not.
 *
 * A uniform grid keeps it linear: each box is tested only against boxes in the cells it touches.
 */
export function starLabelWinners(
  contacts: Iterable<{ id: string; position: { x: number; y: number }; data: unknown }>,
  zoom: number,
  isHit: (id: string) => boolean,
  reserved: readonly LabelBox[] = []
): Set<string> {
  const candidates: Array<{ id: string; box: LabelBox; hit: boolean; score: number }> = [];
  let cellW = STAR_LABEL_MAX_W;
  for (const n of contacts) {
    const box = starLabelBox(n, zoom);
    cellW = Math.max(cellW, box.x1 - box.x0);
    candidates.push({
      id: n.id,
      box,
      hit: isHit(n.id),
      score: (n.data as GraphNodeData).score ?? 0,
    });
  }
  for (const b of reserved) cellW = Math.max(cellW, b.x1 - b.x0);
  candidates.sort(
    (a, b) =>
      Number(b.hit) - Number(a.hit) || b.score - a.score || (a.id < b.id ? -1 : 1)
  );

  const cellH = (STAR_LABEL_NAME_H + STAR_LABEL_SUBTITLE_H) * 2;
  const grid = new Map<string, LabelBox[]>();
  const cellsOf = (box: LabelBox) => {
    const keys: string[] = [];
    for (let gx = Math.floor(box.x0 / cellW); gx <= Math.floor(box.x1 / cellW); gx++) {
      for (let gy = Math.floor(box.y0 / cellH); gy <= Math.floor(box.y1 / cellH); gy++) {
        keys.push(`${gx},${gy}`);
      }
    }
    return keys;
  };
  const place = (box: LabelBox, keys: string[]) => {
    for (const key of keys) {
      const cell = grid.get(key);
      if (cell) cell.push(box);
      else grid.set(key, [box]);
    }
  };
  let reservedPlaced = reserved.length === 0;
  const winners = new Set<string>();
  for (const c of candidates) {
    if (!reservedPlaced && !c.hit) {
      for (const b of reserved) place(b, cellsOf(b));
      reservedPlaced = true;
    }
    const keys = cellsOf(c.box);
    const clear = keys.every((key) =>
      (grid.get(key) ?? []).every(
        (o) => !(c.box.x0 < o.x1 && c.box.x1 > o.x0 && c.box.y0 < o.y1 && c.box.y1 > o.y0)
      )
    );
    if (!clear) continue;
    winners.add(c.id);
    place(c.box, keys);
  }
  return winners;
}
