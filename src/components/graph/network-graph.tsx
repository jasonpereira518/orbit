"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getFullGraphData,
  getGraphData,
  refreshConstellationBatch,
} from "@/actions/graph";
import { toast } from "sonner";
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
  ContactInspectPanel,
  type InspectSelection,
} from "@/components/graph/contact-inspect-panel";
import type { GraphNodeData } from "@/lib/graph-layout";
import { Starfield } from "@/components/graph/constellation-starfield";
import { useSmallSky } from "@/components/graph/use-small-sky";
import {
  buildContactHaystackIndex,
  findClusterMatch,
  matchGraphContacts,
} from "@/lib/graph/search-match";
import {
  loadPositions,
  savePositions,
} from "@/lib/graph/positions-storage";
import {
  mergePositionsForStorage,
  prunePositionsForRender,
} from "@/lib/graph-positions";
import {
  getIntroRun,
  markGraphChunkLoaded,
  subscribe as subscribeIntro,
} from "@/lib/graph/intro-signal";
import {
  STAGE_CHART_LAYER,
  STAGE_GROUND,
} from "@/lib/graph/stage-layers";
import {
  publishGraphScope,
  registerGraphScopeController,
} from "@/lib/graph/scope-signal";
import { clusterBrandColor } from "@/lib/school-color";
import { cn } from "@/lib/utils";
import {
  dismissBackgroundJob,
  finishBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";
import {
  Filter,
  Home,
  Info,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;
/**
 * Module scope, deliberately — not an effect.
 *
 * This file is a lazily-imported chunk, and whether it has EVALUATED is the only honest answer
 * to "did this document already pay for the graph bundle". The intro asks that question before
 * the chunk request can even start, to decide whether the coming wait is worth covering.
 */
markGraphChunkLoaded();

/**
 * The two renderers, each in its own chunk.
 *
 * Only the branch that renders is ever requested, which is the whole point: a phone must
 * not download, parse, or mount `@xyflow/react` and the per-contact DOM nodes that come
 * with it. See `use-small-sky.ts` for which device gets which.
 */
const GraphCanvasFlow = dynamic(
  () =>
    import("@/components/graph/graph-canvas-flow").then((m) => ({
      default: m.GraphCanvasFlow,
    })),
  { ssr: false, loading: () => null }
);

const GraphCanvasMobile = dynamic(
  () =>
    import("@/components/graph/graph-canvas-mobile").then((m) => ({
      default: m.GraphCanvasMobile,
    })),
  { ssr: false, loading: () => null }
);

type PositionMap = import("@/lib/graph-positions").PositionMap;

function introInFlight() {
  const status = getIntroRun().status;
  return status === "running" || status === "arriving";
}

const GRAPH_REFETCH_MIN_MS = 60_000;

/**
 * No write-back here, deliberately.
 *
 * This used to persist the pruned map whenever its size differed from what was stored, to
 * garbage-collect positions for deleted contacts. But a payload is narrower than the network
 * for several reasons that have nothing to do with deletion — the dashboard preview caps at
 * `GRAPH_PREVIEW_CONTACT_CAP`, and the constellation filter narrows it further — and this
 * runs on every refetch, which fires on window focus. So the cleanup quietly deleted the
 * saved position of every contact the current view left out. A few hundred stale `{x,y}`
 * entries cost nothing; a user's lost layout is not recoverable.
 */
function applyGraphPayload(
  payload: GraphPayload,
  setData: (payload: GraphPayload) => void,
  setPositionOverrides: (next: PositionMap) => void
) {
  setData(payload);
  setPositionOverrides(positionsFromPayload(payload));
}

function positionsFromPayload(payload: GraphPayload): PositionMap {
  return prunePositionsForRender(
    loadPositions(payload.userId),
    payload.contacts.map((c) => c.id)
  );
}

export function NetworkGraph({
  initialData = null,
  compact = false,
}: {
  initialData?: GraphPayload | null;
  compact?: boolean;
}) {
  /**
   * Which renderer draws the sky.
   *
   * Safe during render because this component is only ever reached through
   * `next/dynamic({ ssr: false })`, so the first render already happens in the browser
   * and the answer is right on frame one — no flash, no double mount. The dashboard
   * preview takes the same branch: a 300px sky on a phone is where the DOM chart's cost
   * is least justified.
   */
  const smallSky = useSmallSky();
  const Chart = smallSky ? GraphCanvasMobile : GraphCanvasFlow;

  const [data, setData] = useState<GraphPayload | null>(initialData);
  const [company, setCompany] = useState("all");
  const [school, setSchool] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [minScore, setMinScore] = useState("1");
  const [search, setSearch] = useState("");
  /**
   * The viewer's own override of the constellation filter, for this session.
   *
   * A chart that removes most of somebody's network without saying so is indistinguishable
   * from data loss, so the control that announces it also has to be able to undo it.
   * Deliberately not persisted: engaged-only is the product's default and every visit starts
   * there.
   *
   * The wider set is FETCHED, not merely unhidden — the default payload does not carry the
   * people it isn't drawing — and it is DROPPED again the moment the view leaves it, so the
   * engaged-only default costs engaged-only memory. See `setScope`.
   */
  const [showAllStars, setShowAllStars] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  // `loadData` is memoised with no deps and must not resubscribe on every toggle, so it reads
  // the current scope through a ref rather than closing over the state.
  const showAllStarsRef = useRef(false);
  /**
   * The payload for each scope. `engaged` is kept — it is the default view, and the one a
   * refresh writes back into. `all` is only ever populated while it is the view on screen;
   * `setScope` nulls it on the way out so the full network is not something this component
   * carries around between visits to it.
   */
  const scopeCache = useRef<{
    engaged: GraphPayload | null;
    all: GraphPayload | null;
  }>({ engaged: initialData, all: null });
  const [searchHitIds, setSearchHitIds] = useState<Set<string>>(new Set());
  const [focusCluster, setFocusCluster] = useState<string | null>(null);
  const [zoomToken, setZoomToken] = useState(0);
  // Start at 1 so the map opens on the default full-map view (not RF's zoom-1 origin)
  const [homeToken, setHomeToken] = useState(1);
  const [peekPersonId, setPeekPersonId] = useState<string | null>(null);
  const [peekToken, setPeekToken] = useState(0);
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  /**
   * Whether the warp intro is on screen behind this chart.
   *
   * A boolean off the same module-scope bus the intro runs on, so this re-renders exactly
   * twice a visit — once when a run starts and once when it ends — and never at all on the
   * fast path, where no run is ever started. `useSyncExternalStore` rather than an effect
   * because the answer is already known at first render: an intro begun before the chunk
   * landed is in flight by the time this mounts, and a frame of opaque ground over it would
   * be the flash this whole arrangement exists to avoid.
   */
  const introBehind = useSyncExternalStore(
    subscribeIntro,
    introInFlight,
    introInFlight
  );
  // Set from an effect rather than during render: `Date.now()` in the render body is an
  // impurity the compiler-era lint (rightly) flags, and "when did we last fetch" is a fact
  // about the commit, not the render.
  const lastFetchAt = useRef(0);
  useEffect(() => {
    if (initialData) lastFetchAt.current = Date.now();
  }, [initialData]);
  const positionsHydrated = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const operationsStoppedRef = useRef(false);
  const refreshJobIdRef = useRef<string | null>(null);

  const fullscreenActive = isFullscreen || cssFullscreen;
  const showIntroBehind = introBehind && !compact && !fullscreenActive;

  // ⌘/Ctrl+F → constellation search (instead of browser find)
  useEffect(() => {
    if (compact) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact]);

  useEffect(() => {
    if (compact) return;
    function syncFullscreen() {
      setIsFullscreen(document.fullscreenElement === stageRef.current);
    }
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [compact]);

  useEffect(() => {
    if (!cssFullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCssFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cssFullscreen]);

  useEffect(() => {
    if (compact) return;

    const stopAll = () => {
      operationsStoppedRef.current = true;
      setRefreshing(false);
      setRefreshProgress({ processed: 0, total: 0 });
      if (refreshJobIdRef.current) {
        dismissBackgroundJob(refreshJobIdRef.current);
        refreshJobIdRef.current = null;
      }
    };

    window.addEventListener("orbit:stop-operations", stopAll);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "orbit:stop-operations") return;
      stopAll();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("orbit:stop-operations", stopAll);
      window.removeEventListener("storage", onStorage);
    };
  }, [compact]);

  const loadData = useCallback((force = false) => {
    if (operationsStoppedRef.current) return;
    if (!force && Date.now() - lastFetchAt.current < GRAPH_REFETCH_MIN_MS) {
      return;
    }
    getGraphData()
      .then((payload) => {
        lastFetchAt.current = Date.now();
        scopeCache.current.engaged = payload;
        // The wider set is now stale too, but re-fetching it here would defeat the point of
        // not loading it — drop it and let the next "show all" pay for a fresh one.
        scopeCache.current.all = null;
        if (!showAllStarsRef.current) {
          applyGraphPayload(payload, setData, setPositionOverrides);
        }
      })
      .catch(console.error);
  }, []);

  /**
   * Switch between the people you know and everyone.
   *
   * The wider payload is fetched on demand and cached for the session; going back is free.
   * A failure leaves the toggle where it was rather than showing a half-empty chart.
   */
  const setScope = useCallback((wantAll: boolean) => {
    if (!wantAll) {
      // Drop the full network on the way out, rather than keeping it for a cheap trip back.
      //
      // That trip back was the point of caching it, and it is being given up deliberately: the
      // whole feature exists so a chart of everyone is not something the app is carrying around,
      // and a cache that outlives the view is exactly that — the payload is the largest thing
      // this component ever holds, and holding it means every render, refresh and layout pass
      // is working beside a copy of a network nobody is looking at. Nulling it here is what
      // makes the engaged-only default cost engaged-only memory. Going back to everyone is a
      // fresh fetch, which is the price and a fair one at the rate anybody toggles this.
      scopeCache.current.all = null;
      const engaged = scopeCache.current.engaged;
      if (!engaged) return;
      showAllStarsRef.current = false;
      setShowAllStars(false);
      applyGraphPayload(engaged, setData, setPositionOverrides);
      return;
    }
    // Only non-null when this is already the view — asking for the scope you are on is a no-op
    // rather than a second fetch.
    const cached = scopeCache.current.all;
    if (cached) {
      showAllStarsRef.current = true;
      setShowAllStars(true);
      applyGraphPayload(cached, setData, setPositionOverrides);
      return;
    }
    setLoadingAll(true);
    getFullGraphData()
      .then((payload) => {
        scopeCache.current.all = payload;
        showAllStarsRef.current = true;
        setShowAllStars(true);
        applyGraphPayload(payload, setData, setPositionOverrides);
      })
      .catch((err) => {
        console.error(err);
        toast.error("Could not load the rest of your network.");
      })
      .finally(() => setLoadingAll(false));
  }, []);

  /**
   * Hand the scope control to the header toggle, which lives outside this tree.
   *
   * `NetworkGraph` stays the only thing that fetches or caches — the button just asks. The
   * compact dashboard preview deliberately opts out: it renders this same component with no
   * header above it, and letting it drive the bus would point the toggle at the wrong chart.
   */
  useEffect(() => {
    if (compact) return;
    return registerGraphScopeController((next) => setScope(next === "all"));
  }, [compact, setScope]);

  useEffect(() => {
    if (compact) return;
    const filter = data?.summary.constellationFilter;
    publishGraphScope({
      // Keyed on `enabled`, not `active`: in the "show all" view `active` is false by
      // definition, and dropping the control there would strand the viewer with no way back.
      available: Boolean(filter?.enabled),
      scope: showAllStars ? "all" : "engaged",
      loading: loadingAll,
      // `engaged`, not `shown` — `shown` means "what this payload draws", which in the wider
      // scope is everyone. The toggle needs the count it would go back to.
      shown: filter?.engaged ?? 0,
      total: data?.summary.total ?? 0,
    });
  }, [compact, data, showAllStars, loadingAll]);

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
  // Built once per data load instead of re-joined per contact on every
  // keystroke inside matchGraphContacts.
  const contactHaystackIndex = useMemo(
    () => (data ? buildContactHaystackIndex(data.contacts) : new Map<string, string>()),
    [data]
  );

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
    // `reframe` moves the camera; semantic enrichment only updates highlights
    // so finishing a word doesn't yank the view back out to the full map.
    const localMatch = matchGraphContacts(data.contacts, q, contactHaystackIndex);
    const applySearchResults = (
      extraIds: string[] = [],
      reframe = true
    ) => {
      const personIds = new Set<string>([...localMatch.ids, ...extraIds]);
      const clusterByName = findClusterMatch(data.clusters, q);
      const qNorm = q.toLowerCase();
      const isExactClusterName =
        Boolean(clusterByName) &&
        clusterByName!.name.toLowerCase() === qNorm;

      // Searching a cluster name → highlight everyone in it
      if (isExactClusterName && clusterByName) {
        setSearchHitIds(new Set(clusterByName.contactIds));
        if (reframe) {
          setFocusCluster(clusterByName.id);
          setZoomToken((t) => t + 1);
        }
        return;
      }

      // Cluster name with no person hits (partial cluster match)
      if (clusterByName && personIds.size === 0) {
        setSearchHitIds(new Set(clusterByName.contactIds));
        if (reframe) {
          setFocusCluster(clusterByName.id);
          setZoomToken((t) => t + 1);
        }
        return;
      }

      // Person / keyword search — highlight matched people
      setSearchHitIds(personIds);

      if (!reframe) return;

      // Frame the matches themselves: every hit in view, or a single hit up
      // close. No hits — keep the current camera; don't snap home mid-typing.
      setFocusCluster(null);
      if (personIds.size === 0) return;
      setZoomToken((t) => t + 1);
    };

    applySearchResults([], true);

    // Enrich with semantic hits (debounced) without reframing the camera.
    // A name match is already the answer — enriching it would widen the hit
    // set and kill the solo spotlight mid-hover, so skip it entirely.
    if (!localMatch.nameTier) {
      searchTimer.current = setTimeout(() => {
        const req = ++searchRequestId.current;
        searchDashboardContacts(q, { limit: 40 })
          .then((hits) => {
            if (req !== searchRequestId.current) return;
            if (lastSearchQuery.current !== q) return;
            applySearchResults(
              hits.map((h) => h.id),
              false
            );
          })
          .catch(() => {
            /* local results already applied */
          });
      }, 280);
    }

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, data, compact, requestDefaultView, contactHaystackIndex]);

  const userId = data?.userId;

  const handlePositionOverridesChange = useCallback(
    (next: PositionMap) => {
      setPositionOverrides(next);
      // Merge, don't replace: `next` is the render map, so it only mentions contacts this
      // view can draw. Writing it straight would drop the saved position of everyone the
      // current payload left out — one drag would flatten the rest of the network's layout.
      if (userId && !compact) {
        savePositions(userId, mergePositionsForStorage(loadPositions(userId), next));
      }
    },
    [userId, compact]
  );

  const focusClusterById = useCallback(
    (clusterId: string) => {
      if (search.trim()) {
        suppressSearchHomeRef.current = true;
        lastSearchQuery.current = "";
        setSearch("");
        setSearchHitIds(new Set());
      }
      setPeekPersonId(null);
      setHoveredId(null);
      setSelection(null);
      setCompany("all");
      setFocusCluster(clusterId);
      setZoomToken((t) => t + 1);
    },
    [search]
  );

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;

    if (document.fullscreenElement === el) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.error("Exit fullscreen failed", err);
      }
      return;
    }

    if (cssFullscreen) {
      setCssFullscreen(false);
      return;
    }

    if (typeof el.requestFullscreen === "function") {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        // Fall through to CSS fullscreen (e.g. iOS Safari)
      }
    }

    setCssFullscreen(true);
  }, [cssFullscreen]);

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

    /**
     * Home undoes a hand-arranged sky — but only on the renderer that can arrange one.
     *
     * The canvas has no drag: a two-pixel star is not something a finger can place, so
     * the phone reads stored positions and never writes them. Clearing them here would
     * make an innocuous Home tap permanently delete a layout the user built on a laptop,
     * from the one device that cannot rebuild it. So on the canvas, Home resets the
     * camera and the filters and leaves storage alone.
     */
    const hadOverrides = Object.keys(positionOverrides).length > 0;
    if (hadOverrides && !smallSky) {
      setPositionOverrides({});
      if (userId && !compact) savePositions(userId, {});
      setResetToken((t) => t + 1);
    }

    // Always bump home after other state so the fitter runs on the settled map
    requestDefaultView();
  }, [userId, compact, smallSky, search, positionOverrides, requestDefaultView]);

  const runRefresh = useCallback(async () => {
    if (refreshing) return;
    if (operationsStoppedRef.current) return;
    setRefreshing(true);
    setRefreshProgress({ processed: 0, total: 0 });
    const jobId = `graph-refresh-${Date.now()}`;
    refreshJobIdRef.current = jobId;
    startBackgroundJob({
      id: jobId,
      kind: "graph-refresh",
      label: "Refreshing constellation",
      done: 0,
      total: 0,
      startedAt: Date.now(),
    });
    try {
      let offset = 0;
      let done = false;
      while (!done) {
        if (operationsStoppedRef.current) return;
        const result = await refreshConstellationBatch({ offset, limit: 8 });
        setRefreshProgress({
          processed: result.processed,
          total: result.total,
        });
        updateBackgroundJob(jobId, {
          done: result.processed,
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
      finishBackgroundJob(jobId, {
        status: "completed",
        resultMessage: "Constellation refreshed",
      });
    } catch (err) {
      console.error(err);
      finishBackgroundJob(jobId, {
        status: "failed",
        error: "Constellation refresh failed",
      });
    } finally {
      refreshJobIdRef.current = null;
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

  const constellationFilter = data?.summary.constellationFilter;
  // The payload already contains only what should be drawn, so the client no longer filters
  // by `substantive` — this stays only so the empty state can explain WHY a sky is empty.
  const constellationFilterOn = Boolean(constellationFilter?.active);

  if (!data) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl border border-white/10 bg-[#05070c] text-white/50",
          compact
            ? "h-[300px]"
            : "h-[calc(100dvh-19.5rem)] md:h-[calc(100dvh-10.5rem)]"
        )}
      >
        Loading constellation…
      </div>
    );
  }

  const progressPct =
    refreshProgress.total > 0
      ? Math.round((refreshProgress.processed / refreshProgress.total) * 100)
      : 0;

  return (
    <div className={compact ? "space-y-0" : "min-h-0 w-full"}>
      <div
        ref={stageRef}
        className={cn(
          "relative overflow-hidden border border-white/10 shadow-[inset_0_0_120px_rgba(0,0,0,0.65)]",
          // Transparent only while the intro is behind it, and never in the dashboard's
          // preview or in fullscreen — both are cases where there is nothing behind to show
          // and a see-through stage would just be the page bleeding into the sky.
          // `STAGE_CHART_LAYER` also gives the stage a stacking context, so its own toolbars
          // ride above the intro with it instead of competing against it one by one.
          showIntroBehind ? `bg-transparent ${STAGE_CHART_LAYER}` : STAGE_GROUND,
          compact
            ? "h-[300px] rounded-2xl"
            : // 19.5rem, not 15rem: below md the app's floating bottom nav is a fixed pill
            // ~5rem tall, and the old height ran the canvas (and its Key / full-screen /
            // home buttons) underneath it, where they could not be tapped at all.
            "h-[calc(100dvh-19.5rem)] max-h-[calc(100dvh-19.5rem)] rounded-2xl md:h-[calc(100dvh-10.5rem)] md:max-h-[calc(100dvh-10.5rem)]",
          fullscreenActive &&
            "rounded-none border-0 !h-dvh !max-h-none",
          cssFullscreen && "!fixed inset-0 z-[100] w-screen"
        )}
      >
        {!smallSky && <Starfield />}

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
            {/* Second row below md: at 375px the 92vw search box ran straight through the
                Clusters chip on the left and Re-engage / Refresh on the right, so all
                three were unreadable and partly untappable. */}
            <div className="absolute left-1/2 top-14 z-20 flex w-[min(92%,420px)] -translate-x-1/2 items-center gap-2 lg:top-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
                <Input
                  ref={searchInputRef}
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
                  <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 sm:mr-1.5" />
                )}
                {/* Icon-only below sm: with the label, this row's three pills were
                    14px wider than a 375px canvas and Re-engage sat on top of Clusters. */}
                <span className="hidden lg:inline">Refresh</span>
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
                    className="h-full rounded-full bg-[#f0d48a] transition-[width] duration-slow ease-house"
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
                      Star — a person in your network (bigger = closer tie)
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-[#ff9900]">
                        AWS
                      </span>
                      Cluster label — company or school group
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-3 w-5 bg-[conic-gradient(from_10deg,transparent_0deg,rgba(255,153,0,0.4)_18deg,transparent_36deg,rgba(255,153,0,0.28)_90deg,transparent_130deg,rgba(255,153,0,0.36)_210deg,transparent_260deg,rgba(255,153,0,0.24)_320deg,transparent_360deg)] blur-[1.5px]" />
                      Supernova haze — brand color behind a cluster
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-px w-4 bg-white/70" />
                      Constellation — bright stars trace a cluster&apos;s
                      figure; fainter ones are the rest of the group
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-2 w-4 rounded-full bg-gradient-to-r from-transparent to-[#ff6b4a]" />
                      Red Comet — drifting connection
                    </li>
                  </ul>
                </PopoverContent>
              </Popover>
            </div>

            {/* Bottom right — Fullscreen + Home */}
            <div className="absolute bottom-3 right-3 z-20 flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                aria-label={
                  fullscreenActive ? "Exit full screen" : "Open full screen"
                }
                title={fullscreenActive ? "Exit full screen" : "Full screen"}
                onClick={() => void toggleFullscreen()}
                className="h-9 w-9 rounded-full border border-white/15 bg-[#080b12]/80 text-white backdrop-blur-md hover:bg-[#0c1018]/90"
              >
                {fullscreenActive ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
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

        <Chart
          data={data}
          constellationFilterOn={constellationFilterOn}
          onShowAll={() => setScope(true)}
          loadingAll={loadingAll}
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
          positionOverrides={positionOverrides}
          onPositionOverridesChange={handlePositionOverridesChange}
          selection={selection}
          hoveredId={hoveredId}
          onSelect={setSelection}
          onHover={setHoveredId}
          onFocusCluster={focusClusterById}
          resetToken={resetToken}
          compact={compact}
        />
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
