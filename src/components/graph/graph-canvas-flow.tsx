"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  useStore,
  useStoreApi,
  type Node,
  type Edge,
  type DefaultEdgeOptions,
  type EdgeTypes,
  type NodeMouseHandler,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ClusterLabelNode,
  ContactNode,
  LabeledEdge,
  NebulaWashNode,
  OrbitRingsNode,
  StarDustNode,
  SunNode,
  CLUSTER_NAME_PIN_MIN_ZOOM,
  clusterNameSize,
  type NebulaWashCluster,
  type NebulaWashData,
  type StarDustData,
  type StarDustPoint,
} from "@/components/graph/graph-nodes";
import type {
  GraphChartProps,
  GraphPayload,
} from "@/components/graph/graph-chart-types";
import { setCameraMoving } from "@/components/graph/camera-motion";
import { useGraphLayout } from "@/components/graph/use-graph-layout";
import {
  buildHybridGraphLayout,
  type ClusterLabelData,
  type GraphNodeData,
  type NebulaData,
} from "@/lib/graph-layout";
import {
  SKY_MAX_ZOOM,
  SKY_MIN_ZOOM,
  computeSunExtents,
  zoomToFitSunCentered,
} from "@/lib/graph/sky-camera";
import { NEBULA_BOX_RADII } from "@/lib/graph/nebula-lobes";
import { contactMatchesLocal } from "@/lib/graph/search-match";
import {
  clusterEmphasis,
  edgeEmphasis,
  starEmphasis,
  type SkyFocusState,
} from "@/lib/graph/sky-emphasis";
import {
  clusterIdFromNodeId,
  selectionForContact,
  selectionForUser,
} from "@/lib/graph/sky-selection";
import { starSubtitle, starVisual, zoomRelief } from "@/lib/graph/star-style";
import { markGraphViewportReady } from "@/lib/graph/intro-signal";
import { markOpenStage } from "@/lib/graph/open-marks";
import { markFirstPaintThenInteractive } from "@/lib/graph/open-marks-paint";
import { CAMERA_MS } from "@/lib/motion";
import { Loader2 } from "lucide-react";

type LayoutNodes = ReturnType<typeof buildHybridGraphLayout>["nodes"];

/**
 * Sole owner of the default view: sun locked to viewport center.
 * Mount with a key that changes on every Home click and every change of who is in the sky,
 * so each one gets a fresh apply (avoids cancelled effects / stale appliedToken races).
 */
function DefaultViewFitter({
  homeToken,
  animate,
  layoutNodes,
  onSettled,
}: {
  homeToken: number;
  /** Glide there rather than cut. False for the very first framing, which nobody sees. */
  animate: boolean;
  layoutNodes: LayoutNodes;
  /**
   * Fires once the *refined* (post-measurement) framing has been applied.
   * The first pass runs before React Flow has measured node DOM sizes, so
   * it frames too tight; callers should stay hidden until this fires to
   * avoid painting that too-tight frame.
   */
  onSettled?: () => void;
}) {
  const { setCenter } = useReactFlow();
  const storeApi = useStoreApi();
  // React Flow's own nodes, not the ones it was handed: those no longer carry the measured
  // boxes this framing reads (see `Measurements`); React Flow's copies always do.
  const liveNodes = () => [...storeApi.getState().nodeLookup.values()];
  const layoutRef = useRef(layoutNodes);
  const onSettledRef = useRef(onSettled);
  layoutRef.current = layoutNodes;
  onSettledRef.current = onSettled;

  useEffect(() => {
    if (homeToken <= 0) return;

    let cancelled = false;
    let tries = 0;
    let timeoutId: number | undefined;
    let rafId: number | undefined;

    const centerNow = () => {
      if (cancelled) return;
      const { width, height, panZoom } = storeApi.getState();
      if (!panZoom || width < 48 || height < 48) {
        if (tries < 80) {
          tries += 1;
          timeoutId = window.setTimeout(centerNow, 32);
        }
        return;
      }

      const { maxAbsX, maxAbsY } = computeSunExtents(layoutRef.current, liveNodes());
      const zoom = zoomToFitSunCentered(maxAbsX, maxAbsY, width, height);
      const duration = animate ? CAMERA_MS.move : 0;

      void setCenter(0, 0, { zoom, duration }).then((ok) => {
        if (cancelled) return;
        if (!ok) {
          if (tries < 80) {
            tries += 1;
            timeoutId = window.setTimeout(centerNow, 32);
          }
          return;
        }
        // One refine once the nodes are measured (no animation) — the first
        // pass above ran before they were, so it can under-estimate extents
        // and frame too tight. This is the frame callers should actually
        // reveal.
        //
        // React Flow measures nodes with a ResizeObserver, which reports in the
        // frame they first lay out — after that frame's rAF callbacks — so the
        // sizes are in its store by the next frame's. This was a flat 100ms,
        // which on opening the chart was most of the wait between the sky
        // being ready and it being shown.
        const refine = () => {
          if (cancelled) return;
          const size = storeApi.getState();
          if (size.width < 48 || size.height < 48) {
            onSettledRef.current?.();
            return;
          }
          const extents = computeSunExtents(layoutRef.current, liveNodes());
          const z = zoomToFitSunCentered(
            extents.maxAbsX,
            extents.maxAbsY,
            size.width,
            size.height
          );
          void setCenter(0, 0, { zoom: z, duration: 0 }).then(() => {
            if (cancelled) return;
            onSettledRef.current?.();
          });
        };
        rafId = requestAnimationFrame(() => {
          rafId = requestAnimationFrame(refine);
        });
      });
    };

    // Defer one frame so pane dimensions are current after filter resets
    timeoutId = window.setTimeout(centerNow, animate ? 40 : 0);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
    // Mounted fresh per request (see the key at the call site) — refs hold the rest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeToken]);

  return null;
}

const nodeTypes = {
  contact: ContactNode,
  user: SunNode,
  orbitRings: OrbitRingsNode,
  clusterLabel: ClusterLabelNode,
  nebulaWash: NebulaWashNode,
  starDust: StarDustNode,
};

const edgeTypes: EdgeTypes = {
  labeled: LabeledEdge,
  straight: LabeledEdge,
};

/*
 * Module constants, not inline literals: React Flow copies these props into its store whenever
 * their identity changes (its StoreUpdater compares by reference), and every store write runs
 * every drawn node's, edge's and handle's selector. Inline, each re-render of the chart — one a
 * frame while stars mount during a zoom — made two such writes for nothing.
 */
const NODE_ORIGIN: [number, number] = [0.5, 0.5];
const NO_EDGES: Edge[] = [];
const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = {
  type: "straight",
  selectable: false,
  focusable: false,
};

/**
 * The zoomed-out summary view.
 *
 * Far out, a star is a dot one or two pixels across with no name (labels unmount below 0.1,
 * see graph-nodes.tsx) and a hit target too small to click — yet each one was still a React
 * Flow node with its own DOM, style and raster. Past a few hundred people that is where the
 * chart's cost went, and past ~2,500 the DOM alone was the ceiling. So below
 * SUMMARY_ENTER_ZOOM the individual stars leave the DOM: every cluster's name carries its
 * headcount, clicking one flies into it, and everybody is still drawn — as one canvas of
 * dots behind the clusters (`StarDustNode`). Anyone the reader asked about (hovered,
 * selected, a search hit, a Re-engage peek) stays a real star at every zoom.
 *
 * The two thresholds differ so a zoom resting on the boundary cannot flap between views.
 * Small skies never summarise: a hundred-person chart costs little and reads best as stars.
 */
const SUMMARY_ENTER_ZOOM = 0.1;
const SUMMARY_EXIT_ZOOM = 0.13;
const SUMMARY_MIN_CONTACTS = 400;
/**
 * In the summary view, search hits become real stars only when there are this few of them.
 * A search matches broadly while it is being typed — "a" matched 1,953 of 2,500 people — and
 * mounting every hit meant each keystroke built or tore down thousands of stars, a 300–450ms
 * stall apiece. Past this, hits stay dots, drawn brighter while the rest of the sky dims.
 */
const SUMMARY_MOUNT_HITS_MAX = 60;

/**
 * Stars handed to React Flow per frame, nearest the middle of the view first.
 *
 * Mounting a star costs about a millisecond of style, layout and paint. Leaving the summary used
 * to mount every star in view in one commit — 350 of them after searching a big company at 2,500
 * contacts, one 300ms frame, 650ms at 5,000 — so a smooth camera flight ended in a freeze. The
 * dust canvas stays underneath while they arrive, so nobody is missing in the meantime.
 *
 * Half that while the camera moves: a moving frame is already paying for the camera, and a full
 * batch on top of it took 33ms — every other frame dropped on the way in from the whole sky.
 * Arriving takes twice as many frames, which nobody sees, because the dots are drawn underneath.
 */
const STAR_MOUNT_BATCH = 32;
const STAR_MOUNT_BATCH_MOVING = 16;

/**
 * Large skies hand React Flow only the stars in and around the view: the viewport grown by this
 * fraction of its size on every side. `onlyRenderVisibleElements` cannot do this alone — React
 * Flow renders every node it has never measured once, to measure it, so giving it the whole sky
 * mounted thousands of far-off stars in a single frame just to unmount them again.
 */
const STAR_WINDOW_MARGIN = 0.25;
/** The window moves once the view strays past this much of that margin, or zooms a step. */
const STAR_WINDOW_SLACK = 0.25;
/** The most real stars the window hands over; past this, window members stay dots. */
const STAR_WINDOW_MAX = 450;
/** Stars removed per frame when the window lets go of them, e.g. on the way back to the whole sky. */
const STAR_UNMOUNT_BATCH = 48;


/**
 * How far the camera may zoom out from the window's own zoom before the dots are needed.
 *
 * The window is the view grown by STAR_WINDOW_MARGIN on every side, so it still covers the
 * screen after zooming out by half that again. Past it, the stars it chose no longer reach the
 * edges of the view, and the dust canvas draws everyone underneath until the window catches up.
 */
const STAR_WINDOW_OUTRUN = 1 / (1 + STAR_WINDOW_MARGIN * 2);

type WorldRect = { x0: number; y0: number; x1: number; y1: number; zoom: number };

function viewportWorldRect(
  transform: [number, number, number],
  width: number,
  height: number,
  grow: number
): WorldRect {
  const [tx, ty, k] = transform;
  const w = width / k;
  const h = height / k;
  const x = -tx / k;
  const y = -ty / k;
  return { x0: x - w * grow, y0: y - h * grow, x1: x + w * (1 + grow), y1: y + h * (1 + grow), zoom: k };
}

/** How long after the camera stops before it counts as stopped — see `setMoving`. */
const MOVE_SETTLE_MS = 120;

/** A refresh or filter that brings in more people than this skips the entrance animation. */
const ENTRANCE_MAX = 400;
/** How long a newly arrived star keeps its entrance class (the animation is 450ms). */
const ENTRANCE_CLEAR_MS = 700;

const STAR_DUST_ID = "star-dust";
const NEBULA_WASH_ID = "nebula-wash";

/** Below this zoom, cluster names keep much wider gaps between them (see `clusterNameWinners`). */
const CLUSTER_NAME_SPARSE_BELOW_ZOOM = 0.2;
/** Below that zoom, at most this many of the largest clusters are considered for a name. */
const CLUSTER_NAME_SPARSE_MAX = 36;
/**
 * At the home framing itself, a few more names than that, with slightly tighter gaps.
 *
 * Home is the one view that is only ever read — the whole sky in the pane, nothing to aim at —
 * so it can carry a longer legend. One step in from home the sky is something you are moving
 * through, and names appearing and vanishing as you go reads worse than a shorter list, so the
 * number above takes over again.
 */
const CLUSTER_NAME_HOME_MAX = 56;
/** How far in from the home zoom still counts as home; `zoomStep`'s steps are about 1.19x. */
const CLUSTER_NAME_HOME_SLACK = 1.12;

/**
 * How far from a cluster's centre still counts as pointing at it, in cluster radii.
 *
 * A shade past where its stars reach, so the name answers a pointer resting just off the edge
 * of the group, and well short of the wash's own box, which is four radii across.
 */
const CLUSTER_HOVER_REACH = 1.15;

/** A label's box in layout px, as graph-nodes.tsx draws it: `max-w-[104px]`, `mt-2`, 11px + 9px lines. */
const LABEL_MAX_W = 104;
const LABEL_GAP = 8;
const LABEL_NAME_H = 14;
const LABEL_SUBTITLE_H = 12;
/** Rough glyph advances for the two label lines, to size a box without measuring DOM text. */
const LABEL_NAME_CHAR_W = 6.1;
const LABEL_SUBTITLE_CHAR_W = 4.9;

/**
 * Which cluster names are shown, so none overlap.
 *
 * Names are drawn at a readable size however far out the camera is (see `clusterNameScale`),
 * and a zoomed-out sky has hundreds of clusters, so they cannot all fit. They are placed in
 * priority order — the one under the pointer, then the highlighted cluster, then the largest —
 * and a name that would overlap one already placed is left off until zooming in makes room.
 * Grid-bucketed, so linear.
 */
function clusterNameWinners(
  labels: LayoutNodes,
  zoom: number,
  withCount: boolean,
  highlighted: string | null,
  hovered: string | null,
  atHome: boolean
): Set<string> {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const sparse = zoom < CLUSTER_NAME_SPARSE_BELOW_ZOOM;
  const home = sparse && atHome;
  const spacing = sparse
    ? home
      ? { x: 1.6, y: 2.2 }
      : { x: 1.9, y: 2.6 }
    : { x: 1.15, y: 1.15 };
  // Far out, only the largest clusters compete for a name at all: a gap on the far side of the
  // sky is no reason to label a two-person cluster while the view is about the big picture.
  const eligible = sparse
    ? new Set(
        [...labels]
          .sort(
            (a, b) =>
              ((b.data as ClusterLabelData).count ?? 0) -
              ((a.data as ClusterLabelData).count ?? 0)
          )
          .slice(0, home ? CLUSTER_NAME_HOME_MAX : CLUSTER_NAME_SPARSE_MAX)
          .map((n) => n.id)
      )
    : null;
  const candidates = labels
    .filter(
      (n) =>
        !eligible ||
        eligible.has(n.id) ||
        (n.data as ClusterLabelData).label === highlighted ||
        (n.data as ClusterLabelData).label === hovered
    )
    .map((n) => {
      const d = n.data as ClusterLabelData;
      const { width, height } = clusterNameSize(d.label, withCount && Boolean(d.count), zoom);
      // Air between neighbours, and slack for zooms between two steps. Far out, where a whole
      // sky of clusters competes for the space, much more of it: a legend of a few well-spaced
      // names reads, a wall of them does not.
      const w = width * spacing.x;
      const h = height * spacing.y;
      const box: Box = {
        x0: n.position.x - w / 2,
        x1: n.position.x + w / 2,
        y0: n.position.y - h,
        y1: n.position.y,
      };
      return { id: n.id, box, first: d.label === highlighted, count: d.count ?? 0 };
    })
    .sort(
      (a, b) =>
        Number(b.first) - Number(a.first) || b.count - a.count || (a.id < b.id ? -1 : 1)
    );
  const cell = Math.max(1, ...candidates.map((c) => c.box.x1 - c.box.x0));
  const grid = new Map<string, Box[]>();
  const shown = new Set<string>();
  for (const c of candidates) {
    const gx0 = Math.floor(c.box.x0 / cell);
    const gx1 = Math.floor(c.box.x1 / cell);
    const gy0 = Math.floor(c.box.y0 / cell);
    const gy1 = Math.floor(c.box.y1 / cell);
    let clear = true;
    for (let gx = gx0; clear && gx <= gx1; gx++) {
      for (let gy = gy0; clear && gy <= gy1; gy++) {
        for (const o of grid.get(`${gx},${gy}`) ?? []) {
          if (c.box.x0 < o.x1 && c.box.x1 > o.x0 && c.box.y0 < o.y1 && c.box.y1 > o.y0) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear && !c.first) continue;
    shown.add(c.id);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const list = grid.get(key);
        if (list) list.push(c.box);
        else grid.set(key, [c.box]);
      }
    }
  }
  // Point at a cluster and you get its name whether or not it won a place — but added after
  // the pass, not before it, so the names already on the sky stay where they are rather than
  // blinking out as the pointer travels. It is drawn above them (see `nameRaised`).
  if (hovered) {
    for (const n of labels) {
      if ((n.data as ClusterLabelData).label === hovered) {
        shown.add(n.id);
        break;
      }
    }
  }
  return shown;
}

/**
 * The camera's zoom in quarter-octave steps. Label boxes scale with `zoomRelief`, so the
 * collision pass depends on zoom — but only coarsely, and recomputing per wheel tick would
 * re-render stars on every frame of a zoom.
 */
function zoomStep(zoom: number) {
  return Math.pow(2, Math.round(Math.log2(Math.max(zoom, 0.01)) * 4) / 4);
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
 * A uniform grid keeps it linear: each box is tested only against boxes in the cells it touches.
 */
function labelWinners(
  contacts: Iterable<LayoutNodes[number]>,
  zoom: number,
  isHit: (id: string) => boolean
): Set<string> {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const candidates: Array<{ id: string; box: Box; hit: boolean; score: number }> = [];
  let cellW = LABEL_MAX_W;
  for (const n of contacts) {
    const d = n.data as GraphNodeData;
    const { disc } = starVisual(d, false);
    const r = zoomRelief(disc, zoom);
    const subtitle = starSubtitle(d);
    const w =
      Math.min(
        LABEL_MAX_W,
        Math.max(
          (d.label?.length ?? 0) * LABEL_NAME_CHAR_W,
          (subtitle?.length ?? 0) * LABEL_SUBTITLE_CHAR_W
        )
      ) * r;
    const h = (LABEL_NAME_H + (subtitle ? LABEL_SUBTITLE_H : 0)) * r;
    const top = n.position.y + (disc / 2 + LABEL_GAP) * r;
    cellW = Math.max(cellW, w);
    candidates.push({
      id: n.id,
      box: { x0: n.position.x - w / 2, x1: n.position.x + w / 2, y0: top, y1: top + h },
      hit: isHit(n.id),
      score: d.score ?? 0,
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.hit) - Number(a.hit) || b.score - a.score || (a.id < b.id ? -1 : 1)
  );

  const cellH = (LABEL_NAME_H + LABEL_SUBTITLE_H) * 2;
  const grid = new Map<string, Box[]>();
  const winners = new Set<string>();
  for (const c of candidates) {
    const gx0 = Math.floor(c.box.x0 / cellW);
    const gx1 = Math.floor(c.box.x1 / cellW);
    const gy0 = Math.floor(c.box.y0 / cellH);
    const gy1 = Math.floor(c.box.y1 / cellH);
    let clear = true;
    for (let gx = gx0; clear && gx <= gx1; gx++) {
      for (let gy = gy0; clear && gy <= gy1; gy++) {
        for (const o of grid.get(`${gx},${gy}`) ?? []) {
          if (c.box.x0 < o.x1 && c.box.x1 > o.x0 && c.box.y0 < o.y1 && c.box.y1 > o.y0) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) continue;
    winners.add(c.id);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const cell = grid.get(key);
        if (cell) cell.push(c.box);
        else grid.set(key, [c.box]);
      }
    }
  }
  return winners;
}
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The last emphasised copy made of each structural node or edge, and what it was made for.
 *
 * Keyed weakly by the structural object, so an entry lives exactly as long as the node it
 * decorates: a layout change produces new structural objects only for the nodes it actually
 * changed, and the old entries are simply collected. `key` encodes every value the copy was
 * built from; the same key means the same copy, and React Flow sees an unchanged object.
 */
const emphasisCache = new WeakMap<object, { key: string; value: unknown }>();

function withEmphasis<T>(base: object, key: string, build: () => T): T {
  const hit = emphasisCache.get(base);
  if (hit && hit.key === key) return hit.value as T;
  const value = build();
  emphasisCache.set(base, { key, value });
  return value;
}

function shallowEqualData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (av === bv) continue;
    // Tags and key facts arrive as fresh arrays on every payload.
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length || av.some((v, i) => v !== bv[i])) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * The layout as React Flow nodes, reusing last time's object for every node that did not change.
 *
 * A refresh batch used to remount the entire chart. Now the new layout is reconciled against
 * the nodes already on screen: a node whose type, position and data are unchanged keeps its
 * object — and with it React Flow's measured size and the memoised component — so a batch that
 * touched eight people re-renders eight stars, not all of them. A changed node still inherits
 * its predecessor's measured box (from `measured`, see `Measurements`), which React Flow
 * otherwise forgets and re-measures.
 */
function buildStructuralNodes(
  layoutNodes: LayoutNodes,
  previous: Node[] | null,
  measured: Measurements
): Node[] {
  const prevById = previous ? new Map(previous.map((n) => [n.id, n])) : null;
  return layoutNodes.map((n) => {
    const prev = prevById?.get(n.id);
    if (
      prev &&
      prev.type === n.type &&
      prev.position.x === n.position.x &&
      prev.position.y === n.position.y &&
      shallowEqualData(prev.data, n.data)
    ) {
      return prev;
    }
    return {
      ...n,
      draggable: false,
      ...(prev && prev.type === n.type ? measuredOf(measured, n.id) : null),
    } as Node;
  });
}

/**
 * React Flow's measured size of each node, kept beside the nodes rather than in them.
 *
 * React Flow keeps a node's measured box itself for as long as it is handed the same node
 * object, and reports each new measurement through `onNodesChange`. Applying those reports to
 * the sky's own nodes (as this did) made every measurement a state update that rebuilt every
 * node and edge: each batch of stars mounting on the way in from the whole sky cost two full
 * commits a frame — one to mount them, one when they were measured — and every cluster name
 * resizing at a zoom step cost one more. Kept here instead, a measurement changes nothing React
 * renders; a node object that IS rebuilt (its emphasis changed) carries its box from here, so
 * React Flow never forgets it and never re-measures.
 */
type Measurements = Map<string, { width: number; height: number }>;

function measuredOf(measured: Measurements, id: string) {
  const box = measured.get(id);
  return box ? { measured: box } : null;
}

/**
 * `list`, or the previous array when every element is the same object in the same order.
 *
 * React Flow stores `nodes` and `edges` whenever the array's identity changes, and each store
 * write runs every drawn node's and edge's selector. The memos that build them rebuild on inputs
 * that often leave the result unchanged — every mount batch recomputes the edges, most of which
 * add no line — and a new array with the same elements was still a write.
 */
function useSameArrayIfUnchanged<T>(list: T[]): T[] {
  const [kept, setKept] = useState(list);
  if (kept === list) return kept;
  if (kept.length === list.length && kept.every((item, i) => item === list[i])) return kept;
  setKept(list);
  return list;
}

/**
 * The nodes to hand React Flow: `nodes`, plus whatever just left it, kept one more commit as
 * `hidden`.
 *
 * React Flow drops a removed node from its store the moment it receives the new list, but the
 * node's wrapper is still mounted and subscribed until React unmounts it, and the wrapper's
 * selector reads `nodeLookup.get(id).internals` — a TypeError for every removed node on every
 * store update in between. React catches each one, but an exception captures a stack: entering
 * the summary view (hundreds of stars leaving over a few frames) threw ~600 of them and cost
 * frames of 30–250ms. A hidden node is still in the store, so its wrapper unmounts cleanly
 * (hidden nodes are not visible ones); it is dropped at the next change, by which time nothing
 * is subscribed to it. Nothing is drawn differently: a hidden node renders nothing.
 */
function useHiddenBeforeRemoved(nodes: Node[]): Node[] {
  const [handed, setHanded] = useState<{ from: Node[]; out: Node[] }>(() => ({
    from: nodes,
    out: nodes,
  }));
  if (handed.from === nodes) return handed.out;
  const staying = new Set(nodes.map((n) => n.id));
  const leaving = handed.from.filter((n) => !staying.has(n.id) && !n.hidden);
  const out =
    leaving.length === 0
      ? nodes
      : [...nodes, ...leaving.map((n) => ({ ...n, hidden: true }))];
  setHanded({ from: nodes, out });
  return out;
}

type SkyState = {
  layout: ReturnType<typeof buildHybridGraphLayout>;
  layoutKey: string;
  /** Bumped whenever the set of people drawn changes, which re-frames the camera. */
  epoch: number;
  nodes: Node[];
  /** Contacts that just arrived and should play the entrance once. */
  entering: ReadonlySet<string>;
};

function contactIds(nodes: LayoutNodes) {
  const ids: string[] = [];
  for (const n of nodes) if (n.type === "contact") ids.push(n.id);
  return ids;
}

/**
 * The React Flow constellation: the desktop chart, in its own lazily-imported chunk.
 *
 * The chunk boundary is the point of this file. `@xyflow/react` plus the DOM node
 * renderers are the bulk of the graph bundle, and on a phone none of it is downloaded,
 * parsed, or mounted — `network-graph.tsx` picks this or `GraphCanvasMobile` and only
 * the chosen one is ever imported.
 */
export function GraphCanvasFlow(props: GraphChartProps) {
  markOpenStage("renderer-loaded");
  const { filteredContacts, layout, layoutKey } = useGraphLayout(props);

  // Deliberately not keyed on the layout. Remounting per change — which a refresh did once
  // per batch — tore down and rebuilt every star, replayed every entrance animation (a
  // compositor layer per star while it ran) and snapped the camera home under the reader.
  return (
    <ReactFlowProvider>
      <GraphCanvasInner
        {...props}
        filteredContacts={filteredContacts}
        layout={layout}
        layoutKey={layoutKey}
      />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({
  company,
  search,
  searchHitIds,
  focusCluster,
  zoomToken,
  homeToken,
  peekPersonId,
  peekToken,
  selection,
  hoveredId,
  onSelect,
  onHover,
  onFocusCluster,
  filteredContacts,
  layout,
  layoutKey,
  compact,
  data,
  constellationFilterOn,
  onShowAll,
  loadingAll,
}: GraphChartProps & {
  filteredContacts: GraphPayload["contacts"];
  layout: ReturnType<typeof buildHybridGraphLayout>;
  layoutKey: string;
}) {
  const router = useRouter();
  const {
    fitView,
    fitBounds,
    getNodes,
    getViewport,
    setViewport,
    screenToFlowPosition,
  } = useReactFlow();
  const storeApi = useStoreApi();
  const prevClusterZoomKey = useRef("");
  const prevPeekZoomKey = useRef("");

  // Mutable on purpose, and never a render input — see `Measurements`.
  const [measured] = useState<Measurements>(() => new Map());

  const [sky, setSky] = useState<SkyState>(() => {
    const ids = contactIds(layout.nodes);
    return {
      layout,
      layoutKey,
      epoch: 0,
      nodes: buildStructuralNodes(layout.nodes, null, measured),
      entering: ids.length <= ENTRANCE_MAX ? new Set(ids) : NO_IDS,
    };
  });

  // Reconcile a new layout during render rather than in an effect, so React Flow is never
  // handed a frame of the old sky alongside the new chrome.
  if (sky.layout !== layout) {
    const before = new Set(contactIds(sky.layout.nodes));
    const added = contactIds(layout.nodes).filter((id) => !before.has(id));
    setSky({
      layout,
      layoutKey,
      epoch: sky.layoutKey === layoutKey ? sky.epoch : sky.epoch + 1,
      nodes: buildStructuralNodes(layout.nodes, sky.nodes, measured),
      entering:
        added.length > 0 && added.length <= ENTRANCE_MAX ? new Set(added) : NO_IDS,
    });
  }
  const orbitNodes = sky.nodes;

  /**
   * The initial framing pass runs before React Flow has measured node DOM sizes, so it
   * frames too tight, then snaps out to the correct view ~100ms later — a visible
   * double-zoom jump. Stay hidden (chrome and starfield stay visible; only the graph
   * itself is gated) until DefaultViewFitter confirms the refined frame is applied. A
   * safety timeout reveals regardless so a stalled measurement never hides the sky forever.
   */
  const [viewportReady, setViewportReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setViewportReady(true), 1500);
    return () => window.clearTimeout(t);
  }, []);

  /**
   * Tell the intro the chart is genuinely visible, so it can begin its collapse.
   *
   * One effect covers both sources of `viewportReady` — the fitter settling and the 1500ms
   * safety timer — since neither does anything but set this flag. A ready signal can only END
   * an intro run, never start one.
   */
  useEffect(() => {
    if (!viewportReady) return;
    markGraphViewportReady();
    markFirstPaintThenInteractive();
  }, [viewportReady]);

  // The entrance plays once per arrival; drop the class afterwards so a star scrolled back
  // into view (and so remounted, under onlyRenderVisibleElements) does not replay it.
  useEffect(() => {
    if (sky.entering.size === 0 || !viewportReady) return;
    const entering = sky.entering;
    const t = window.setTimeout(() => {
      setSky((s) => (s.entering === entering ? { ...s, entering: NO_IDS } : s));
    }, ENTRANCE_CLEAR_MS);
    return () => window.clearTimeout(t);
  }, [sky.entering, viewportReady]);

  /** Summary view (see SUMMARY_ENTER_ZOOM): on for large skies until the camera says otherwise. */
  const summaryAllowed = !compact && filteredContacts.length > SUMMARY_MIN_CONTACTS;
  const [summaryWanted, setSummaryWanted] = useState(summaryAllowed);
  useEffect(() => {
    if (!summaryAllowed) return;
    // Wait for the first real framing: before it the viewport sits at React Flow's zoom 1,
    // which would mount every star just to unmount them a frame later.
    if (!viewportReady) return;
    const check = (zoom: number) =>
      setSummaryWanted((was) =>
        was ? zoom < SUMMARY_EXIT_ZOOM : zoom < SUMMARY_ENTER_ZOOM
      );
    // The answer can only change where the zoom crosses one of the two thresholds, so only a
    // crossing asks. Calling the setter on every camera update — every wheel event of a pinch —
    // re-ran this whole component each time just to find nothing had changed.
    let last = storeApi.getState().transform[2];
    check(last);
    return storeApi.subscribe((s) => {
      const zoom = s.transform[2];
      if (zoom === last) return;
      const crossed =
        zoom < SUMMARY_ENTER_ZOOM !== last < SUMMARY_ENTER_ZOOM ||
        zoom < SUMMARY_EXIT_ZOOM !== last < SUMMARY_EXIT_ZOOM;
      last = zoom;
      if (crossed) check(zoom);
    });
  }, [summaryAllowed, viewportReady, storeApi]);
  const summary = summaryAllowed && summaryWanted;

  // From the layout rather than `orbitNodes`: positions and data are the same, and this way
  // React Flow reporting a measurement does not rebuild it.
  const skyLayoutNodes = sky.layout.nodes;
  const contactById = useMemo(() => {
    const map = new Map<string, LayoutNodes[number]>();
    for (const n of skyLayoutNodes) if (n.type === "contact") map.set(n.id, n);
    return map;
  }, [skyLayoutNodes]);

  /**
   * The star window (see STAR_WINDOW_MARGIN): large skies, outside the summary view.
   *
   * `starWindow` is the world rect React Flow may draw stars from; it moves only when the camera
   * strays out of its slack or zooms a quarter-octave, so a pan is not a re-render. At most
   * STAR_WINDOW_MAX of its stars — nearest the centre — become real stars; the rest stay dots on
   * the dust canvas, which at the zooms where a window holds that many look the same.
   *
   * `mounted` is what has actually been handed to React Flow. It moves toward the target a batch
   * per frame in both directions: STAR_MOUNT_BATCH added, STAR_UNMOUNT_BATCH removed. Removing
   * all at once was the lag on the way back out to the whole sky — a 183ms frame dropping 500
   * stars — and it is never reset, so crossing back and forth keeps what is already there.
   *
   * A zoom holds the window still until it stops (`movingRef`). Measured on a zoom from the
   * whole sky to a close-up and back: every frame that mounted or dropped a star cost 22-26ms
   * on average against a flat 17ms for the frames that did not, and re-choosing the window at
   * each zoom step made 853 of them. A pan still moves the window as it goes — panning changes
   * which stars are worth having, and is cheap enough to do live — but while the camera is
   * scaling, the stars already up are simply carried along, and the dots cover the rest.
   */
  /**
   * The cluster under the pointer, which says its name for as long as you point at it — the one
   * name a reader has asked for directly. It is only a name: pinning it in view, the way the
   * picked cluster below is pinned, would leave a name sliding around under the cursor.
   */
  const [hoveredCluster, setHoveredCluster] = useState<string | null>(null);

  /**
   * Whether the camera is moving right now. Two things ride on it: the sky is worth its own
   * compositor layer only while it moves (`.constellation-moving` in globals.css), and the star
   * window holds still through a zoom. Held in a ref and written straight to the DOM, because a
   * pan must not re-render the chart to toggle a class.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const movingRef = useRef(false);
  const placeWindowRef = useRef<(() => void) | null>(null);
  const applyMoving = useCallback((moving: boolean) => {
    stageRef.current?.classList.toggle("constellation-moving", moving);
    movingRef.current = moving;
    setCameraMoving(moving);
    // A name found before the camera moved is about a cluster that is no longer under the
    // pointer; it comes back with the next move of the mouse.
    if (moving) setHoveredCluster(null);
    // Stopped: choose the window for where the camera actually landed.
    if (!moving) placeWindowRef.current?.();
  }, []);

  /**
   * Moving starts at once and stops MOVE_SETTLE_MS after the camera last stopped.
   *
   * Every stop demotes the sky's compositor layer (re-rastering all of it), redraws the dust and
   * wash canvases and re-places the star window, and every start promotes the layer again. A
   * mouse wheel stops between notches and a trackpad between strokes, so a zoom made of several
   * paid all of that at each pause. Waiting a beat for the next stroke pays it once, at the end.
   */
  const stopTimerRef = useRef<number | undefined>(undefined);
  const setMoving = useCallback(
    (moving: boolean) => {
      if (stopTimerRef.current !== undefined) {
        window.clearTimeout(stopTimerRef.current);
        stopTimerRef.current = undefined;
      }
      if (moving) {
        if (!movingRef.current) applyMoving(true);
        return;
      }
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = undefined;
        applyMoving(false);
      }, MOVE_SETTLE_MS);
    },
    [applyMoving]
  );
  // Stable for the same reason as NODE_ORIGIN: React Flow stores its move callbacks.
  const onMoveStart = useCallback(() => setMoving(true), [setMoving]);
  const onMoveEnd = useCallback(() => setMoving(false), [setMoving]);
  /**
   * At most one zoom a frame.
   *
   * A trackpad pinch or a fast scroll delivers wheel events faster than frames — two or more a
   * frame on a 60Hz screen — and each one is a React Flow store update, which runs every drawn
   * node's store selector and commits. That per-event cost, not the zoom itself, was most of a
   * pinch frame. So the first wheel event of a frame goes through untouched; any more in the same
   * frame are held, summed, and delivered as one event at the start of the next. The camera ends
   * where it would have: a wheel zoom multiplies the scale by 2^(k·delta), so one event carrying
   * the summed delta lands on the same zoom as the events it replaces. Events of different kinds
   * (a pinch against a scroll, different delta units) are never merged.
   */
  useEffect(() => {
    const root = stageRef.current;
    if (!root) return;
    const forwarded = new WeakSet<Event>();
    let frame = 0;
    let held: {
      target: EventTarget;
      init: WheelEventInit;
    } | null = null;
    const release = () => {
      const h = held;
      held = null;
      if (!h) return false;
      const event = new WheelEvent("wheel", h.init);
      forwarded.add(event);
      // A star under the pointer may have left the DOM since; the pane still zooms.
      const target =
        h.target instanceof Node && h.target.isConnected
          ? h.target
          : (root.querySelector(".react-flow__pane") ?? root);
      target.dispatchEvent(event);
      return true;
    };
    const onFrame = () => {
      // Delivering held events is this frame's zoom; with nothing held, the next event may pass.
      frame = release() ? requestAnimationFrame(onFrame) : 0;
    };
    const onWheel = (e: WheelEvent) => {
      if (forwarded.has(e)) return;
      if (
        held &&
        (held.init.ctrlKey !== e.ctrlKey || held.init.deltaMode !== e.deltaMode)
      ) {
        release();
      }
      if (!frame) {
        frame = requestAnimationFrame(onFrame);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const init: WheelEventInit = held?.init ?? {
        bubbles: true,
        cancelable: true,
        view: window,
        deltaX: 0,
        deltaY: 0,
        deltaZ: 0,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
      };
      init.deltaX = (init.deltaX ?? 0) + e.deltaX;
      init.deltaY = (init.deltaY ?? 0) + e.deltaY;
      init.clientX = e.clientX;
      init.clientY = e.clientY;
      init.screenX = e.screenX;
      init.screenY = e.screenY;
      init.shiftKey = e.shiftKey;
      init.altKey = e.altKey;
      init.metaKey = e.metaKey;
      held = { target: e.target ?? root, init };
    };
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Leaving mid-move must not leave the shared camera flag (camera-motion.ts) stuck on.
  useEffect(
    () => () => {
      if (stopTimerRef.current !== undefined) window.clearTimeout(stopTimerRef.current);
      setCameraMoving(false);
    },
    []
  );

  const windowing = summaryAllowed && !summary;
  const [starWindow, setStarWindow] = useState<WorldRect | null>(null);
  // A window left over from a previous close-up points somewhere else entirely.
  const [windowFor, setWindowFor] = useState(windowing);
  if (windowFor !== windowing) {
    setWindowFor(windowing);
    setStarWindow(null);
  }
  useEffect(() => {
    if (!windowing || !viewportReady) return;
    // The window this effect last placed. Kept here so a camera update that leaves it where it
    // is — nearly all of them — sets no state: handing React an updater that returns the same
    // window still re-ran this whole component to find that out, on every wheel event.
    let current: WorldRect | null = null;
    const next = (prev: WorldRect | null): WorldRect | null => {
      const { transform, width, height } = storeApi.getState();
      if (width < 2 || height < 2) return prev;
      if (prev) {
        const inner = viewportWorldRect(transform, width, height, 0);
        const slackX = (inner.x1 - inner.x0) * STAR_WINDOW_MARGIN * STAR_WINDOW_SLACK;
        const zoomed = Math.abs(Math.log2(transform[2] / prev.zoom));
        // Mid-zoom, keep the stars that are up rather than choosing a new set every step.
        // `setMoving` places the window again the moment the camera stops.
        if (movingRef.current && zoomed > 0.01) return prev;
        const slackY = (inner.y1 - inner.y0) * STAR_WINDOW_MARGIN * STAR_WINDOW_SLACK;
        if (
          zoomed < 0.25 &&
          inner.x0 >= prev.x0 + slackX &&
          inner.y0 >= prev.y0 + slackY &&
          inner.x1 <= prev.x1 - slackX &&
          inner.y1 <= prev.y1 - slackY
        ) {
          return prev;
        }
      }
      return viewportWorldRect(transform, width, height, STAR_WINDOW_MARGIN);
    };
    const place = () => {
      const placed = next(current);
      if (placed === current) return;
      current = placed;
      setStarWindow(placed);
    };
    placeWindowRef.current = place;
    place();
    const unsubscribe = storeApi.subscribe(place);
    return () => {
      placeWindowRef.current = null;
      unsubscribe();
    };
  }, [windowing, viewportReady, storeApi]);

  /**
   * The window in effect this render. On the frame the summary ends, the effect above has not
   * run yet, and waiting for it left one frame with neither dots nor stars — the blink when
   * flying into a cluster. So the first window is read from the camera right here.
   */
  let activeWindow = starWindow;
  if (windowing && !activeWindow) {
    const { transform, width, height } = storeApi.getState();
    if (width >= 2 && height >= 2) {
      activeWindow = viewportWorldRect(transform, width, height, STAR_WINDOW_MARGIN);
    }
  }

  /** Window members, nearest its centre first. */
  const wanted = useMemo(() => {
    if (!windowing || !activeWindow) return null;
    const w = activeWindow;
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    const inside: Array<{ id: string; d: number }> = [];
    for (const n of contactById.values()) {
      const { x, y } = n.position;
      if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue;
      inside.push({ id: n.id, d: (x - cx) ** 2 + (y - cy) ** 2 });
    }
    inside.sort((a, b) => a.d - b.d);
    return inside.map((c) => c.id);
    // `activeWindow` is a fresh object only when `starWindow` is null; its bounds are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    windowing,
    contactById,
    activeWindow?.x0,
    activeWindow?.y0,
    activeWindow?.x1,
    activeWindow?.y1,
  ]);
  const target = useMemo(
    () => (wanted ? new Set(wanted.slice(0, STAR_WINDOW_MAX)) : NO_IDS),
    [wanted]
  );

  const [mounted, setMounted] = useState<ReadonlySet<string>>(NO_IDS);
  const adding = wanted !== null && wanted.slice(0, STAR_WINDOW_MAX).some((id) => !mounted.has(id));
  const removing = mounted.size > 0 && [...mounted].some((id) => !target.has(id));
  useEffect(() => {
    if (!adding && !removing) return;
    const raf = requestAnimationFrame(() => {
      setMounted((prev) => {
        const next = new Set<string>();
        let removed = 0;
        for (const id of prev) {
          if (target.has(id) || removed >= STAR_UNMOUNT_BATCH) next.add(id);
          else removed++;
        }
        let added = 0;
        const batch = movingRef.current
          ? STAR_MOUNT_BATCH_MOVING
          : STAR_MOUNT_BATCH;
        for (const id of wanted ?? []) {
          if (added >= batch || !target.has(id)) break;
          if (next.has(id)) continue;
          next.add(id);
          added++;
        }
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [wanted, target, mounted, adding, removing]);
  /** Stars in the window that are not real stars (yet, or at all): the dots must cover them. */
  const windowHasDots =
    wanted !== null && (wanted.length > mounted.size || adding);

  const focusCompany = useMemo(() => {
    if (focusCluster) {
      const hit = data.clusters.find(
        (c) => c.id === focusCluster || c.name === focusCluster || c.company === focusCluster
      );
      return hit?.name || focusCluster;
    }
    if (company !== "all") return company;
    if (hoveredId && hoveredId !== "me") {
      const d = contactById.get(hoveredId)?.data as GraphNodeData | undefined;
      return d?.clusterName || d?.company || null;
    }
    if (selection?.type === "contact") {
      return selection.data.clusterName || selection.data.company || null;
    }
    return null;
  }, [focusCluster, company, hoveredId, selection, contactById, data.clusters]);

  const searchQuery = search.trim().toLowerCase();
  const hasSearch = Boolean(searchQuery) || searchHitIds.size > 0;
  // Dim the rest of the sky only when the search actually hit someone —
  // a no-match query must not blank the whole map.
  const searchDimActive = hasSearch && searchHitIds.size > 0;

  /**
   * The emphasis inputs, in the shape both renderers read them.
   *
   * The dim/spotlight precedence itself lives in `sky-emphasis.ts` rather than here,
   * because it is the one thing a person reads instantly and would never think to
   * compare across devices: if a phone dimmed the unsearched stars differently, nobody
   * would file it — one of the two would just be harder to read.
   */
  const focusState: SkyFocusState = useMemo(
    () => ({
      hoveredId,
      selectedContactId: selection?.type === "contact" ? selection.id : null,
      searchHitIds,
      searchDimActive,
    }),
    [hoveredId, selection, searchHitIds, searchDimActive]
  );

  const labelZoom = useStore((s) => zoomStep(s.transform[2]));
  // Cluster names can pin in view from here in (see ClusterLabelNode in graph-nodes.tsx).
  const labelPinnable = useStore((s) => s.transform[2] >= CLUSTER_NAME_PIN_MIN_ZOOM);


  /**
   * Whether the camera is at the home framing — the zoom `DefaultViewFitter` picks — which is the
   * only view that gets the longer legend of cluster names. Derived from the same pure function
   * the fitter uses rather than remembered from the last flight, so it is still right after a
   * resize, a filter, or a pinch back out to the edge of the zoom range.
   */
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const atHome = useMemo(() => {
    const { maxAbsX, maxAbsY } = computeSunExtents(sky.layout.nodes, []);
    const home = zoomToFitSunCentered(maxAbsX, maxAbsY, paneW, paneH);
    return labelZoom <= home * CLUSTER_NAME_HOME_SLACK;
  }, [sky.layout.nodes, paneW, paneH, labelZoom]);

  /**
   * The cluster the reader deliberately picked: clicked or searched (`focusCluster`), filtered
   * to, or holding the selected person. Its name always shows and, zoomed in, stays in view.
   */
  const highlightedCluster = useMemo(() => {
    if (focusCluster) {
      const hit = data.clusters.find(
        (c) => c.id === focusCluster || c.name === focusCluster || c.company === focusCluster
      );
      return hit?.name || focusCluster;
    }
    if (company !== "all") return company;
    if (selection?.type === "contact") {
      return selection.data.clusterName || selection.data.company || null;
    }
    return null;
  }, [focusCluster, company, selection, data.clusters]);

  const clusterLabelNodes = useMemo(
    () => sky.layout.nodes.filter((n) => n.type === "clusterLabel"),
    [sky.layout.nodes]
  );

  /**
   * Every cluster as a circle to point at: its name, its centre and how far its stars reach.
   *
   * The pointer is tested against these rather than against the washes' own boxes, which are
   * four radii across and overlap half the sky — hovering the gap between two clusters would
   * otherwise name whichever box happened to be on top.
   */
  const clusterCircles = useMemo(() => {
    const byClusterId = new Map<string, string>();
    for (const n of clusterLabelNodes) {
      const d = n.data as ClusterLabelData;
      if (d.clusterId) byClusterId.set(d.clusterId, d.label);
    }
    const circles: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      r2: number;
    }> = [];
    for (const n of sky.layout.nodes) {
      if (n.type !== "nebula") continue;
      const d = n.data as NebulaData;
      const name = (d.clusterId && byClusterId.get(d.clusterId)) || d.company;
      if (!name) continue;
      const reach = d.radius * CLUSTER_HOVER_REACH;
      circles.push({
        id: clusterIdFromNodeId(n.id, d.clusterId),
        name,
        x: n.position.x,
        y: n.position.y,
        r2: reach * reach,
      });
    }
    return circles;
  }, [clusterLabelNodes, sky.layout.nodes]);

  /**
   * The cluster under a point on screen: nearest centre whose reach contains it, or null.
   *
   * The one place the sky answers "which cluster is that". Naming one under the pointer and
   * flying to one on a click used to be different mechanisms — hover tested these circles,
   * while a click hit whichever wash box React Flow reported — so the two could disagree about
   * a point in the overlap between neighbours: the sky said one name and the camera flew to
   * another. Now that the washes are one canvas there is no box to click, and both go through
   * here.
   */
  const clusterAt = useCallback(
    (clientX: number, clientY: number) => {
      const { x, y } = screenToFlowPosition({ x: clientX, y: clientY });
      let best: (typeof clusterCircles)[number] | null = null;
      let bestD = Infinity;
      for (const c of clusterCircles) {
        const d = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (d <= c.r2 && d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    },
    [clusterCircles, screenToFlowPosition]
  );

  /**
   * Name the cluster the pointer is inside, or nothing between them.
   *
   * Not while the camera moves. A pointer resting on the sky during a zoom has cluster after
   * cluster pass underneath it, and the browser reports each one as a fresh hover: the sky was
   * re-choosing its names on most frames of a zoom, which cost 58fps down to 38.
   */
  const hoverClusterAt = useCallback(
    (clientX: number, clientY: number) => {
      if (movingRef.current) return;
      const hit = clusterAt(clientX, clientY);
      const best = hit ? hit.name : null;
      setHoveredCluster((prev) => (prev === best ? prev : best));
    },
    [clusterAt]
  );
  const clusterNamesShown = useMemo(
    () =>
      clusterNameWinners(
        clusterLabelNodes,
        labelZoom,
        summary,
        highlightedCluster,
        hoveredCluster,
        atHome
      ),
    [
      clusterLabelNodes,
      labelZoom,
      summary,
      highlightedCluster,
      hoveredCluster,
      atHome,
    ]
  );
  // Independent of hover on purpose: moving the pointer must not reshuffle which names show.
  // Only over stars that can be drawn: the summary's mounted hits, or the star window. Over the
  // whole sky this ran on every keystroke of a search — 10,000 label boxes to name a handful.
  const labelled = useMemo(() => {
    let candidates: Iterable<LayoutNodes[number]> = contactById.values();
    if (summary) {
      candidates =
        searchDimActive && searchHitIds.size <= SUMMARY_MOUNT_HITS_MAX
          ? [...searchHitIds].flatMap((id) => contactById.get(id) ?? [])
          : [];
    } else if (wanted) {
      candidates = [...target].flatMap((id) => contactById.get(id) ?? []);
    }
    return labelWinners(
      candidates,
      labelZoom,
      (id) => searchDimActive && searchHitIds.has(id)
    );
  }, [contactById, labelZoom, searchDimActive, searchHitIds, summary, wanted, target]);

  /**
   * Every contact, as the dots the summary view draws in place of stars. Built only while the
   * summary is on, and rebuilt only when the sky or the emphasis changes — never per frame.
   */
  // Only on/off: the per-frame fill must not rebuild or redraw the dots.
  /**
   * Zoomed out past what the window was chosen for — its stars no longer reach the edges of the
   * view — so the dots stand in until the camera stops and the window is placed again.
   */
  const windowOutrun =
    activeWindow !== null && labelZoom < activeWindow.zoom * STAR_WINDOW_OUTRUN;
  const rampActive = windowHasDots || windowOutrun;
  // Search, but not hover or selection: the dots dim for a search, and a pointer moving over
  // the sky must not redraw every dot on the canvas.
  const dustFocus: SkyFocusState = useMemo(
    () => ({ hoveredId: null, selectedContactId: null, searchHitIds, searchDimActive }),
    [searchHitIds, searchDimActive]
  );
  const starDust = useMemo((): StarDustData | null => {
    // Kept while the window fills: stars land on top of their own dots.
    if (!summary && !rampActive) return null;
    const points: StarDustPoint[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of skyLayoutNodes) {
      if (n.type !== "contact") continue;
      const d = n.data as GraphNodeData;
      const { disc, fill, alphaScale } = starVisual(d, false);
      const { opacity, spotlight } = starEmphasis(n.id, dustFocus);
      points.push({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        // A hit that stays a dot is drawn the way a spotlit star is: larger, and at full strength.
        disc: spotlight ? disc * 1.3 : disc,
        color: d.comet ? "#ff6b4a" : fill,
        alpha: spotlight ? 1 : Math.min(1, 0.9 * alphaScale * opacity),
      });
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x);
      maxY = Math.max(maxY, n.position.y);
    }
    if (points.length === 0) return null;
    // Room for the largest dot at the widest zoom relief on every edge.
    const pad = 48;
    return {
      kind: "starDust",
      points,
      minX: minX - pad,
      minY: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [summary, rampActive, skyLayoutNodes, dustFocus]);

  /**
   * The nodes React Flow draws: each structural node with this moment's emphasis applied.
   *
   * Every result goes through `withEmphasis`, which hands back the SAME object as last time
   * when a node's emphasis did not change. That identity is the whole optimisation: React
   * Flow keeps a node's internals, and skips re-rendering it, only when the object it is
   * given is the one it already has. Rebuilding every node here — as this used to — meant a
   * hover re-rendered all 1,000 stars to change the opacity of two of them.
   */
  /**
   * One object per dust payload, carrying its own `measured` box. React Flow re-measures any
   * node handed over without one and reports the size back through `onNodesChange` — which,
   * for a node rebuilt on every render, was a commit loop running every frame.
   */
  const starDustNode = useMemo((): Node | null => {
    if (!starDust) return null;
    return {
      id: STAR_DUST_ID,
      type: "starDust",
      // nodeOrigin is [0.5, 0.5], so the position is the canvas's centre.
      position: {
        x: starDust.minX + starDust.width / 2,
        y: starDust.minY + starDust.height / 2,
      },
      width: starDust.width,
      height: starDust.height,
      measured: { width: starDust.width, height: starDust.height },
      data: starDust,
      draggable: false,
      selectable: false,
      focusable: false,
      // Above the rings (-2), beneath the clusters' haze (0) and every real star.
      zIndex: -1,
      style: { pointerEvents: "none" },
    };
  }, [starDust]);

  /**
   * Every cluster's wash, as one canvas payload: where each cloud is, how big, and how dimmed.
   *
   * Rebuilt only when the sky or the emphasis changes — a pan, a zoom or a hover leaves it
   * alone, so the canvas is not asked to redraw for any of them.
   */
  // A cluster's wash dims only while a search narrows the sky (`clusterEmphasis`), so outside one
  // the focused company changes nothing here. Keyed on it anyway, hovering a star rebuilt and
  // redrew the whole wash — every cluster's gradients — on every hover.
  const washFocusCompany = searchDimActive ? focusCompany : null;
  const nebulaWash = useMemo((): NebulaWashData | null => {
    const clusters: NebulaWashCluster[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of skyLayoutNodes) {
      if (n.type !== "nebula") continue;
      const d = n.data as NebulaData;
      clusters.push({
        seed: d.company,
        color: d.color,
        x: n.position.x,
        y: n.position.y,
        radius: d.radius,
        opacity: clusterEmphasis(d.company, washFocusCompany, company, searchDimActive),
      });
      // The same box the wash used to have its own element for: four radii across, so the
      // cloud dissolves well before the canvas ends and no cluster is clipped at the edge.
      const reach = (d.radius * NEBULA_BOX_RADII) / 2;
      minX = Math.min(minX, n.position.x - reach);
      minY = Math.min(minY, n.position.y - reach);
      maxX = Math.max(maxX, n.position.x + reach);
      maxY = Math.max(maxY, n.position.y + reach);
    }
    if (clusters.length === 0) return null;
    return {
      kind: "nebulaWash",
      clusters,
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [skyLayoutNodes, washFocusCompany, company, searchDimActive]);

  /** One node, carrying its own `measured` box for the same reason the dust node does. */
  const nebulaWashNode = useMemo((): Node | null => {
    if (!nebulaWash) return null;
    return {
      id: NEBULA_WASH_ID,
      type: "nebulaWash",
      // nodeOrigin is [0.5, 0.5], so the position is the canvas's centre.
      position: {
        x: nebulaWash.minX + nebulaWash.width / 2,
        y: nebulaWash.minY + nebulaWash.height / 2,
      },
      width: nebulaWash.width,
      height: nebulaWash.height,
      measured: { width: nebulaWash.width, height: nebulaWash.height },
      data: nebulaWash,
      draggable: false,
      selectable: false,
      focusable: false,
      // Exactly where the 485 wash boxes sat: above the rings (-2) and the dust (-1), beneath
      // the stars and the cluster names. Keeping the number keeps the sky's order unchanged.
      zIndex: 0,
      style: { pointerEvents: "none" },
    };
  }, [nebulaWash]);

  /**
   * Where each node sits in `orbitNodes`, so the pass below can visit only the stars that can
   * be drawn and still hand React Flow its nodes in the sky's order (which is their stacking
   * order in the DOM).
   */
  const orbitOrder = useMemo(() => {
    const contactIndex = new Map<string, number>();
    const otherIndexes: number[] = [];
    orbitNodes.forEach((n, i) => {
      if (n.type === "contact") contactIndex.set(n.id, i);
      else otherIndexes.push(i);
    });
    return { contactIndex, otherIndexes };
  }, [orbitNodes]);

  const nodes = useMemo(() => {
    const out: Node[] = [];
    if (starDustNode) out.push(starDustNode);
    if (nebulaWashNode) out.push(nebulaWashNode);

    /**
     * In a large sky only a few hundred of the stars are drawn, so the pass visits those rather
     * than every contact: this runs on every frame a batch of stars mounts, and on every hover,
     * and walking thousands of contacts to skip them was most of its cost. The candidates are
     * exactly the stars the skip test below can let through — mounted, hovered, selected, the
     * peek, and the search hits it will mount — in the sky's order, so nothing it produces
     * changes.
     */
    let visit: Node[] = orbitNodes;
    if (summaryAllowed) {
      const indexes = [...orbitOrder.otherIndexes];
      const add = (id: string | null | undefined) => {
        const i = id ? orbitOrder.contactIndex.get(id) : undefined;
        if (i !== undefined) indexes.push(i);
      };
      for (const id of mounted) add(id);
      add(hoveredId);
      add(focusState.selectedContactId);
      add(peekPersonId);
      if (focusState.searchDimActive && searchHitIds.size <= SUMMARY_MOUNT_HITS_MAX) {
        for (const id of searchHitIds) add(id);
      }
      indexes.sort((a, b) => a - b);
      visit = [];
      let last = -1;
      for (const i of indexes) {
        if (i === last) continue;
        last = i;
        visit.push(orbitNodes[i]);
      }
    }

    for (const n of visit) {
      if (n.type === "orbitRings") {
        out.push(n);
        continue;
      }
      if (n.type === "user") {
        const selected = selection?.type === "user";
        out.push(
          withEmphasis(
            n,
            selected ? "sel" : "",
            () => ({ ...n, ...measuredOf(measured, n.id), selected }) as Node
          )
        );
        continue;
      }
      // The washes are drawn on `nebulaWashNode` above, not one box each.
      if (n.type === "nebula") continue;
      if (n.type === "clusterLabel") {
        const label = n.data as ClusterLabelData;
        const opacity = clusterEmphasis(
          label.label,
          focusCompany,
          company,
          searchDimActive
        );
        // Only the highlighted cluster's name pins in view; the rest stay above their clusters.
        const pinnable = labelPinnable && label.label === highlightedCluster;
        const nameHidden = !clusterNamesShown.has(n.id);
        // The name under the pointer sits above the rest, since it is the one being read.
        const nameRaised = label.label === hoveredCluster;
        out.push(
          withEmphasis(
            n,
            `${opacity}|${summary}|${pinnable}|${nameHidden}|${nameRaised}`,
            () =>
              ({
                ...n,
                ...measuredOf(measured, n.id),
                hidden: nameHidden,
                ...(nameRaised ? { zIndex: 60 } : null),
                // Placed by the name's anchor: the cluster-sized box around it when the name
                // can pin (see-through to pointers everywhere but the name, so the stars under
                // it stay clickable), otherwise the name's own box on it.
                ...(pinnable && label.box && label.anchor
                  ? {
                      width: label.box.width,
                      height: label.box.height,
                      origin: [
                        label.anchor.x / label.box.width,
                        label.anchor.y / label.box.height,
                      ] as [number, number],
                    }
                  : { origin: [0.5, 1] as [number, number] }),
                data: { ...label, summary, pinnable },
                ariaLabel: summary
                  ? `${label.label}, ${label.count ?? 0} ${
                      label.count === 1 ? "person" : "people"
                    }. Zoom in`
                  : `Zoom to ${label.label}`,
                // A handful of clusters, so their fade is affordable — unlike the stars below.
                style: {
                  opacity,
                  transition: "opacity 200ms ease",
                  ...(pinnable ? { pointerEvents: "none" as const } : null),
                },
              }) as Node
          )
        );
        continue;
      }

      const d = n.data as GraphNodeData;
      const emphasis = starEmphasis(n.id, focusState);
      const isHovered = hoveredId === n.id;
      // Anyone the reader is pointing at keeps a name whatever it overlaps (see graph-nodes.tsx).
      // Search hits stay real stars through the summary view, labelled if they win a place.
      const labelPinned = isHovered || emphasis.selected || emphasis.spotlightSolo;
      const labelHidden = !labelled.has(n.id);
      const mountHit =
        emphasis.spotlight && searchHitIds.size <= SUMMARY_MOUNT_HITS_MAX;
      // Large skies draw a star only when something asks for it: the reader (pinned, a mountable
      // search hit, a peek) or the window, via `mounted` — which in the summary view drains a
      // batch a frame rather than dropping every star at once.
      if (
        summaryAllowed &&
        !labelPinned &&
        !mountHit &&
        n.id !== peekPersonId &&
        !mounted.has(n.id)
      ) {
        continue;
      }
      const raised = isHovered || emphasis.selected;
      const entering = sky.entering.has(n.id);

      out.push(
        withEmphasis(
          n,
          `${emphasis.opacity}|${emphasis.selected}|${emphasis.spotlight}|${emphasis.spotlightSolo}|${raised}|${labelPinned}|${labelHidden}|${entering}`,
          () =>
            ({
              ...n,
              ...measuredOf(measured, n.id),
              selected: emphasis.selected,
              hidden: false,
              data: {
                ...d,
                raised,
                labelPinned,
                labelHidden,
                entering,
                spotlight: emphasis.spotlight,
                spotlightSolo: emphasis.spotlightSolo,
              },
              // No opacity transition. A hover dims every star in view at once, and each star
              // mid-transition is its own compositor layer: hovering inside a searched
              // 300-person cluster spiked the chart from ~40 layers to ~400 on every move,
              // blanking parts of the page. The dim is instant instead.
              style: { opacity: emphasis.opacity },
            }) as Node
        )
      );
    }
    return out;
  }, [
    orbitNodes,
    starDustNode,
    nebulaWashNode,
    summary,
    hoveredId,
    peekPersonId,
    selection,
    focusState,
    searchDimActive,
    focusCompany,
    company,
    sky.entering,
    labelled,
    labelPinnable,
    highlightedCluster,
    clusterNamesShown,
    hoveredCluster,
    searchHitIds,
    summaryAllowed,
    mounted,
    orbitOrder,
    measured,
  ]);

  const drawnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of nodes) if (n.type === "contact") ids.add(n.id);
    return ids;
  }, [nodes]);

  const edges = useMemo(() => {
    // A figure line needs both its stars drawn (`drawnIds`). Not cleared outright for the
    // summary view: the stars leave a batch a frame, and their lines go with them rather than
    // all in the one frame the summary begins.
    return layout.edges
      .filter((e) => {
        if (!drawnIds.has(e.source) || !drawnIds.has(e.target)) return false;
        const kind = e.data?.kind;
        // Peer constellation / knows links only — sun rays are injected below
        return kind === "constellation" || kind === "knows";
      })
      .map((e) => {
        const { opacity, strokeWidth } = edgeEmphasis(
          {
            source: e.source,
            target: e.target,
            opacity: Number(e.style?.opacity ?? 0.5),
            strokeWidth: Number(e.style?.strokeWidth ?? 1),
            kind: e.data?.kind,
          },
          { ...focusState, focusCluster }
        );

        // Same identity rule as the nodes: an edge whose emphasis is unchanged keeps its
        // object, so React Flow does not re-render it.
        return withEmphasis(
          e,
          `${opacity}|${strokeWidth}`,
          () =>
            ({
              ...e,
              type: "labeled" as const,
              label: undefined,
              animated: false,
              data: { ...e.data, label: undefined },
              style: { ...e.style, opacity, strokeWidth },
            }) as Edge
        );
      });
  }, [layout.edges, focusCluster, focusState, drawnIds]);

  /**
   * Frame a set of people, whether or not they are mounted.
   *
   * `fitView` only knows nodes React Flow currently holds, and in the summary view most
   * people are dots on a canvas rather than nodes. Those are framed from their layout
   * positions instead, padded by a star's reach so the edge ones are not cut in half.
   */
  const framePeople = useCallback(
    (
      ids: string[],
      options: {
        padding: number;
        duration: number;
        maxZoom: number;
        minZoom?: number;
        interpolate?: "linear" | "smooth";
      }
    ) => {
      if (ids.length === 0) return;
      const present = new Set(getNodes().map((n) => n.id));
      if (ids.every((id) => present.has(id))) {
        void fitView({ nodes: ids.map((id) => ({ id })), ...options });
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of ids) {
        const n = contactById.get(id);
        if (!n) continue;
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x);
        maxY = Math.max(maxY, n.position.y);
      }
      if (!Number.isFinite(minX)) return;
      const reach = 64;
      void fitBounds(
        {
          x: minX - reach,
          y: minY - reach,
          width: maxX - minX + reach * 2,
          height: maxY - minY + reach * 2,
        },
        {
          padding: options.padding,
          duration: options.duration,
          interpolate: options.interpolate,
        }
      );
    },
    [contactById, fitView, fitBounds, getNodes]
  );

  /**
   * Keep the sky anchored when the pane resizes (window resize, fullscreen,
   * side panel): shift the viewport by half the size delta so the world point
   * at the old view center stays at the new center — the sun, and everything
   * else, holds its relative position.
   */
  useEffect(() => {
    const el = storeApi.getState().domNode;
    if (!el) return;
    let last = { w: el.clientWidth, h: el.clientHeight };
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const dw = w - last.w;
      const dh = h - last.h;
      if (dw === 0 && dh === 0) return;
      last = { w, h };
      const vp = getViewport();
      void setViewport({
        x: vp.x + dw / 2,
        y: vp.y + dh / 2,
        zoom: vp.zoom,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [storeApi, getViewport, setViewport]);

  /**
   * Cluster / search / peek zooms are separate. Default wide view is owned by
   * <DefaultViewFitter homeToken={...} /> inside ReactFlow.
   */
  useEffect(() => {
    // Invalidate other zoom locks whenever we request the default view
    prevClusterZoomKey.current = "";
    prevPeekZoomKey.current = "";
  }, [homeToken]);

  // Cluster pill / search cluster focus
  useEffect(() => {
    if (!focusCluster) return;
    const key = `${focusCluster}::${zoomToken}`;
    if (key === prevClusterZoomKey.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const cluster = data.clusters.find(
        (c) =>
          c.id === focusCluster ||
          c.name === focusCluster ||
          c.company === focusCluster
      );
      const matchIds = (
        cluster?.contactIds?.length
          ? cluster.contactIds
          : filteredContacts
              .filter(
                (c) =>
                  c.company === focusCluster ||
                  (c.school || "").trim() === focusCluster
              )
              .map((c) => c.id)
      ).filter((id) => contactById.has(id));
      if (matchIds.length === 0) return;

      prevClusterZoomKey.current = key;
      framePeople(matchIds, {
        padding: 0.4,
        // Snappy direct flight: pan and zoom move together, no arc.
        duration: CAMERA_MS.snap,
        interpolate: "linear",
        maxZoom: 1.5,
        minZoom: 0.2,
      });
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only focus/zoom should retrigger
  }, [focusCluster, zoomToken, data.clusters]);

  // Re-engage list hover — zoom in on that person
  useEffect(() => {
    if (!peekPersonId) return;
    const key = `peek::${peekPersonId}::${peekToken}`;
    if (key === prevPeekZoomKey.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (!contactById.has(peekPersonId)) return;
      prevPeekZoomKey.current = key;
      framePeople([peekPersonId], {
        padding: 0.55,
        duration: CAMERA_MS.move,
        maxZoom: 1.8,
        minZoom: 0.3,
      });
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new peek should retrigger
  }, [peekPersonId, peekToken]);

  // Search hit framing (person / multi-match) when not focusing a named cluster.
  // Only zoomToken should reframe — searchHitIds alone updates from semantic
  // enrichment and must not yank the camera back out.
  useEffect(() => {
    if (focusCluster || !hasSearch) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      // Frame exactly the hit set; the local matcher is only a fallback for
      // the beat before searchHitIds state catches up with fresh keystrokes.
      // Matched against every contact, not the mounted nodes: in the summary view
      // most people are not nodes.
      const matchIds: string[] = [];
      for (const n of contactById.values()) {
        const hit =
          searchHitIds.size > 0
            ? searchHitIds.has(n.id)
            : contactMatchesLocal(n.data as GraphNodeData, searchQuery);
        if (hit) matchIds.push(n.id);
      }
      if (matchIds.length === 0) return;
      framePeople(matchIds, {
        padding: matchIds.length === 1 ? 0.55 : 0.45,
        // Snappy direct flight: pan and zoom move together, no arc.
        duration: CAMERA_MS.snap,
        interpolate: "linear",
        maxZoom: matchIds.length === 1 ? 1.75 : 1.2,
      });
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // zoomToken owns reframes. Not `hasSearch`: it flips on the first keystroke, and flying to
    // what one letter matches — then again on every letter after — was the camera lurching
    // between the whole sky and a close-up while someone typed. `network-graph.tsx` bumps the
    // token once typing pauses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCluster, zoomToken]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.id === "rings" || node.id === STAR_DUST_ID) return;
      if (node.id === NEBULA_WASH_ID) return;

      if (node.type === "clusterLabel") {
        if (compact) return;
        const d = node.data as ClusterLabelData;
        const clusterId = clusterIdFromNodeId(node.id, d.clusterId);
        if (clusterId) onFocusCluster(clusterId);
        return;
      }

      if (compact && node.type === "contact") {
        router.push(`/contacts/${node.id}`);
        return;
      }
      if (node.id === "me" || node.type === "user") {
        onSelect(selectionForUser(node.data as GraphNodeData, data.summary));
        return;
      }
      onSelect(selectionForContact(node.id, node.data as GraphNodeData));
    },
    [onSelect, onFocusCluster, data, compact, router]
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback(
    (event, node) => {
      // A cluster's own name, under the pointer, says its name. Over the haze around it there
      // is no node any more — the pane's `onPaneMouseMove` answers instead, from the same
      // circles, which is how the gaps between clusters were always handled.
      if (node.type === "clusterLabel") {
        hoverClusterAt(event.clientX, event.clientY);
        onHover(null);
        return;
      }
      setHoveredCluster(null);
      if (node.type !== "contact") {
        onHover(null);
        return;
      }
      onHover(node.id);
    },
    [onHover, hoverClusterAt]
  );

  /**
   * Which cluster is under the pointer changes as it travels, and the washes are wide enough
   * that a pointer can cross a whole cluster without ever entering or leaving a node.
   */
  const onClusterPointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      hoverClusterAt(event.clientX, event.clientY);
    },
    [hoverClusterAt]
  );

  const onNodeMouseMove: NodeMouseHandler = useCallback(
    (event, node) => {
      if (node.type === "clusterLabel") {
        hoverClusterAt(event.clientX, event.clientY);
      }
    },
    [hoverClusterAt]
  );

  const onNodeMouseLeave = useCallback(() => {
    setHoveredCluster(null);
    onHover(null);
  }, [onHover]);

  // `onNodesChange` (below) carries selection into the nodes React Flow is handed next, and
  // keeps measurements aside in `measured` (see `Measurements`). Only
  // changes that land on a stored node count: the star-dust node is derived, never stored, and
  // a no-op must not hand back a new array — that re-derives every node and re-renders the sky.
  /**
   * A click on the open sky: the cluster it lands in, or nothing.
   *
   * The wash boxes used to catch this — clicking a cluster's haze flew the camera to it — and
   * they are gone, so the pane takes it over, against the same circles the hover uses. React
   * Flow suppresses this click after a drag (`paneClickDistance`), so ending a pan inside a
   * cluster does not fly to it.
   */
  const onPaneClick = useCallback(
    (event: ReactMouseEvent) => {
      const hit = clusterAt(event.clientX, event.clientY);
      if (hit) {
        // Compact ignored a tap on the haze before, and still does — including the deselect,
        // since the tap did land on a cluster.
        if (!compact) onFocusCluster(hit.id);
        return;
      }
      onSelect(null);
    },
    [clusterAt, compact, onFocusCluster, onSelect]
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      // Measurements go to `measured`, not into the nodes (see `Measurements`); anything else —
      // selection — still updates the sky.
      const rest = changes.filter((c) => {
        if (c.type !== "dimensions") return true;
        if (c.dimensions) measured.set(c.id, c.dimensions);
        return false;
      });
      if (rest.length === 0) return;
      setSky((s) => {
        const ids = new Set(s.nodes.map((n) => n.id));
        const relevant = rest.filter((c) => "id" in c && ids.has(c.id));
        if (relevant.length === 0) return s;
        return { ...s, nodes: applyNodeChanges(relevant, s.nodes) };
      });
    },
    [measured]
  );

  const isEmpty = filteredContacts.length === 0;
  const flowNodes = useHiddenBeforeRemoved(useSameArrayIfUnchanged(nodes));
  const flowEdges = useSameArrayIfUnchanged(isEmpty ? NO_EDGES : edges);

  return (
    <>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={NODE_ORIGIN}
        minZoom={SKY_MIN_ZOOM}
        maxZoom={SKY_MAX_ZOOM}
        onlyRenderVisibleElements
        style={{
          width: "100%",
          height: "100%",
          opacity: viewportReady ? 1 : 0,
          transition: viewportReady ? "opacity 220ms ease" : "none",
          pointerEvents: viewportReady ? "auto" : "none",
        }}
        onInit={(instance) => {
          const pane = document.querySelector(
            ".constellation-stage.react-flow"
          ) as HTMLElement | null;
          const w = pane?.clientWidth ?? 0;
          const h = pane?.clientHeight ?? 0;
          if (w < 48 || h < 48) return;
          const { maxAbsX, maxAbsY } = computeSunExtents(
            layout.nodes,
            instance.getNodes()
          );
          const zoom = zoomToFitSunCentered(maxAbsX, maxAbsY, w, h);
          void instance.setViewport({ x: w / 2, y: h / 2, zoom });
        }}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseMove={onNodeMouseMove}
        onPaneMouseMove={onClusterPointerMove}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        nodesDraggable={false}
        ref={stageRef}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        className="constellation-stage"
      >
        <DefaultViewFitter
          key={`${homeToken}:${sky.epoch}`}
          homeToken={homeToken}
          animate={homeToken > 1 || sky.epoch > 0}
          layoutNodes={layout.nodes}
          onSettled={() => setViewportReady(true)}
        />
        {/*
          No <Background>. Its dot grid (3% white, radius zoom/2 on a 48·zoom grid) was invisible at
          every zoom, but it re-rendered on every camera frame and repainted a full-pane SVG pattern
          outside the chart's composited layer — a cost on each frame of a zoom or pan for nothing.
        */}
      </ReactFlow>

      {/*
        Three different empty skies, which used to be one. "Add contacts" is right only when
        there genuinely are none — said to someone whose 800 contacts were filtered out it is
        both wrong and unactionable, and it points at the one button that will not help.
      */}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-white/10 bg-[#080b12]/90 px-6 py-5 text-center shadow-xl">
            {data.summary.total === 0 ? (
              <>
                <p className="font-[family-name:var(--font-display)] text-lg text-white">
                  Your sky is empty
                </p>
                <p className="mt-1 text-sm text-white/55">
                  Add contacts and they will appear as stars in your constellation.
                </p>
                <Link
                  href="/contacts/new"
                  className="mt-4 inline-flex h-8 items-center rounded-lg bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/15"
                >
                  Add a contact
                </Link>
              </>
            ) : constellationFilterOn && data.contacts.length === 0 ? (
              <>
                <p className="font-[family-name:var(--font-display)] text-lg text-white">
                  Nobody here yet
                </p>
                <p className="mt-1 text-sm text-white/55">
                  Your chart shows the people you have notes on, met, or really talked with.
                  Write a note about someone and they take their place in the sky.
                </p>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Link
                    href="/capture"
                    className="inline-flex h-8 items-center rounded-lg bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Add notes
                  </Link>
                  <button
                    type="button"
                    disabled={loadingAll}
                    onClick={onShowAll}
                    aria-busy={loadingAll}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-white/70 hover:text-white disabled:opacity-70"
                  >
                    {loadingAll && (
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    )}
                    {loadingAll
                      ? "Loading…"
                      : `Show all ${data.summary.total.toLocaleString()}`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="font-[family-name:var(--font-display)] text-lg text-white">
                  No stars match
                </p>
                <p className="mt-1 text-sm text-white/55">
                  {constellationFilterOn
                    ? "Nobody fits these filters and the people you know. Widen the filters, or show everyone."
                    : "Nobody fits these filters. Try widening them."}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Is a warp intro on screen right now?
 *
 * Module scope so the snapshot function's identity is stable — `useSyncExternalStore` re-reads
 * on every render, and a fresh closure each time would subscribe and unsubscribe forever. It
 * returns a primitive, so an intro state change that does not cross this boundary (the collapse
 * beginning, say) re-renders nothing.
 */
