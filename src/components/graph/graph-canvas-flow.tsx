"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  useStoreApi,
  type Node,
  type Edge,
  type EdgeTypes,
  type NodeMouseHandler,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ClusterLabelNode,
  ContactNode,
  LabeledEdge,
  NebulaNode,
  OrbitRingsNode,
  StarDustNode,
  SunNode,
  type StarDustData,
  type StarDustPoint,
} from "@/components/graph/graph-nodes";
import type {
  GraphChartProps,
  GraphPayload,
} from "@/components/graph/graph-chart-types";
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
import { starVisual } from "@/lib/graph/star-style";
import { markGraphViewportReady } from "@/lib/graph/intro-signal";
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
  const { setCenter, getNodes } = useReactFlow();
  const storeApi = useStoreApi();
  const layoutRef = useRef(layoutNodes);
  const onSettledRef = useRef(onSettled);
  layoutRef.current = layoutNodes;
  onSettledRef.current = onSettled;

  useEffect(() => {
    if (homeToken <= 0) return;

    let cancelled = false;
    let tries = 0;
    let timeoutId: number | undefined;

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

      const { maxAbsX, maxAbsY } = computeSunExtents(layoutRef.current, getNodes());
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
        // One refine after layout settles (no animation) — the first pass
        // above ran before nodes were DOM-measured, so it under-estimates
        // extents and frames too tight. This is the frame callers should
        // actually reveal.
        timeoutId = window.setTimeout(() => {
          if (cancelled) return;
          const size = storeApi.getState();
          if (size.width < 48 || size.height < 48) {
            onSettledRef.current?.();
            return;
          }
          const extents = computeSunExtents(layoutRef.current, getNodes());
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
        }, 100);
      });
    };

    // Defer one frame so pane dimensions are current after filter resets
    timeoutId = window.setTimeout(centerNow, animate ? 40 : 0);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
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
  nebula: NebulaNode,
  starDust: StarDustNode,
};

const edgeTypes: EdgeTypes = {
  labeled: LabeledEdge,
  straight: LabeledEdge,
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

/** A refresh or filter that brings in more people than this skips the entrance animation. */
const ENTRANCE_MAX = 400;
/** How long a newly arrived star keeps its entrance class (the animation is 450ms). */
const ENTRANCE_CLEAR_MS = 700;

const STAR_DUST_ID = "star-dust";
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
 * its predecessor's `measured` box, which React Flow otherwise forgets and re-measures.
 */
function buildStructuralNodes(layoutNodes: LayoutNodes, previous: Node[] | null): Node[] {
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
      ...(prev && prev.type === n.type && prev.measured ? { measured: prev.measured } : null),
    } as Node;
  });
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
  const { fitView, fitBounds, getNodes, getViewport, setViewport } = useReactFlow();
  const storeApi = useStoreApi();
  const prevClusterZoomKey = useRef("");
  const prevPeekZoomKey = useRef("");

  const [sky, setSky] = useState<SkyState>(() => {
    const ids = contactIds(layout.nodes);
    return {
      layout,
      layoutKey,
      epoch: 0,
      nodes: buildStructuralNodes(layout.nodes, null),
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
      nodes: buildStructuralNodes(layout.nodes, sky.nodes),
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
    if (viewportReady) markGraphViewportReady();
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
    check(storeApi.getState().transform[2]);
    return storeApi.subscribe((s) => check(s.transform[2]));
  }, [summaryAllowed, viewportReady, storeApi]);
  // Crossing into the detail view mounts every visible star at once. Deferred, that commit
  // yields to the zoom gesture that caused it instead of stalling it.
  const summary = useDeferredValue(summaryAllowed && summaryWanted);

  // From the layout rather than `orbitNodes`: positions and data are the same, and this way
  // React Flow reporting a measurement does not rebuild it.
  const skyLayoutNodes = sky.layout.nodes;
  const contactById = useMemo(() => {
    const map = new Map<string, LayoutNodes[number]>();
    for (const n of skyLayoutNodes) if (n.type === "contact") map.set(n.id, n);
    return map;
  }, [skyLayoutNodes]);

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

  /**
   * Every contact, as the dots the summary view draws in place of stars. Built only while the
   * summary is on, and rebuilt only when the sky or the emphasis changes — never per frame.
   */
  const starDust = useMemo((): StarDustData | null => {
    if (!summary) return null;
    const points: StarDustPoint[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of skyLayoutNodes) {
      if (n.type !== "contact") continue;
      const d = n.data as GraphNodeData;
      const { disc, fill, alphaScale } = starVisual(d, false);
      const opacity = starEmphasis(n.id, focusState).opacity;
      points.push({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        disc,
        color: d.comet ? "#ff6b4a" : fill,
        alpha: Math.min(1, 0.9 * alphaScale * opacity),
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
  }, [summary, skyLayoutNodes, focusState]);

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

  const nodes = useMemo(() => {
    const out: Node[] = [];
    if (starDustNode) out.push(starDustNode);

    for (const n of orbitNodes) {
      if (n.type === "orbitRings") {
        out.push(n);
        continue;
      }
      if (n.type === "user") {
        const selected = selection?.type === "user";
        out.push(withEmphasis(n, selected ? "sel" : "", () => ({ ...n, selected }) as Node));
        continue;
      }
      if (n.type === "clusterLabel" || n.type === "nebula") {
        const nebula = n.data as NebulaData | { company?: string };
        const co =
          "company" in nebula
            ? nebula.company
            : (n.data as { label?: string }).label;
        const opacity = clusterEmphasis(co, focusCompany, company, searchDimActive);
        const isLabel = n.type === "clusterLabel";
        const label = n.data as ClusterLabelData;
        out.push(
          withEmphasis(
            n,
            `${opacity}|${isLabel && summary}`,
            () =>
              ({
                ...n,
                hidden: false,
                ...(isLabel
                  ? {
                      data: { ...label, summary },
                      ariaLabel: summary
                        ? `${label.label}, ${label.count ?? 0} ${
                            label.count === 1 ? "person" : "people"
                          }. Zoom in`
                        : `Zoom to ${label.label}`,
                    }
                  : null),
                style: { opacity, transition: "opacity 200ms ease" },
              }) as Node
          )
        );
        continue;
      }

      const d = n.data as GraphNodeData;
      const emphasis = starEmphasis(n.id, focusState);
      const isHovered = hoveredId === n.id;
      // Anyone the reader asked about keeps a name at every zoom (see graph-nodes.tsx), and
      // stays a real star through the summary view.
      const labelPinned = isHovered || emphasis.selected || emphasis.spotlight;
      if (summary && !labelPinned && n.id !== peekPersonId) continue;
      const raised = isHovered || emphasis.selected;
      const entering = sky.entering.has(n.id);

      out.push(
        withEmphasis(
          n,
          `${emphasis.opacity}|${emphasis.selected}|${emphasis.spotlight}|${emphasis.spotlightSolo}|${raised}|${labelPinned}|${entering}`,
          () =>
            ({
              ...n,
              selected: emphasis.selected,
              hidden: false,
              data: {
                ...d,
                raised,
                labelPinned,
                entering,
                spotlight: emphasis.spotlight,
                spotlightSolo: emphasis.spotlightSolo,
              },
              style: {
                opacity: emphasis.opacity,
                transition: "opacity 200ms ease",
              },
            }) as Node
        )
      );
    }
    return out;
  }, [
    orbitNodes,
    starDustNode,
    summary,
    hoveredId,
    peekPersonId,
    selection,
    focusState,
    searchDimActive,
    focusCompany,
    company,
    sky.entering,
  ]);

  const edges = useMemo(() => {
    // The summary view draws clusters, not people, and a figure line needs both its stars.
    if (summary) return [];
    return layout.edges
      .filter((e) => {
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
  }, [summary, layout.edges, focusCluster, focusState]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomToken owns reframes
  }, [focusCluster, zoomToken, hasSearch]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.id === "rings" || node.id === STAR_DUST_ID) return;

      if (node.type === "clusterLabel" || node.type === "nebula") {
        if (compact) return;
        const d = node.data as ClusterLabelData | NebulaData;
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
    (_, node) => {
      if (node.type !== "contact") {
        onHover(null);
        return;
      }
      onHover(node.id);
    },
    [onHover]
  );

  const onNodeMouseLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  // Carries React Flow's measurements (and selection) into the nodes it is handed next. Only
  // changes that land on a stored node count: the star-dust node is derived, never stored, and
  // a no-op must not hand back a new array — that re-derives every node and re-renders the sky.
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setSky((s) => {
      const ids = new Set(s.nodes.map((n) => n.id));
      const relevant = changes.filter((c) => "id" in c && ids.has(c.id));
      if (relevant.length === 0) return s;
      return { ...s, nodes: applyNodeChanges(relevant, s.nodes) };
    });
  }, []);

  const isEmpty = filteredContacts.length === 0;

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={isEmpty ? [] : edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
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
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "straight",
          selectable: false,
          focusable: false,
        }}
        nodesDraggable={false}
        className="constellation-stage"
      >
        <DefaultViewFitter
          key={`${homeToken}:${sky.epoch}`}
          homeToken={homeToken}
          animate={homeToken > 1 || sky.epoch > 0}
          layoutNodes={layout.nodes}
          onSettled={() => setViewportReady(true)}
        />
        <Background
          gap={48}
          color="rgba(255, 255, 255, 0.03)"
          size={1}
          style={{ background: "transparent" }}
        />
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
