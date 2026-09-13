"use client";

import {
  useCallback,
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
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ClusterLabelNode,
  ContactNode,
  LabeledEdge,
  NebulaNode,
  OrbitRingsNode,
  SunNode,
} from "@/components/graph/graph-nodes";
import type { InspectSelection } from "@/components/graph/contact-inspect-panel";
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
import type { PositionMap } from "@/lib/graph-positions";
import { markGraphViewportReady } from "@/lib/graph/intro-signal";
import { CAMERA_MS } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { Loader2 } from "lucide-react";

/**
 * Sole owner of the default view: sun locked to viewport center.
 * Mount with key={homeToken} so every Home click gets a fresh apply
 * (avoids cancelled effects / stale appliedToken races).
 */
function DefaultViewFitter({
  homeToken,
  layoutNodes,
  positionOverrides,
  onSettled,
}: {
  homeToken: number;
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"];
  positionOverrides: PositionMap;
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
  const overridesRef = useRef(positionOverrides);
  const onSettledRef = useRef(onSettled);
  layoutRef.current = layoutNodes;
  overridesRef.current = positionOverrides;
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

      const { maxAbsX, maxAbsY } = computeSunExtents(
        layoutRef.current,
        overridesRef.current,
        getNodes()
      );
      const zoom = zoomToFitSunCentered(maxAbsX, maxAbsY, width, height);
      const duration = homeToken <= 1 ? 0 : CAMERA_MS.move;

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
          const extents = computeSunExtents(
            layoutRef.current,
            overridesRef.current,
            getNodes()
          );
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
    timeoutId = window.setTimeout(centerNow, homeToken <= 1 ? 0 : 40);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
    // Only homeToken should retrigger — refs hold the rest
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
};

const edgeTypes: EdgeTypes = {
  labeled: LabeledEdge,
  straight: LabeledEdge,
};

/** Ambient galaxy drift — slow enough to feel alive without distracting. */
const GALAXY_DEG_PER_MIN = 3;
/**
 * How often the CSS-var rotation is committed back into node positions
 * (an O(contactCount) React state update). Spaced out further as the
 * network grows so the commit cost stays bounded; disabled entirely past
 * ROTATION_DISABLE_ABOVE contacts.
 */
function rotationCommitMs(contactCount: number): number {
  if (contactCount > 900) return 1500;
  if (contactCount > 400) return 900;
  return 450;
}
const ROTATION_DISABLE_ABOVE = 2500;

// v5: the honest-orbit layout invalidated spiral-era drag positions.
function buildStructuralNodes(
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"],
  positionOverrides: PositionMap,
  compact?: boolean
): Node[] {
  return layoutNodes.map((n) => {
    if (
      n.type === "orbitRings" ||
      n.type === "user" ||
      n.type === "clusterLabel" ||
      n.type === "nebula"
    ) {
      return {
        ...n,
        draggable: false,
      } as Node;
    }

    const d = n.data as GraphNodeData;
    const override = positionOverrides[n.id];
    return {
      ...n,
      position: override || n.position,
      draggable: !compact,
      data: {
        ...d,
        motionPaused: Boolean(override),
      },
    } as Node;
  });
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

  return (
    <ReactFlowProvider>
      <GraphCanvasInner
        key={layoutKey}
        {...props}
        filteredContacts={filteredContacts}
        layout={layout}
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
  positionOverrides,
  onPositionOverridesChange,
  selection,
  hoveredId,
  onSelect,
  onHover,
  onFocusCluster,
  filteredContacts,
  layout,
  compact,
  data,
  constellationFilterOn,
  onShowAll,
  loadingAll,
}: {
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
  positionOverrides: PositionMap;
  onPositionOverridesChange: (next: PositionMap) => void;
  selection: InspectSelection;
  hoveredId: string | null;
  onSelect: (selection: InspectSelection) => void;
  onHover: (id: string | null) => void;
  onFocusCluster: (clusterId: string) => void;
  filteredContacts: GraphPayload["contacts"];
  layout: ReturnType<typeof buildHybridGraphLayout>;
  compact?: boolean;
  data: GraphPayload;
  constellationFilterOn: boolean;
  onShowAll: () => void;
  loadingAll: boolean;
}) {
  const router = useRouter();
  const { fitView, getNodes, getViewport, setViewport } = useReactFlow();
  const storeApi = useStoreApi();
  const draggingId = useRef<string | null>(null);
  const fitViewRef = useRef(fitView);
  const getNodesRef = useRef(getNodes);
  const prevClusterZoomKey = useRef("");
  const prevPeekZoomKey = useRef("");
  fitViewRef.current = fitView;
  getNodesRef.current = getNodes;
  /** Total ambient rotation shown by the CSS var (rings + arm glow). */
  const galaxyThetaRef = useRef(0);
  const prefersReducedMotion = usePrefersReducedMotion();

  const [orbitNodes, setOrbitNodes] = useState<Node[]>(() =>
    buildStructuralNodes(layout.nodes, positionOverrides, compact)
  );

  /**
   * The initial (and every post-remount) framing pass runs before React Flow
   * has measured node DOM sizes, so it frames too tight, then snaps out to
   * the correct view ~100ms later — a visible double-zoom jump. Stay hidden
   * (chrome and starfield stay visible; only the graph itself is gated)
   * until DefaultViewFitter confirms the refined frame is applied. A safety
   * timeout reveals regardless so a stalled measurement never hides the sky
   * forever.
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
   * safety timer — since neither does anything but set this flag. It re-fires on every remount
   * of this component, which is harmless: a ready signal can only END an intro run, never start
   * one, so the per-batch remounts of a refresh cannot replay the animation.
   */
  useEffect(() => {
    if (viewportReady) markGraphViewportReady();
  }, [viewportReady]);

  const focusCompany = useMemo(() => {
    if (focusCluster) {
      const hit = data.clusters.find(
        (c) => c.id === focusCluster || c.name === focusCluster || c.company === focusCluster
      );
      return hit?.name || focusCluster;
    }
    if (company !== "all") return company;
    if (hoveredId && hoveredId !== "me") {
      const node = layout.nodes.find((n) => n.id === hoveredId);
      const d = node?.data as GraphNodeData | undefined;
      return d?.clusterName || d?.company || null;
    }
    if (selection?.type === "contact") {
      return selection.data.clusterName || selection.data.company || null;
    }
    return null;
  }, [focusCluster, company, hoveredId, selection, layout.nodes, data.clusters]);

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

  const nodes = useMemo(() => {
    return orbitNodes.map((n) => {
      if (n.type === "orbitRings") {
        return n;
      }
      if (n.type === "user") {
        return {
          ...n,
          selected: selection?.type === "user",
        } as Node;
      }
      if (n.type === "clusterLabel" || n.type === "nebula") {
        const nebula = n.data as NebulaData | { company?: string };
        const co =
          "company" in nebula
            ? nebula.company
            : (n.data as { label?: string }).label;
        return {
          ...n,
          hidden: false,
          style: {
            opacity: clusterEmphasis(co, focusCompany, company, searchDimActive),
            transition: "opacity 200ms ease",
          },
        } as Node;
      }

      const d = n.data as GraphNodeData;
      const emphasis = starEmphasis(n.id, focusState);
      const isHovered = hoveredId === n.id;
      const hasOverride = Boolean(positionOverrides[n.id]);

      return {
        ...n,
        selected: emphasis.selected,
        hidden: false,
        data: {
          ...d,
          motionPaused: isHovered || emphasis.selected || hasOverride,
          spotlight: emphasis.spotlight,
          spotlightSolo: emphasis.spotlightSolo,
        },
        style: {
          opacity: emphasis.opacity,
          transition: "opacity 200ms ease",
        },
      } as Node;
    });
  }, [
    orbitNodes,
    hoveredId,
    selection,
    searchHitIds,
    searchDimActive,
    positionOverrides,
    focusCompany,
    company,
  ]);

  const edges = useMemo(() => {
    const mapped = layout.edges
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

        return {
          ...e,
          type: "labeled" as const,
          label: undefined,
          animated: false,
          data: { ...e.data, label: undefined },
          style: { ...e.style, opacity, strokeWidth },
        } as Edge;
      });

    return mapped;
  }, [
    layout.edges,
    focusCluster,
    hoveredId,
    selection,
    searchHitIds,
    searchDimActive,
  ]);

  /**
   * Ambient sky rotation. Every frame the accrued angle lands on a CSS var
   * (rings rotate on the compositor, no React render); every
   * rotationCommitMs(count) the pending delta is committed to node state as a
   * plain rigid rotation about the sun — spaced out further as the network
   * grows so the commit cost stays bounded, and disabled entirely past
   * ROTATION_DISABLE_ABOVE contacts. Paused while dragging, while the
   * inspect panel is open, while a search spotlight is active (a studied
   * star must hold still), in the compact card, in hidden tabs, and under
   * prefers-reduced-motion. State lives inside GraphCanvasInner, so a
   * layoutKey remount resets θ to 0 alongside the freshly built (unrotated)
   * layout — the stale CSS var dies with the old React Flow DOM node.
   */
  useEffect(() => {
    if (compact || prefersReducedMotion || selection || searchDimActive) return;
    if (filteredContacts.length > ROTATION_DISABLE_ABOVE) return;

    const commitMs = rotationCommitMs(filteredContacts.length);
    let frame = 0;
    let last = performance.now();
    let lastCommit = last;
    let pendingDelta = 0;

    const commitPending = () => {
      const delta = pendingDelta;
      if (delta === 0) return;
      pendingDelta = 0;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      setOrbitNodes((prev) =>
        prev.map((n) => {
          if (
            n.type !== "contact" &&
            n.type !== "nebula" &&
            n.type !== "clusterLabel"
          ) {
            return n;
          }
          if (draggingId.current === n.id) return n;
          const ux = n.position.x;
          const uy = n.position.y;
          const position = {
            x: ux * cos - uy * sin,
            y: ux * sin + uy * cos,
          };
          if (n.type !== "contact") return { ...n, position };
          const d = n.data as GraphNodeData;
          return {
            ...n,
            position,
            data: {
              ...d,
              orbitAngle: Math.atan2(position.y, position.x),
              orbitRadius: Math.hypot(position.x, position.y),
            },
          };
        })
      );
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      if (draggingId.current !== null || document.hidden) return;

      const delta = (((GALAXY_DEG_PER_MIN / 60) * Math.PI) / 180) * dt;
      pendingDelta += delta;
      galaxyThetaRef.current += delta;
      storeApi
        .getState()
        .domNode?.style.setProperty(
          "--galaxy-rot",
          `${galaxyThetaRef.current.toFixed(6)}rad`
        );

      if (now - lastCommit >= commitMs) {
        lastCommit = now;
        commitPending();
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // Keep stars in step with the CSS-var rotation across pauses
      commitPending();
    };
  }, [
    compact,
    prefersReducedMotion,
    selection,
    searchDimActive,
    storeApi,
    filteredContacts.length,
  ]);

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

  // Cluster pill / search cluster focus — retry until nodes exist; stable deps
  useEffect(() => {
    if (!focusCluster) return;
    const key = `${focusCluster}::${zoomToken}`;
    if (key === prevClusterZoomKey.current) return;

    let cancelled = false;
    let attempts = 0;

    const run = () => {
      if (cancelled) return;

      const cluster = data.clusters.find(
        (c) =>
          c.id === focusCluster ||
          c.name === focusCluster ||
          c.company === focusCluster
      );
      const matchIds = cluster?.contactIds?.length
        ? cluster.contactIds
        : filteredContacts
            .filter(
              (c) =>
                c.company === focusCluster ||
                (c.school || "").trim() === focusCluster
            )
            .map((c) => c.id);

      const present = new Set(getNodesRef.current().map((n) => n.id));
      let nodesToFit = matchIds.filter((id) => present.has(id));

      // Fallback: use layout positions if RF hasn't registered ids yet
      if (nodesToFit.length === 0) {
        nodesToFit = matchIds.filter((id) =>
          layout.nodes.some((n) => n.id === id)
        );
      }

      if (nodesToFit.length === 0 && attempts < 15) {
        attempts += 1;
        window.setTimeout(run, 40);
        return;
      }
      if (nodesToFit.length === 0) return;

      prevClusterZoomKey.current = key;
      void fitViewRef.current({
        nodes: nodesToFit.map((id) => ({ id })),
        padding: 0.4,
        // Snappy direct flight: pan and zoom move together, no arc.
        duration: CAMERA_MS.snap,
        interpolate: "linear",
        maxZoom: 1.5,
        minZoom: 0.2,
      });
    };

    const timer = window.setTimeout(run, 50);
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
      const present = getNodesRef.current().some((n) => n.id === peekPersonId);
      if (!present) return;
      prevPeekZoomKey.current = key;
      void fitViewRef.current({
        nodes: [{ id: peekPersonId }],
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
      const matchIds = nodes
        .filter((n) => {
          if (n.type !== "contact") return false;
          if (searchHitIds.size > 0) return searchHitIds.has(n.id);
          return contactMatchesLocal(n.data as GraphNodeData, searchQuery);
        })
        .map((n) => n.id);
      if (matchIds.length === 0) return;
      void fitViewRef.current({
        nodes: matchIds.map((nid) => ({ id: nid })),
        // Multi-hit padding leaves headroom so the slow ambient rotation
        // doesn't immediately drift an edge hit out of frame.
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
      if (node.id === "rings") return;

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
      if (
        node.id === "rings" ||
        node.id === "me" ||
        node.type === "clusterLabel" ||
        node.type === "nebula"
      ) {
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

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setOrbitNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStart: OnNodeDrag = useCallback((_, node) => {
    if (node.type === "contact") draggingId.current = node.id;
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_, node) => {
      draggingId.current = null;
      if (node.type !== "contact") return;
      const next = {
        ...positionOverrides,
        [node.id]: { x: node.position.x, y: node.position.y },
      };
      onPositionOverridesChange(next);
      const angle = Math.atan2(node.position.y, node.position.x);
      const radius = Math.hypot(node.position.x, node.position.y);
      setOrbitNodes((prev) =>
        prev.map((n) =>
          n.id === node.id
            ? {
                ...n,
                position: node.position,
                data: {
                  ...(n.data as GraphNodeData),
                  orbitAngle: angle,
                  orbitRadius: radius,
                  motionPaused: true,
                },
              }
            : n
        )
      );
    },
    [positionOverrides, onPositionOverridesChange]
  );

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
            positionOverrides,
            instance.getNodes()
          );
          const zoom = zoomToFitSunCentered(maxAbsX, maxAbsY, w, h);
          void instance.setViewport({ x: w / 2, y: h / 2, zoom });
        }}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "straight",
          selectable: false,
          focusable: false,
        }}
        nodesDraggable={!compact}
        className="constellation-stage"
      >
        <DefaultViewFitter
          key={homeToken}
          homeToken={homeToken}
          layoutNodes={layout.nodes}
          positionOverrides={positionOverrides}
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
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-white/10 bg-[#080b12]/90 px-6 py-5 text-center shadow-xl backdrop-blur-md">
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
