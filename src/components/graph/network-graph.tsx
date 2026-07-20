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
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getGraphData } from "@/actions/graph";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ClusterLabelNode,
  ContactNode,
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
  type OrbitRingsData,
} from "@/lib/graph-layout";
import { cn } from "@/lib/utils";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;
type LabelMode = "always" | "hover" | "never";
type LinksMode = "on" | "auto" | "off";
type PositionMap = Record<string, { x: number; y: number }>;

const nodeTypes = {
  contact: ContactNode,
  user: SunNode,
  orbitRings: OrbitRingsNode,
  clusterLabel: ClusterLabelNode,
};

const HIGH_NODE_THRESHOLD = 80;
const ORBIT_DEG_PER_SEC = 2.2;

function positionsStorageKey(userId: string) {
  return `orbit-graph-positions:${userId}`;
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

function contactMatchesSearch(d: GraphNodeData, q: string): boolean {
  if (!q) return true;
  const hay = [
    d.label,
    d.fullName,
    d.preferredName,
    d.company,
    d.title,
    ...(d.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
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

function GraphLegend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-xl border border-white/10 bg-[#080b12]/75 px-3 py-2.5 text-[10px] text-white/70 backdrop-blur-sm">
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#fff6d6] shadow-[0_0_6px_rgba(255,246,214,0.8)]" />
          You
        </li>
        <li className="flex items-center gap-2">
          <span className="h-px w-4 border-t border-dashed border-white/40" />
          Closeness ring
        </li>
        <li className="flex items-center gap-2">
          <span className="h-px w-4 bg-white/75" />
          Company constellation
        </li>
        <li className="flex items-center gap-2">
          <span className="h-px w-4 bg-[rgba(255,236,200,0.85)]" />
          Knows (met / mentioned)
        </li>
      </ul>
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
          showLabels: true,
          motionEnabled: motionEnabled && !prefersReducedMotion,
        },
      } as Node;
    }
    if (n.type === "user" || n.type === "clusterLabel") {
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
  tag: string;
  minScore: string;
  search: string;
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
}) {
  const filteredContacts = useMemo(() => {
    return props.data.contacts.filter((c) => {
      if (props.company !== "all" && c.company !== props.company) return false;
      if (props.tag !== "all" && !c.tags.includes(props.tag)) return false;
      if ((c.relationshipScore || 0) < Number(props.minScore)) return false;
      return true;
    });
  }, [props.data.contacts, props.company, props.tag, props.minScore]);

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
      props.tag,
      props.minScore,
      props.resetToken,
      ids,
    ].join("|");
  }, [
    filteredContacts,
    props.grouping,
    props.company,
    props.tag,
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
  tag,
  minScore,
  search,
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
}: {
  company: string;
  tag: string;
  minScore: string;
  search: string;
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
}) {
  const router = useRouter();
  const { fitView } = useReactFlow();
  const draggingId = useRef<string | null>(null);
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
    if (company !== "all") return company;
    if (hoveredId && hoveredId !== "me") {
      const node = layout.nodes.find((n) => n.id === hoveredId);
      const d = node?.data as GraphNodeData | undefined;
      return d?.company || null;
    }
    if (selection?.type === "contact") {
      return selection.data.company || null;
    }
    return null;
  }, [company, hoveredId, selection, layout.nodes]);

  const searchQuery = search.trim().toLowerCase();

  const nodes = useMemo(() => {
    return orbitNodes.map((n) => {
      if (n.type === "orbitRings") {
        const rings = n.data as OrbitRingsData;
        return {
          ...n,
          data: {
            ...rings,
            showLabels: true,
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
      if (n.type === "clusterLabel") {
        return n as Node;
      }

      const d = n.data as GraphNodeData;
      const isHovered = hoveredId === n.id;
      const isSelected = selection?.type === "contact" && selection.id === n.id;
      const matchesSearch = contactMatchesSearch(d, searchQuery);
      const spotlight = Boolean(searchQuery && matchesSearch);
      const dimFromSearch = Boolean(searchQuery && !matchesSearch);
      const dimFromFocus =
        Boolean(hoveredId || selection?.type === "contact") &&
        !isHovered &&
        !isSelected;
      const dim = dimFromSearch || dimFromFocus;
      const hasOverride = Boolean(positionOverrides[n.id]);

      return {
        ...n,
        selected: isSelected,
        data: {
          ...d,
          labelMode,
          motionEnabled,
          motionPaused: isHovered || isSelected || hasOverride,
          spotlight,
        },
        style: {
          opacity: dim ? 0.18 : 1,
          transition: "opacity 200ms ease",
        },
      } as Node;
    });
  }, [
    orbitNodes,
    hoveredId,
    selection,
    searchQuery,
    labelMode,
    motionEnabled,
    prefersReducedMotion,
    positionOverrides,
  ]);

  const edges = useMemo(() => {
    const contactCount = filteredContacts.length;
    const showPeerLinks =
      linksMode === "on" ||
      (linksMode === "auto" &&
        (contactCount < HIGH_NODE_THRESHOLD || Boolean(focusCompany)));

    return layout.edges
      .filter((e) => {
        const kind = e.data?.kind;
        if (kind === "solar") return true;
        if (kind !== "constellation" && kind !== "knows") return true;
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
          const sourceCo = (
            layout.nodes.find((n) => n.id === e.source)?.data as GraphNodeData
          )?.company;
          const targetCo = (
            layout.nodes.find((n) => n.id === e.target)?.data as GraphNodeData
          )?.company;
          return sourceCo === focusCompany || targetCo === focusCompany;
        }
        if (linksMode === "auto" && contactCount >= HIGH_NODE_THRESHOLD) {
          return false;
        }
        return true;
      })
      .map((e) => {
        const isSolar = e.data?.kind === "solar";
        const relatedToHover =
          hoveredId &&
          (e.source === hoveredId ||
            e.target === hoveredId ||
            (isSolar && e.target === hoveredId));

        const relatedToSelection =
          selection?.type === "contact" &&
          (e.source === selection.id || e.target === selection.id);

        const dimOthers = Boolean(hoveredId || selection?.type === "contact");
        const emphasized = relatedToHover || relatedToSelection;

        let opacity = Number(e.style?.opacity ?? 0.5);
        if (searchQuery) {
          const targetData = layout.nodes.find((n) => n.id === e.target)
            ?.data as GraphNodeData | undefined;
          const sourceData = layout.nodes.find((n) => n.id === e.source)
            ?.data as GraphNodeData | undefined;
          const targetOk =
            e.target === "me" ||
            (targetData && contactMatchesSearch(targetData, searchQuery));
          const sourceOk =
            e.source === "me" ||
            (sourceData && contactMatchesSearch(sourceData, searchQuery));
          if (isSolar && !targetOk) opacity = 0.05;
          if (!isSolar && !(sourceOk && targetOk)) opacity = 0.05;
        }
        if (dimOthers && !emphasized) {
          opacity = Math.min(opacity, 0.08);
        } else if (emphasized) {
          opacity = Math.min(1, opacity + 0.35);
        }

        return {
          ...e,
          type: "straight" as const,
          animated: false,
          style: {
            ...e.style,
            opacity,
            strokeWidth: emphasized
              ? Number(e.style?.strokeWidth ?? 1) + 0.6
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

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (searchQuery) {
        const matchIds = nodes
          .filter((n) => {
            if (n.type !== "contact") return false;
            return contactMatchesSearch(n.data as GraphNodeData, searchQuery);
          })
          .map((n) => n.id);
        if (matchIds.length > 0) {
          fitView({
            nodes: matchIds.map((nid) => ({ id: nid })),
            padding: 0.35,
            duration: 400,
          });
          return;
        }
      }
      fitView({ padding: 0.22, duration: 320 });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on filter/search, not every orbit tick
  }, [fitView, company, tag, minScore, searchQuery, grouping, filteredContacts.length]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.id === "rings" || node.type === "clusterLabel") return;
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
        const companySet = new Set<string>();
        for (const c of filteredContacts) {
          const s = Math.min(5, Math.max(1, c.relationshipScore || 2));
          scoreCounts[s] = (scoreCounts[s] || 0) + 1;
          if (c.company) companySet.add(c.company);
        }
        onSelect({
          type: "user",
          data: d,
          summary: {
            total: filteredContacts.length,
            companyCount: companySet.size,
            scoreCounts,
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
    [onSelect, filteredContacts, compact, router]
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback(
    (_, node) => {
      if (
        node.id === "rings" ||
        node.id === "me" ||
        node.type === "clusterLabel"
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
        fitView
        nodeOrigin={[0.5, 0.5]}
        minZoom={0.2}
        maxZoom={2.2}
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
        <Background
          gap={48}
          color="rgba(255, 255, 255, 0.03)"
          size={1}
          style={{ background: "transparent" }}
        />
        {!compact && <Controls showInteractive={false} />}
        {!compact && (
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            if (n.id === "me") return "#fff6d6";
            if (n.type === "orbitRings" || n.type === "clusterLabel") {
              return "transparent";
            }
            const score = (n.data as GraphNodeData)?.score || 2;
            if (score >= 4) return "#ffffff";
            return "#9aa8b8";
          }}
          maskColor="rgba(0, 0, 0, 0.72)"
          className="!border !border-white/10 !bg-[#05070c]/90"
        />
        )}
      </ReactFlow>

      {!compact && <GraphLegend />}

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
  const ids = new Set(payload.contacts.map((c) => c.id));
  const loaded = loadPositions(payload.userId);
  const cleaned: PositionMap = {};
  for (const [id, pos] of Object.entries(loaded)) {
    if (ids.has(id)) cleaned[id] = pos;
  }
  setPositionOverrides(cleaned);
  if (Object.keys(cleaned).length !== Object.keys(loaded).length) {
    savePositions(payload.userId, cleaned);
  }
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
  const [tag, setTag] = useState("all");
  const [minScore, setMinScore] = useState("1");
  const [search, setSearch] = useState("");
  const [grouping, setGrouping] = useState<GroupingMode>("score");
  const [labelMode, setLabelMode] = useState<LabelMode>("hover");
  const [linksMode, setLinksMode] = useState<LinksMode>("auto");
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [positionOverrides, setPositionOverrides] = useState<PositionMap>({});
  const [resetToken, setResetToken] = useState(0);
  const [selection, setSelection] = useState<InspectSelection>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const lastFetchAt = useRef(initialData ? Date.now() : 0);
  const positionsHydrated = useRef(false);

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
    const onFocus = () => loadData(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") loadData(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadData, compact]);

  const userId = data?.userId;

  const handlePositionOverridesChange = useCallback(
    (next: PositionMap) => {
      setPositionOverrides(next);
      if (userId && !compact) savePositions(userId, next);
    },
    [userId, compact]
  );

  const resetPositions = useCallback(() => {
    setPositionOverrides({});
    if (userId) {
      try {
        localStorage.removeItem(positionsStorageKey(userId));
      } catch {
        // ignore
      }
    }
    setResetToken((t) => t + 1);
  }, [userId]);

  const activeFilterCount =
    (company !== "all" ? 1 : 0) +
    (tag !== "all" ? 1 : 0) +
    (minScore !== "1" ? 1 : 0);

  if (!data) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl border border-white/10 bg-[#05070c] text-white/50",
          compact ? "h-[300px]" : "h-[min(78vh,720px)]"
        )}
      >
        Loading constellation…
      </div>
    );
  }

  const canvasHeight = compact ? "h-[300px]" : "h-[min(78vh,720px)]";

  return (
    <div className={compact ? "space-y-0" : "space-y-3"}>
      {!compact && (
        <>
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-primary/15 bg-primary/[0.04] p-4 backdrop-blur-sm">
        <div className="min-w-[200px] flex-1 space-y-1.5">
          <Label htmlFor="graph-search" className="text-primary">
            Search spotlight
          </Label>
          <Input
            id="graph-search"
            placeholder="Name, company, tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-card/90"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
              {activeFilterCount}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              filtersOpen && "rotate-180"
            )}
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          Advanced
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              advancedOpen && "rotate-180"
            )}
          />
        </Button>
      </div>

      {filtersOpen && (
        <div className="grid gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select value={company} onValueChange={(v) => setCompany(v || "all")}>
              <SelectTrigger className="w-full">
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
            <Label>Tag</Label>
            <Select value={tag} onValueChange={(v) => setTag(v || "all")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tags</SelectItem>
                {data.tags.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Min closeness</Label>
            <Select
              value={minScore}
              onValueChange={(v) => setMinScore(v || "1")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1+</SelectItem>
                <SelectItem value="2">2+</SelectItem>
                <SelectItem value="3">3+</SelectItem>
                <SelectItem value="4">4+</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {advancedOpen && (
        <div className="grid gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Orbit grouping</Label>
            <Select
              value={grouping}
              onValueChange={(v) => setGrouping((v as GroupingMode) || "score")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score">Score rings</SelectItem>
                <SelectItem value="company">Company clusters</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Labels</Label>
            <Select
              value={labelMode}
              onValueChange={(v) => setLabelMode((v as LabelMode) || "hover")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hover">Dim until hover</SelectItem>
                <SelectItem value="always">Always bright</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Connection lines</Label>
            <Select
              value={linksMode}
              onValueChange={(v) => setLinksMode((v as LinksMode) || "auto")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="on">Always on</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              type="button"
              variant={motionEnabled ? "default" : "outline"}
              size="sm"
              className={cn(
                motionEnabled &&
                  "bg-primary text-primary-foreground hover:bg-primary/90"
              )}
              onClick={() => setMotionEnabled((m) => !m)}
            >
              Orbit motion {motionEnabled ? "on" : "off"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetPositions}
            >
              Reset positions
            </Button>
          </div>
        </div>
      )}
        </>
      )}

      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-white/10 bg-[#03050a] shadow-[inset_0_0_120px_rgba(0,0,0,0.65)]",
          canvasHeight
        )}
      >
        <Starfield />
        <ReactFlowProvider>
          <GraphCanvas
            data={data}
            company={company}
            tag={tag}
            minScore={minScore}
            search={search}
            grouping={grouping}
            labelMode={labelMode}
            linksMode={linksMode}
            motionEnabled={motionEnabled}
            positionOverrides={positionOverrides}
            onPositionOverridesChange={handlePositionOverridesChange}
            selection={selection}
            hoveredId={hoveredId}
            onSelect={setSelection}
            onHover={setHoveredId}
            resetToken={resetToken}
            compact={compact}
          />
        </ReactFlowProvider>
      </div>

      {!compact && (
      <ContactInspectPanel
        selection={selection}
        onClose={() => setSelection(null)}
      />
      )}
    </div>
  );
}
