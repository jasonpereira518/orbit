"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ReactFlow,
  Background,
  useReactFlow,
  ReactFlowProvider,
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
  getGraphData,
  refreshConstellationBatch,
} from "@/actions/graph";
import { searchDashboardContacts } from "@/actions/search";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ClusterLabelNode,
  ContactNode,
  LabeledEdge,
  NebulaNode,
  OrbitRingsNode,
  SunNode,
} from "@/components/graph/graph-nodes";
import {
  ContactInspectPanel,
  type InspectSelection,
} from "@/components/graph/contact-inspect-panel";
import {
  buildHybridGraphLayout,
  type GraphNodeData,
  type GroupingMode,
  type NebulaData,
  type OrbitRingsData,
} from "@/lib/graph-layout";
import { clusterBrandColor } from "@/lib/school-color";
import { cn } from "@/lib/utils";
import {
  Filter,
  Home,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;
type LabelMode = "always" | "hover" | "never";
type LinksMode = "on" | "auto" | "off";
type PositionMap = Record<string, { x: number; y: number }>;

/**
 * Half-extents from the sun at (0, 0). Zoom is derived from how far
 * stars/labels/nebulae extend so everyone fits while you stay centered.
 */
function computeSunExtents(
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"],
  positionOverrides: PositionMap,
  liveNodes: Node[]
): { maxAbsX: number; maxAbsY: number } {
  let maxAbsX = 240;
  let maxAbsY = 240;

  const expand = (x: number, y: number, halfW: number, halfH: number) => {
    maxAbsX = Math.max(maxAbsX, Math.abs(x) + halfW);
    maxAbsY = Math.max(maxAbsY, Math.abs(y) + halfH);
  };

  for (const n of layoutNodes) {
    if (n.type === "contact") {
      expand(n.position.x, n.position.y, 56, 64);
      continue;
    }
    if (n.type === "user") {
      expand(n.position.x, n.position.y, 64, 64);
      continue;
    }
    if (n.type === "clusterLabel") {
      expand(n.position.x, n.position.y, 120, 32);
      continue;
    }
    if (n.type === "nebula") {
      const r = (n.data as NebulaData).radius || 80;
      expand(n.position.x, n.position.y, r, r);
    }
  }

  for (const pos of Object.values(positionOverrides)) {
    expand(pos.x, pos.y, 56, 64);
  }

  for (const n of liveNodes) {
    if (n.hidden) continue;
    if (n.type === "orbitRings") continue;
    const halfW = Math.max(24, (n.measured?.width ?? 48) / 2);
    const halfH = Math.max(24, (n.measured?.height ?? 48) / 2);
    if (n.type === "nebula") {
      const r = (n.data as NebulaData).radius || Math.max(halfW, halfH);
      expand(n.position.x, n.position.y, r, r);
      continue;
    }
    if (
      n.type === "contact" ||
      n.type === "user" ||
      n.type === "clusterLabel" ||
      n.id === "me"
    ) {
      expand(n.position.x, n.position.y, halfW, halfH);
    }
  }

  return { maxAbsX, maxAbsY };
}

function zoomToFitSunCentered(
  maxAbsX: number,
  maxAbsY: number,
  width: number,
  height: number
): number {
  // Padding factor so stars aren't flush against the pane edge
  const pad = 1.18;
  const zoomX = width / (2 * maxAbsX * pad);
  const zoomY = height / (2 * maxAbsY * pad);
  return Math.min(1.35, Math.max(0.05, Math.min(zoomX, zoomY)));
}

/**
 * Sole owner of the default view: sun locked to viewport center.
 * Mount with key={homeToken} so every Home click gets a fresh apply
 * (avoids cancelled effects / stale appliedToken races).
 */
function DefaultViewFitter({
  homeToken,
  layoutNodes,
  positionOverrides,
}: {
  homeToken: number;
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"];
  positionOverrides: PositionMap;
}) {
  const { setCenter, getNodes } = useReactFlow();
  const storeApi = useStoreApi();
  const layoutRef = useRef(layoutNodes);
  const overridesRef = useRef(positionOverrides);
  layoutRef.current = layoutNodes;
  overridesRef.current = positionOverrides;

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
      const duration = homeToken <= 1 ? 0 : 450;

      void setCenter(0, 0, { zoom, duration }).then((ok) => {
        if (cancelled) return;
        if (!ok) {
          if (tries < 80) {
            tries += 1;
            timeoutId = window.setTimeout(centerNow, 32);
          }
          return;
        }
        // One refine after layout settles (no animation)
        timeoutId = window.setTimeout(() => {
          if (cancelled) return;
          const size = storeApi.getState();
          if (size.width < 48 || size.height < 48) return;
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
          void setCenter(0, 0, { zoom: z, duration: 0 });
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

const HIGH_NODE_THRESHOLD = 80;
const ORBIT_DEG_PER_SEC = 2.2;

function positionsStorageKey(userId: string) {
  return `orbit-graph-positions-v4:${userId}`;
}

function loadPositions(userId: string): PositionMap {
  try {
    const raw = localStorage.getItem(positionsStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PositionMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePositions(userId: string, positions: PositionMap) {
  try {
    localStorage.setItem(positionsStorageKey(userId), JSON.stringify(positions));
  } catch {
    // ignore quota / private mode
  }
}

function contactMatchesLocal(d: GraphNodeData, q: string): boolean {
  if (!q) return true;
  const hay = [
    d.label,
    d.fullName,
    d.preferredName,
    d.company,
    d.school,
    d.title,
    d.aiSummary,
    d.howMet,
    d.metContext,
    d.email,
    d.phone,
    d.linkedinUrl,
    d.website,
    d.clusterName,
    ...(d.tags || []),
    ...(d.keyFacts || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const phrase = q.trim().toLowerCase();
  if (!phrase) return true;
  if (hay.includes(phrase)) return true;
  const tokens = phrase
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return false;
  return tokens.every((t) => hay.includes(t));
}

type GraphContact = GraphPayload["contacts"][number];
type GraphCluster = GraphPayload["clusters"][number];

function contactSearchHaystack(c: GraphContact): string {
  return [
    c.fullName,
    c.preferredName,
    c.company,
    c.school,
    c.title,
    c.aiSummary,
    c.howMet,
    c.metContext,
    c.notes,
    c.email,
    c.phone,
    c.linkedinUrl,
    c.website,
    ...(c.tags || []),
    ...(c.keyFacts || []),
    ...(c.sharedInterests || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchGraphContacts(contacts: GraphContact[], query: string): string[] {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return [];
  const tokens = phrase
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1);

  return contacts
    .filter((c) => {
      const hay = contactSearchHaystack(c);
      if (hay.includes(phrase)) return true;
      if (tokens.length === 0) return false;
      if (tokens.length === 1) return hay.includes(tokens[0]);
      // Multi-word: prefer all tokens; allow strong partial if ≥2 long tokens hit
      if (tokens.every((t) => hay.includes(t))) return true;
      const strong = tokens.filter((t) => t.length >= 4 && hay.includes(t));
      return strong.length >= 2;
    })
    .map((c) => c.id);
}

function findClusterMatch(
  clusters: GraphCluster[],
  query: string
): GraphCluster | null {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase || clusters.length === 0) return null;

  const exact = clusters.find((c) => c.name.toLowerCase() === phrase);
  if (exact) return exact;

  const starts = clusters.filter((c) =>
    c.name.toLowerCase().startsWith(phrase)
  );
  if (starts.length === 1) return starts[0];

  const includes = clusters
    .filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes(phrase) || phrase.includes(name);
    })
    .sort((a, b) => a.name.length - b.name.length);
  if (includes.length === 1) return includes[0];
  if (includes.length > 1 && phrase.length >= 3) {
    // Prefer the shortest name that still contains the query (e.g. "AWS")
    return includes[0];
  }
  return null;
}

function resolveSearchTarget(
  query: string,
  matchIds: string[],
  clusters: GraphCluster[]
):
  | { mode: "cluster"; id: string }
  | { mode: "nodes"; ids: string[] }
  | { mode: "none" } {
  // Cluster-name query (e.g. "AWS") — zoom that constellation
  const clusterByName = findClusterMatch(clusters, query);
  if (clusterByName && matchIds.length === 0) {
    return { mode: "cluster", id: clusterByName.id };
  }
  if (
    clusterByName &&
    clusterByName.name.toLowerCase() === query.trim().toLowerCase()
  ) {
    return { mode: "cluster", id: clusterByName.id };
  }

  if (matchIds.length === 0) return { mode: "none" };

  // Single person → frame their whole constellation (highlight stays on them only)
  if (matchIds.length === 1) {
    const cluster = clusters.find((cl) => cl.contactIds.includes(matchIds[0]));
    if (cluster) return { mode: "cluster", id: cluster.id };
    return { mode: "nodes", ids: matchIds };
  }

  const counts = new Map<string, number>();
  for (const id of matchIds) {
    const cluster = clusters.find((cl) => cl.contactIds.includes(id));
    if (!cluster) continue;
    counts.set(cluster.id, (counts.get(cluster.id) || 0) + 1);
  }

  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }

  // Group of people mostly in one constellation → zoom the cluster
  if (best && bestN >= 2 && bestN >= Math.ceil(matchIds.length * 0.5)) {
    return { mode: "cluster", id: best };
  }

  return { mode: "nodes", ids: matchIds };
}

function Starfield() {
  const stars = useMemo(
    () =>
      Array.from({ length: 220 }, (_, i) => ({
        id: i,
        left: `${(((i * 47 + 13) * 7) % 1000) / 10}%`,
        top: `${(((i * 83 + 29) * 11) % 1000) / 10}%`,
        size: i % 17 === 0 ? 2.2 : i % 5 === 0 ? 1.4 : 0.8,
        delay: `${(i % 11) * 0.35}s`,
        dur: `${2.8 + (i % 6) * 0.7}s`,
        opacity: 0.25 + (i % 8) * 0.08,
      })),
    []
  );

  return (
    <div
      className="constellation-starfield pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <div className="constellation-milky-way absolute inset-0" />
      {stars.map((s) => (
        <span
          key={s.id}
          className="absolute rounded-full bg-white"
          style={
            {
              left: s.left,
              top: s.top,
              width: s.size,
              height: s.size,
              opacity: s.opacity,
              "--twinkle-delay": s.delay,
              "--twinkle-dur": s.dur,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function buildStructuralNodes(
  layoutNodes: ReturnType<typeof buildHybridGraphLayout>["nodes"],
  positionOverrides: PositionMap,
  motionEnabled: boolean,
  prefersReducedMotion: boolean,
  compact?: boolean
): Node[] {
  return layoutNodes.map((n) => {
    if (n.type === "orbitRings") {
      const rings = n.data as OrbitRingsData;
      return {
        ...n,
        data: {
          ...rings,
          showLabels: false,
          motionEnabled: motionEnabled && !prefersReducedMotion,
        },
      } as Node;
    }
    if (
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
        motionEnabled,
        motionPaused: Boolean(override),
      },
    } as Node;
  });
}

function GraphCanvas(props: {
  data: GraphPayload;
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
  grouping: GroupingMode;
  labelMode: LabelMode;
  linksMode: LinksMode;
  motionEnabled: boolean;
  positionOverrides: PositionMap;
  onPositionOverridesChange: (next: PositionMap) => void;
  selection: InspectSelection;
  hoveredId: string | null;
  onSelect: (selection: InspectSelection) => void;
  onHover: (id: string | null) => void;
  resetToken: number;
  compact?: boolean;
  showEdgeLabels: boolean;
}) {
  const filteredContacts = useMemo(() => {
    const kw = props.keyword.trim().toLowerCase();
    return props.data.contacts.filter((c) => {
      if (props.company !== "all" && c.company !== props.company) return false;
      if (props.school !== "all" && (c.school || "") !== props.school) {
        return false;
      }
      const orbit = c.orbitScore ?? c.relationshipScore ?? 1;
      if (orbit < Number(props.minScore)) return false;
      if (kw) {
        const hay = [
          c.fullName,
          c.preferredName,
          c.company,
          c.school,
          c.title,
          c.aiSummary,
          ...(c.tags || []),
          ...(c.keyFacts || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [
    props.data.contacts,
    props.company,
    props.school,
    props.keyword,
    props.minScore,
  ]);

  const layout = useMemo(() => {
    return buildHybridGraphLayout(filteredContacts, props.data.summary.userName, {
      grouping: props.grouping,
    });
  }, [filteredContacts, props.data.summary.userName, props.grouping]);

  const layoutKey = useMemo(() => {
    const ids = filteredContacts.map((c) => c.id).join(",");
    return [
      props.grouping,
      props.company,
      props.school,
      props.keyword,
      props.minScore,
      props.resetToken,
      ids,
    ].join("|");
  }, [
    filteredContacts,
    props.grouping,
    props.company,
    props.school,
    props.keyword,
    props.minScore,
    props.resetToken,
  ]);

  return (
    <GraphCanvasInner
      key={layoutKey}
      {...props}
      filteredContacts={filteredContacts}
      layout={layout}
    />
  );
}

function GraphCanvasInner({
  company,
  school,
  keyword,
  minScore,
  search,
  searchHitIds,
  focusCluster,
  zoomToken,
  homeToken,
  peekPersonId,
  peekToken,
  grouping,
  labelMode,
  linksMode,
  motionEnabled,
  positionOverrides,
  onPositionOverridesChange,
  selection,
  hoveredId,
  onSelect,
  onHover,
  filteredContacts,
  layout,
  compact,
  showEdgeLabels,
  data,
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
  grouping: GroupingMode;
  labelMode: LabelMode;
  linksMode: LinksMode;
  motionEnabled: boolean;
  positionOverrides: PositionMap;
  onPositionOverridesChange: (next: PositionMap) => void;
  selection: InspectSelection;
  hoveredId: string | null;
  onSelect: (selection: InspectSelection) => void;
  onHover: (id: string | null) => void;
  filteredContacts: GraphPayload["contacts"];
  layout: ReturnType<typeof buildHybridGraphLayout>;
  compact?: boolean;
  showEdgeLabels: boolean;
  data: GraphPayload;
}) {
  const router = useRouter();
  const { fitView, getNodes } = useReactFlow();
  const draggingId = useRef<string | null>(null);
  const fitViewRef = useRef(fitView);
  const getNodesRef = useRef(getNodes);
  const prevClusterZoomKey = useRef("");
  const prevPeekZoomKey = useRef("");
  fitViewRef.current = fitView;
  getNodesRef.current = getNodes;
  const orbitAngles = useRef<Map<string, number>>(new Map());
  const [prefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  const [orbitNodes, setOrbitNodes] = useState<Node[]>(() =>
    buildStructuralNodes(
      layout.nodes,
      positionOverrides,
      motionEnabled,
      typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      compact
    )
  );

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

  const nodes = useMemo(() => {
    return orbitNodes.map((n) => {
      if (n.type === "orbitRings") {
        const rings = n.data as OrbitRingsData;
        return {
          ...n,
          data: {
            ...rings,
            showLabels: false,
            motionEnabled: motionEnabled && !prefersReducedMotion,
          },
        } as Node;
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
        const hidden =
          Boolean(focusCompany) && co !== focusCompany && company === "all";
        return {
          ...n,
          hidden: false,
          style: {
            opacity: hidden && hasSearch ? 0.15 : 1,
            transition: "opacity 200ms ease",
          },
        } as Node;
      }

      const d = n.data as GraphNodeData;
      const isHovered = hoveredId === n.id;
      const isSelected = selection?.type === "contact" && selection.id === n.id;
      // Spotlight only explicit search hits — not every star in a zoomed cluster
      const spotlight = hasSearch && searchHitIds.has(n.id);
      const dimFromSearch = hasSearch && !spotlight;
      const dimFromFocus =
        Boolean(hoveredId || selection?.type === "contact") &&
        !isHovered &&
        !isSelected;
      const dim = dimFromSearch || dimFromFocus;
      const hasOverride = Boolean(positionOverrides[n.id]);

      return {
        ...n,
        selected: isSelected,
        hidden: false,
        data: {
          ...d,
          labelMode,
          motionEnabled,
          motionPaused: isHovered || isSelected || hasOverride,
          spotlight,
        },
        style: {
          opacity: dim ? 0.12 : 1,
          transition: "opacity 200ms ease",
        },
      } as Node;
    });
  }, [
    orbitNodes,
    hoveredId,
    selection,
    searchQuery,
    searchHitIds,
    hasSearch,
    labelMode,
    motionEnabled,
    prefersReducedMotion,
    positionOverrides,
    focusCompany,
    company,
  ]);

  const edges = useMemo(() => {
    const contactCount = filteredContacts.length;
    const showPeerLinks =
      linksMode === "on" ||
      (linksMode === "auto" &&
        (contactCount < HIGH_NODE_THRESHOLD || Boolean(focusCompany)));

    const nodeById = new Map(
      layout.nodes.map((n) => [n.id, n.data as GraphNodeData | undefined])
    );

    return layout.edges
      .filter((e) => {
        const kind = e.data?.kind;
        // Never draw spokes to the sun — only peer constellation / knows links
        if (kind === "solar") return false;
        if (kind !== "constellation" && kind !== "knows") return false;
        if (linksMode === "off") return false;
        if (!showPeerLinks) return false;
        if (
          linksMode === "auto" &&
          contactCount >= HIGH_NODE_THRESHOLD &&
          focusCompany
        ) {
          if (kind === "constellation") {
            return e.data?.company === focusCompany;
          }
          const sourceCo = nodeById.get(e.source)?.company;
          const targetCo = nodeById.get(e.target)?.company;
          return sourceCo === focusCompany || targetCo === focusCompany;
        }
        if (linksMode === "auto" && contactCount >= HIGH_NODE_THRESHOLD) {
          return kind === "constellation";
        }
        return true;
      })
      .map((e) => {
        const relatedToHover =
          hoveredId && (e.source === hoveredId || e.target === hoveredId);

        const relatedToSelection =
          selection?.type === "contact" &&
          (e.source === selection.id || e.target === selection.id);

        const dimOthers = Boolean(hoveredId || selection?.type === "contact");
        const emphasized = relatedToHover || relatedToSelection;

        let opacity = Number(e.style?.opacity ?? 0.5);
        const edgeKind = e.data?.kind;
        if (hasSearch) {
          const sourceOk = searchHitIds.has(e.source);
          const targetOk = searchHitIds.has(e.target);
          if (focusCluster && edgeKind === "constellation") {
            // Framing a cluster for a person search — keep constellation lines,
            // slightly emphasize edges that touch the highlighted person
            if (sourceOk || targetOk) {
              opacity = Math.min(1, opacity + 0.25);
            }
          } else if (!(sourceOk && targetOk)) {
            opacity = 0.06;
          }
        }
        if (dimOthers && !emphasized) {
          opacity = Math.min(opacity, 0.1);
        } else if (emphasized) {
          opacity = Math.min(1, opacity + 0.35);
        }

        const kind = edgeKind;
        const useLabeled =
          showEdgeLabels &&
          (kind === "constellation" || kind === "knows") &&
          (Boolean(focusCompany) ||
            emphasized ||
            hasSearch ||
            contactCount < 40);

        return {
          ...e,
          type: "labeled" as const,
          label: useLabeled ? e.data?.label || e.label : undefined,
          animated: false,
          data: {
            ...e.data,
            label: useLabeled ? e.data?.label || e.label : undefined,
          },
          style: {
            ...e.style,
            opacity,
            strokeWidth: emphasized
              ? Number(e.style?.strokeWidth ?? 1) + 0.75
              : e.style?.strokeWidth,
          },
        } as Edge;
      });
  }, [
    layout.edges,
    layout.nodes,
    filteredContacts.length,
    linksMode,
    focusCompany,
    hoveredId,
    selection,
    searchQuery,
    searchHitIds,
    hasSearch,
    showEdgeLabels,
  ]);

  useEffect(() => {
    if (!motionEnabled || prefersReducedMotion) return;

    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const delta = ((ORBIT_DEG_PER_SEC * Math.PI) / 180) * dt;

      setOrbitNodes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          if (n.type !== "contact") return n;
          if (positionOverrides[n.id]) return n;
          if (draggingId.current === n.id) return n;
          if (hoveredId === n.id) return n;
          if (selection?.type === "contact" && selection.id === n.id) return n;

          const d = n.data as GraphNodeData;
          const radius = d.orbitRadius ?? Math.hypot(n.position.x, n.position.y);
          let angle = orbitAngles.current.get(n.id);
          if (angle === undefined) {
            angle = Math.atan2(n.position.y, n.position.x);
            orbitAngles.current.set(n.id, angle);
          }
          angle += delta;
          orbitAngles.current.set(n.id, angle);
          changed = true;
          return {
            ...n,
            position: {
              x: Math.cos(angle) * radius,
              y: Math.sin(angle) * radius,
            },
            data: { ...d, orbitAngle: angle, orbitRadius: radius },
          };
        });
        return changed ? next : prev;
      });

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    motionEnabled,
    prefersReducedMotion,
    positionOverrides,
    hoveredId,
    selection,
  ]);

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
        duration: 550,
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
        duration: 420,
        maxZoom: 1.8,
        minZoom: 0.3,
      });
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [peekPersonId, peekToken]);

  // Search hit framing (person / multi-match) when not focusing a named cluster
  useEffect(() => {
    if (focusCluster || !hasSearch) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const matchIds = nodes
        .filter((n) => {
          if (n.type !== "contact") return false;
          const d = n.data as GraphNodeData;
          return searchHitIds.has(n.id) || contactMatchesLocal(d, searchQuery);
        })
        .map((n) => n.id);
      if (matchIds.length === 0) return;
      void fitViewRef.current({
        nodes: matchIds.map((nid) => ({ id: nid })),
        padding: matchIds.length === 1 ? 0.55 : 0.35,
        duration: 400,
        maxZoom: matchIds.length === 1 ? 1.75 : 1.2,
      });
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearch, searchQuery, searchHitIds, focusCluster, zoomToken]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (
        node.id === "rings" ||
        node.type === "clusterLabel" ||
        node.type === "nebula"
      ) {
        return;
      }
      if (compact && node.type === "contact") {
        router.push(`/contacts/${node.id}`);
        return;
      }
      if (node.id === "me" || node.type === "user") {
        const d = node.data as GraphNodeData;
        const scoreCounts: Record<number, number> = {
          1: 0,
          2: 0,
          3: 0,
          4: 0,
          5: 0,
        };
        for (const c of data.contacts) {
          const s = Math.min(
            5,
            Math.max(1, c.orbitScore ?? c.relationshipScore ?? 2)
          );
          scoreCounts[s] = (scoreCounts[s] || 0) + 1;
        }
        onSelect({
          type: "user",
          data: d,
          summary: {
            total: data.summary.total,
            companyCount: data.summary.companyCount,
            scoreCounts,
            dormantCount: data.summary.dormantCount,
            overdueCount: data.summary.overdueCount,
            userImageUrl: data.summary.userImageUrl,
            userEmail: data.summary.userEmail,
            socialLinks: data.summary.socialLinks,
            goals: data.summary.goals,
          },
        });
        return;
      }
      onSelect({
        type: "contact",
        id: node.id,
        data: node.data as GraphNodeData,
      });
    },
    [onSelect, data, compact, router]
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
      orbitAngles.current.set(node.id, angle);
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
        minZoom={0.05}
        maxZoom={2.4}
        style={{ width: "100%", height: "100%" }}
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
        />
        <Background
          gap={48}
          color="rgba(255, 255, 255, 0.03)"
          size={1}
          style={{ background: "transparent" }}
        />
      </ReactFlow>

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-white/10 bg-[#080b12]/90 px-6 py-5 text-center shadow-xl backdrop-blur-md">
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
          </div>
        </div>
      )}
    </>
  );
}

const GRAPH_REFETCH_MIN_MS = 60_000;

function applyGraphPayload(
  payload: GraphPayload,
  setData: (payload: GraphPayload) => void,
  setPositionOverrides: (next: PositionMap) => void
) {
  setData(payload);
  const cleaned = positionsFromPayload(payload);
  setPositionOverrides(cleaned);
  const loaded = loadPositions(payload.userId);
  if (Object.keys(cleaned).length !== Object.keys(loaded).length) {
    savePositions(payload.userId, cleaned);
  }
}

function positionsFromPayload(payload: GraphPayload): PositionMap {
  const ids = new Set(payload.contacts.map((c) => c.id));
  const loaded = loadPositions(payload.userId);
  const cleaned: PositionMap = {};
  for (const [id, pos] of Object.entries(loaded)) {
    if (ids.has(id)) cleaned[id] = pos;
  }
  return cleaned;
}

export function NetworkGraph({
  initialData = null,
  compact = false,
}: {
  initialData?: GraphPayload | null;
  compact?: boolean;
}) {
  const [data, setData] = useState<GraphPayload | null>(initialData);
  const [company, setCompany] = useState("all");
  const [school, setSchool] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [minScore, setMinScore] = useState("1");
  const [search, setSearch] = useState("");
  const [searchHitIds, setSearchHitIds] = useState<Set<string>>(new Set());
  const [focusCluster, setFocusCluster] = useState<string | null>(null);
  const [zoomToken, setZoomToken] = useState(0);
  // Start at 1 so the map opens on the default full-map view (not RF's zoom-1 origin)
  const [homeToken, setHomeToken] = useState(1);
  const [peekPersonId, setPeekPersonId] = useState<string | null>(null);
  const [peekToken, setPeekToken] = useState(0);
  const [grouping] = useState<GroupingMode>("company");
  const [labelMode] = useState<LabelMode>("hover");
  const [linksMode] = useState<LinksMode>("on");
  const [motionEnabled] = useState(false);
  const [positionOverrides, setPositionOverrides] = useState<PositionMap>(() =>
    initialData ? positionsFromPayload(initialData) : {}
  );
  const [resetToken, setResetToken] = useState(0);
  const [selection, setSelection] = useState<InspectSelection>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [reengageOpen, setReengageOpen] = useState(false);
  const [clustersOpen, setClustersOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({
    processed: 0,
    total: 0,
  });
  const lastFetchAt = useRef(initialData ? Date.now() : 0);
  const positionsHydrated = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadData = useCallback((force = false) => {
    if (!force && Date.now() - lastFetchAt.current < GRAPH_REFETCH_MIN_MS) {
      return;
    }
    getGraphData()
      .then((payload) => {
        lastFetchAt.current = Date.now();
        applyGraphPayload(payload, setData, setPositionOverrides);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (initialData && !positionsHydrated.current) {
      positionsHydrated.current = true;
      applyGraphPayload(initialData, setData, setPositionOverrides);
      return;
    }
    if (!data) loadData(true);
  }, [initialData, data, loadData]);

  useEffect(() => {
    if (compact) return;
    let lastRefresh = 0;
    function refresh() {
      const now = Date.now();
      if (now - lastRefresh < 500) return;
      lastRefresh = now;
      loadData(false);
    }
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadData, compact]);

  const lastSearchQuery = useRef("");
  const searchRequestId = useRef(0);
  const suppressSearchHomeRef = useRef(false);

  const requestDefaultView = useCallback(() => {
    setFocusCluster(null);
    setPeekPersonId(null);
    setHoveredId(null);
    setSearchHitIds(new Set());
    setHomeToken((t) => t + 1);
  }, []);

  useEffect(() => {
    if (compact) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const q = search.trim();

    // Empty search → clear highlights and return to the default full-map view
    if (!q) {
      const wasSearching = lastSearchQuery.current.length > 0;
      lastSearchQuery.current = "";
      searchRequestId.current += 1;
      setSearchHitIds(new Set());
      setFocusCluster(null);
      setPeekPersonId(null);
      setHoveredId(null);

      if (suppressSearchHomeRef.current) {
        suppressSearchHomeRef.current = false;
        return;
      }

      if (wasSearching) {
        requestDefaultView();
      }
      return;
    }

    lastSearchQuery.current = q;

    if (!data) return;

    // Instant local match across name, role, school, tags, keywords, etc.
    const applyLocalResults = (extraIds: string[] = []) => {
      const personIds = new Set<string>([
        ...matchGraphContacts(data.contacts, q),
        ...extraIds,
      ]);
      const clusterByName = findClusterMatch(data.clusters, q);
      const qNorm = q.toLowerCase();
      const isExactClusterName =
        Boolean(clusterByName) &&
        clusterByName!.name.toLowerCase() === qNorm;

      // Searching a cluster name → highlight everyone in it and zoom there
      if (isExactClusterName && clusterByName) {
        setSearchHitIds(new Set(clusterByName.contactIds));
        setFocusCluster(clusterByName.id);
        setZoomToken((t) => t + 1);
        return;
      }

      // Cluster name with no person hits (partial cluster match)
      if (clusterByName && personIds.size === 0) {
        setSearchHitIds(new Set(clusterByName.contactIds));
        setFocusCluster(clusterByName.id);
        setZoomToken((t) => t + 1);
        return;
      }

      // Person / keyword search — highlight only matched people
      setSearchHitIds(personIds);

      const target = resolveSearchTarget(q, [...personIds], data.clusters);
      if (target.mode === "cluster") {
        // Zoom the constellation; spotlight stays on personIds only
        setFocusCluster(target.id);
      } else {
        setFocusCluster(null);
      }
      setZoomToken((t) => t + 1);
    };

    applyLocalResults();

    // Enrich with semantic hits (debounced) without dropping local matches
    searchTimer.current = setTimeout(() => {
      const req = ++searchRequestId.current;
      searchDashboardContacts(q, { limit: 40 })
        .then((hits) => {
          if (req !== searchRequestId.current) return;
          if (lastSearchQuery.current !== q) return;
          applyLocalResults(hits.map((h) => h.id));
        })
        .catch(() => {
          /* local results already applied */
        });
    }, 280);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, data, compact, requestDefaultView]);

  const userId = data?.userId;

  const handlePositionOverridesChange = useCallback(
    (next: PositionMap) => {
      setPositionOverrides(next);
      if (userId && !compact) savePositions(userId, next);
    },
    [userId, compact]
  );

  const goHome = useCallback(() => {
    if (search.trim()) {
      suppressSearchHomeRef.current = true;
    }
    lastSearchQuery.current = "";

    setSearch("");
    setCompany("all");
    setSchool("all");
    setKeyword("");
    setMinScore("1");
    setSelection(null);
    setFiltersOpen(false);
    setClustersOpen(false);
    setReengageOpen(false);
    setKeyOpen(false);

    const hadOverrides = Object.keys(positionOverrides).length > 0;
    if (hadOverrides) {
      setPositionOverrides({});
      if (userId && !compact) savePositions(userId, {});
      setResetToken((t) => t + 1);
    }

    // Always bump home after other state so the fitter runs on the settled map
    requestDefaultView();
  }, [userId, compact, search, positionOverrides, requestDefaultView]);

  const runRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshProgress({ processed: 0, total: 0 });
    try {
      let offset = 0;
      let done = false;
      while (!done) {
        const result = await refreshConstellationBatch({ offset, limit: 8 });
        setRefreshProgress({
          processed: result.processed,
          total: result.total,
        });
        offset = result.processed;
        done = result.done;
        if (result.graph) {
          lastFetchAt.current = Date.now();
          applyGraphPayload(result.graph, setData, setPositionOverrides);
          setResetToken((t) => t + 1);
        }
        if (result.total === 0) break;
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const cometContacts = useMemo(() => {
    if (!data) return [];
    return data.contacts
      .filter((c) => c.dormant)
      .sort((a, b) => {
        const ta = a.lastInteractionAt
          ? new Date(a.lastInteractionAt).getTime()
          : 0;
        const tb = b.lastInteractionAt
          ? new Date(b.lastInteractionAt).getTime()
          : 0;
        return ta - tb;
      });
  }, [data]);

  if (!data) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl border border-white/10 bg-[#05070c] text-white/50",
          compact ? "h-[300px]" : "h-[min(82vh,780px)]"
        )}
      >
        Loading constellation…
      </div>
    );
  }

  const canvasHeight = compact ? "h-[300px]" : "h-[min(82vh,780px)]";
  const progressPct =
    refreshProgress.total > 0
      ? Math.round((refreshProgress.processed / refreshProgress.total) * 100)
      : 0;

  return (
    <div className={compact ? "space-y-0" : "space-y-0"}>
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-white/10 bg-[#03050a] shadow-[inset_0_0_120px_rgba(0,0,0,0.65)]",
          canvasHeight
        )}
      >
        <Starfield />

        {!compact && (
          <>
            {/* Top left — Clusters */}
            <div className="absolute left-3 top-3 z-20">
              <Popover open={clustersOpen} onOpenChange={setClustersOpen}>
                <PopoverTrigger
                  type="button"
                  className={cn(
                    buttonVariants({ size: "sm" }),
                    "rounded-full border border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md hover:bg-[#0c1018]/90"
                  )}
                >
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  Clusters
                  <span className="ml-1.5 rounded-full bg-white/10 px-1.5 text-[10px]">
                    {data.clusters.length}
                  </span>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="max-h-72 w-64 overflow-y-auto border-white/10 bg-[#0a0e16] p-2 text-white"
                >
                  {data.clusters.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-white/50">
                      No clusters yet
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {data.clusters.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-white/8"
                            onClick={() => {
                              // Clear search without triggering home — we zoom the cluster instead
                              if (search.trim()) {
                                suppressSearchHomeRef.current = true;
                                lastSearchQuery.current = "";
                                setSearch("");
                                setSearchHitIds(new Set());
                              }
                              setPeekPersonId(null);
                              setFocusCluster(c.id);
                              setCompany("all");
                              setZoomToken((t) => t + 1);
                              setClustersOpen(false);
                            }}
                          >
                            <span className="min-w-0 truncate">
                              <span className="mr-1.5 text-[9px] uppercase tracking-wider text-white/35">
                                {c.kind}
                              </span>
                              <span
                                style={{
                                  color: clusterBrandColor(c.name, c.kind),
                                }}
                              >
                                {c.name}
                              </span>
                            </span>
                            <span className="ml-2 shrink-0 text-xs text-white/45">
                              {c.count}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            {/* Top center — search + filters */}
            <div className="absolute left-1/2 top-3 z-20 flex w-[min(92vw,420px)] -translate-x-1/2 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
                <Input
                  value={search}
                  onChange={(e) => {
                    const next = e.target.value;
                    // Clearing the bar should always return to the default map view
                    if (!next.trim() && search.trim()) {
                      suppressSearchHomeRef.current = false;
                    }
                    setSearch(next);
                  }}
                  placeholder="Search name, role, school, keywords…"
                  className="h-9 border-white/15 bg-[#080b12]/80 pl-9 text-white placeholder:text-white/35 backdrop-blur-md"
                />
              </div>
              <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
                <PopoverTrigger
                  type="button"
                  className={cn(
                    buttonVariants({ size: "sm", variant: "outline" }),
                    "h-9 shrink-0 rounded-full border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md"
                  )}
                >
                  <Filter className="h-3.5 w-3.5" />
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-72 space-y-3 border-white/10 bg-[#0a0e16] text-white"
                >
                  <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-white/45">
                      Company
                    </p>
                    <Select
                      value={company}
                      onValueChange={(v) => {
                        setCompany(v || "all");
                        setFocusCluster(null);
                      }}
                    >
                      <SelectTrigger className="w-full border-white/15 bg-white/5 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All companies</SelectItem>
                        {data.companies.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-white/45">
                      School
                    </p>
                    <Select
                      value={school}
                      onValueChange={(v) => setSchool(v || "all")}
                    >
                      <SelectTrigger className="w-full border-white/15 bg-white/5 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All schools</SelectItem>
                        {data.schools.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-white/45">
                      Keyword
                    </p>
                    <Input
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                      placeholder="Tag, note, fact…"
                      className="border-white/15 bg-white/5 text-white"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-white/45">
                      Min strength (orbit)
                    </p>
                    <Select
                      value={minScore}
                      onValueChange={(v) => setMinScore(v || "1")}
                    >
                      <SelectTrigger className="w-full border-white/15 bg-white/5 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1+ Deep space</SelectItem>
                        <SelectItem value="2">2+ Outer orbit</SelectItem>
                        <SelectItem value="3">3+ Mid orbit</SelectItem>
                        <SelectItem value="4">4+ Inner orbit</SelectItem>
                        <SelectItem value="5">5 Core orbit</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {/* Top right — Re-engage + Refresh */}
            <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
              <Popover
                open={reengageOpen}
                onOpenChange={(open) => {
                  setReengageOpen(open);
                  if (!open) {
                    setPeekPersonId(null);
                    setHoveredId(null);
                  }
                }}
              >
                <PopoverTrigger
                  type="button"
                  className={cn(
                    buttonVariants({ size: "sm" }),
                    "rounded-full border border-[#ff6b4a]/35 bg-[#1a0c0a]/85 text-[#ffb4a0] backdrop-blur-md hover:bg-[#2a1210]/90"
                  )}
                >
                  Re-engage
                  {cometContacts.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-[#c4452d]/40 px-1.5 text-[10px]">
                      {cometContacts.length}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="max-h-80 w-72 overflow-y-auto border-white/10 bg-[#0a0e16] p-2 text-white"
                >
                  <p className="mb-2 px-2 text-[11px] uppercase tracking-wide text-white/45">
                    Drifting away
                  </p>
                  {cometContacts.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-white/50">
                      No one is drifting right now
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {cometContacts.map((c) => {
                        const name =
                          (c.preferredName || "").trim() || c.fullName;
                        return (
                          <li key={c.id}>
                            <button
                              type="button"
                              className="flex w-full flex-col rounded-lg px-2.5 py-2 text-left hover:bg-white/8"
                              onMouseEnter={() => {
                                setHoveredId(c.id);
                                setPeekPersonId(c.id);
                                setPeekToken((t) => t + 1);
                              }}
                              onMouseLeave={() => {
                                setHoveredId(null);
                              }}
                              onFocus={() => {
                                setHoveredId(c.id);
                                setPeekPersonId(c.id);
                                setPeekToken((t) => t + 1);
                              }}
                              onBlur={() => {
                                setHoveredId(null);
                              }}
                              onClick={() => {
                                const layoutContact = data.contacts.find(
                                  (x) => x.id === c.id
                                );
                                if (!layoutContact) return;
                                const d: GraphNodeData = {
                                  kind: "contact",
                                  label: name,
                                  fullName: c.fullName,
                                  preferredName: c.preferredName,
                                  initials: name
                                    .split(/\s+/)
                                    .map((p) => p[0])
                                    .join("")
                                    .slice(0, 2)
                                    .toUpperCase(),
                                  company: c.company,
                                  school: c.school,
                                  title: c.title,
                                  score: c.orbitScore ?? c.relationshipScore,
                                  relationshipScore: c.relationshipScore,
                                  closeness: c.closeness,
                                  closenessTier: c.closenessTier,
                                  comet: true,
                                  tags: c.tags,
                                  aiSummary: c.aiSummary,
                                  keyFacts: c.keyFacts || [],
                                  lastInteractionAt: c.lastInteractionAt
                                    ? String(c.lastInteractionAt)
                                    : null,
                                  nextFollowUpAt: c.nextFollowUpAt
                                    ? String(c.nextFollowUpAt)
                                    : null,
                                  email: c.email,
                                  phone: c.phone,
                                  linkedinUrl: c.linkedinUrl,
                                  website: c.website,
                                  howMet: c.howMet,
                                };
                                setSelection({
                                  type: "contact",
                                  id: c.id,
                                  data: d,
                                });
                                setReengageOpen(false);
                              }}
                            >
                              <span className="text-sm text-[#ffb4a0]">
                                {name}
                              </span>
                              <span className="text-[11px] text-white/40">
                                {[c.company, c.title]
                                  .filter(Boolean)
                                  .join(" · ") || "No company"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>

              <Button
                type="button"
                size="sm"
                disabled={refreshing}
                onClick={() => void runRefresh()}
                className="rounded-full border border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md hover:bg-[#0c1018]/90"
              >
                {refreshing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Refresh
              </Button>
            </div>

            {/* Refresh progress */}
            {refreshing && (
              <div className="absolute left-1/2 top-14 z-30 w-[min(90vw,320px)] -translate-x-1/2 rounded-xl border border-white/10 bg-[#080b12]/95 px-3 py-2.5 backdrop-blur-md">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/60">
                  <span>Refreshing constellation…</span>
                  <span>
                    {refreshProgress.processed}/{refreshProgress.total || "…"}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-[#f0d48a] transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Bottom left — Key */}
            <div className="absolute bottom-3 left-3 z-20">
              <Popover open={keyOpen} onOpenChange={setKeyOpen}>
                <PopoverTrigger
                  type="button"
                  className={cn(
                    buttonVariants({ size: "sm" }),
                    "rounded-full border border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md"
                  )}
                >
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                  Key
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  side="top"
                  className="w-64 border-white/10 bg-[#0a0e16] text-white"
                >
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/45">
                    <Info className="h-3 w-3" />
                    Map legend
                  </p>
                  <ul className="space-y-2 text-xs text-white/75">
                    <li className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-[#fff6d6] shadow-[0_0_8px_rgba(255,246,214,0.9)]" />
                      You (the sun)
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]" />
                      Star — a person in your network
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-[#ff9900]">
                        AWS
                      </span>
                      Cluster label — company or school group
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-px w-4 bg-white/70" />
                      Constellation — between related people
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-2 w-4 rounded-full bg-gradient-to-r from-transparent to-[#ff6b4a]" />
                      Red Comet — drifting connection
                    </li>
                  </ul>
                </PopoverContent>
              </Popover>
            </div>

            {/* Bottom right — Home */}
            <div className="absolute bottom-3 right-3 z-20">
              <Button
                type="button"
                size="icon"
                aria-label="Reset map to home"
                title="Reset map"
                onClick={goHome}
                className="h-9 w-9 rounded-full border border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md hover:bg-[#0c1018]/90"
              >
                <Home className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}

        <ReactFlowProvider>
          <GraphCanvas
            data={data}
            company={company}
            school={school}
            keyword={keyword}
            minScore={minScore}
            search={search}
            searchHitIds={searchHitIds}
            focusCluster={focusCluster}
            zoomToken={zoomToken}
            homeToken={homeToken}
            peekPersonId={peekPersonId}
            peekToken={peekToken}
            grouping={grouping}
            labelMode={labelMode}
            linksMode={linksMode}
            motionEnabled={motionEnabled && !compact}
            positionOverrides={positionOverrides}
            onPositionOverridesChange={handlePositionOverridesChange}
            selection={selection}
            hoveredId={hoveredId}
            onSelect={setSelection}
            onHover={setHoveredId}
            resetToken={resetToken}
            compact={compact}
            showEdgeLabels={false}
          />
        </ReactFlowProvider>
      </div>

      {!compact && (
        <ContactInspectPanel
          selection={selection}
          onClose={() => setSelection(null)}
          onContactPatch={(id, patch) => {
            if (patch.aiSummary !== undefined) {
              setData((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  contacts: prev.contacts.map((c) =>
                    c.id === id ? { ...c, aiSummary: patch.aiSummary ?? null } : c
                  ),
                };
              });
            }
            setSelection((prev) => {
              if (!prev || prev.type !== "contact" || prev.id !== id) {
                return prev;
              }
              return {
                ...prev,
                data: { ...prev.data, ...patch },
              };
            });
          }}
        />
      )}
    </div>
  );
}
